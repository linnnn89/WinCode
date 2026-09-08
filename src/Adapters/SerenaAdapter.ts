import { type OperationContext, checkOperation, rethrowOperationError } from '../Core/OperationContext.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { IAdapter, AdapterHealth, AdapterLastError, UpstreamConnectionStatus } from './IAdapter.js';
import { WINCODE_VERSION, WinCodeConfig, WinCodeTimeouts, getDefaultTimeouts } from '../Core/Config.js';
import { CacheManager } from '../Core/Cache.js';
import {
  ResourceManager,
  TimeoutError,
  killProcessTree,
  toExternalOpFailure,
  withTimeout,
} from '../Core/ResourceManager.js';

import { CodeSymbol, SymbolReference, FindSymbolsResult, FindReferencesResult, SERENA_DEGRADED_LIMITATIONS, computeTypeMatchStats } from '../Core/CodeQueries.js';
export type { CodeSymbol, SymbolReference, FindSymbolsResult, FindReferencesResult } from '../Core/CodeQueries.js';
export { SERENA_DEGRADED_LIMITATIONS, computeTypeMatchStats } from '../Core/CodeQueries.js';

interface ParsedSerenaResult<T> {
  items: T[];
  complete: boolean;
  shortened: boolean;
  error?: string;
}

interface LocalScanResult<T> {
  items: T[];
  complete: boolean;
  truncated: boolean;
  error?: string;
}

function isSerenaTextError(rawText: string): boolean {
  // Source bodies are data: error phrases inside a JSON response are not errors.
  try { JSON.parse(rawText); return false; } catch { /* Inspect only plain text. */ }
  return /^(?:Error:|No active project\b|没有激活项目)/.test(rawText.trim());
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Serena is optional. Local regex scan always remains available.
 * Connect lazily, reuse one MCP session, reset on crash/timeout, and never
 * let a hung upstream take down WinCode.
 */
export class SerenaAdapter implements IAdapter {
  readonly name = 'SerenaAdapter';
  readonly description =
    'Symbol search and reference tracking: Serena MCP when handshake + project activation succeed, otherwise labeled regex fallback';

  private config: WinCodeConfig;
  private cache: CacheManager;
  private resources?: ResourceManager;
  private timeouts: WinCodeTimeouts;
  private serenaClient: Client | null = null;
  private serenaTransport: StdioClientTransport | null = null;
  private isConnectedToSerena = false;
  private serenaTools: Set<string> = new Set();
  private commandFound = false;
  private projectActive: boolean | null = null;
  private connectPromise: Promise<boolean> | null = null;
  private disposing = false;
  private serenaPid: number | null = null;
  private lastHandshakeFailedPid: number | null = null;
  private processResourceId: string | null = null;
  private resolvedCommand: string | null = null;
  lastError: AdapterLastError | null = null;

  getLastHandshakeFailedPid(): number | null {
    return this.lastHandshakeFailedPid;
  }

  constructor(config: WinCodeConfig, cache: CacheManager, resources?: ResourceManager) {
    this.config = config;
    this.cache = cache;
    this.resources = resources;
    this.timeouts = config.timeouts ?? getDefaultTimeouts();
  }

  /**
   * Probe the binary only. Handshake is lazy: the first semantic tool call
   * reuses a single in-flight connect promise so two MCP requests cannot
   * spawn two Serena processes.
   */
  async initialize(): Promise<void> {
    await this.dispose();
    this.commandFound = await this.probeCommand();
    this.healthObservedAt = new Date().toISOString();
  }

  /**
   * Command existence only. Does not mean handshake or semantic queries work.
   */
  private async probeCommand(): Promise<boolean> {
    if (this.config.adapters.serena.customEndpoint) {
      return true;
    }
    if (this.config.adapters.serena.customCommand) {
      return true;
    }
    try {
      const checkCmd = process.platform === 'win32' ? 'where.exe serena' : 'which serena';
      const stdout = execSync(checkCmd, {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: this.timeouts.commandProbeMs,
      }).toString();
      const first = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0);
      this.resolvedCommand = first || null;
      return Boolean(first);
    } catch {
      this.resolvedCommand = null;
      return false;
    }
  }

  /**
   * Prefer a real .exe so we do not wrap with cmd.exe (orphans grandchildren).
   * .cmd launchers still need cmd /c because the MCP SDK spawns with shell:false.
   */
  private resolveSpawnTarget(): { command: string; args: string[] } {
    if (this.config.adapters.serena.customCommand) {
      return {
        command: this.config.adapters.serena.customCommand,
        args: this.config.adapters.serena.customArgs ?? [],
      };
    }
    const resolved = this.resolvedCommand || 'serena';
    if (process.platform === 'win32' && /\.cmd$/i.test(resolved)) {
      return { command: 'cmd', args: ['/c', resolved] };
    }
    return { command: resolved, args: [] };
  }

  /** Files changed under the current connection; next semantic query must re-probe project. */
  markProjectStale(): void {
    this.projectActive = null;
  }

  private recordError(reason: AdapterLastError['reason'], err: unknown, recoverable = true): void {
    const failure = toExternalOpFailure(err, 'serena', recoverable);
    this.lastError = {
      at: new Date().toISOString(),
      reason: reason === 'error' ? failure.reason : reason,
      message: failure.message,
      recoverable,
    };
  }

  getUpstreamStatus(): UpstreamConnectionStatus {
    const handshakeOk = this.isConnectedToSerena;
    const hasSemanticTool =
      this.serenaTools.has('find_symbol') ||
      this.serenaTools.has('find_symbols') ||
      this.serenaTools.has('get_symbols_overview') ||
      this.serenaTools.has('find_referencing_symbols');
    const semanticQueryUsable = handshakeOk && hasSemanticTool && this.projectActive === true;
    const mode: 'connected' | 'degraded' = semanticQueryUsable ? 'connected' : 'degraded';
    return {
      commandFound: this.commandFound,
      handshakeOk,
      projectActive: this.projectActive,
      semanticQueryUsable,
      mode,
    };
  }

  /**
   * Local symbol/reference tools remain available even when upstream is down.
   * source=installed only after a successful handshake, never because the binary exists.
   */
  async checkHealth(): Promise<AdapterHealth> {
    if (!this.commandFound) {
      this.commandFound = await this.probeCommand();
    }
    this.healthObservedAt = new Date().toISOString();
    return this.describeHealth();
  }

  private healthObservedAt: string | null = null;

  getKnownHealth() {
    return { observedAt: this.healthObservedAt, health: this.healthObservedAt ? this.describeHealth() : null };
  }

  private describeHealth(): AdapterHealth {
    const upstream = this.getUpstreamStatus();
    const handshakeOk = upstream.handshakeOk;
    const source: AdapterHealth['source'] = handshakeOk
      ? 'installed'
      : this.config.adapters.serena.customEndpoint
        ? 'remote'
        : 'fallback';

    const parts = [
      `commandFound=${upstream.commandFound}`,
      `handshakeOk=${upstream.handshakeOk}`,
      `projectActive=${upstream.projectActive === null ? 'unprobed' : upstream.projectActive}`,
      `semanticQueryUsable=${upstream.semanticQueryUsable}`,
      `mode=${upstream.mode}`,
    ];
    if (upstream.mode === 'degraded') {
      parts.push('local fallback symbol scan is available; this is not an upstream Serena connection');
    }

    return {
      available: true,
      source,
      details: parts.join('; '),
      upstream,
      lastError: this.lastError ?? undefined,
    };
  }

  /**
   * Single-flight connect. Safe to call from concurrent tool handlers.
   */
  async ensureConnected(operation?: OperationContext): Promise<boolean> {
    checkOperation(operation);
    if (!this.config.adapters.serena.enabled) return false;
    if (this.resetPromise) await this.resetPromise;
    if (this.isConnectedToSerena && this.serenaClient) return true;
    if (this.connectPromise) return this.connectPromise;
    if (!this.commandFound) {
      this.commandFound = await this.probeCommand();
    }
    if (!this.commandFound && !this.config.adapters.serena.customCommand && !this.config.adapters.serena.customEndpoint) {
      return false;
    }
    this.connectPromise = this.tryConnectSerena(operation).finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  /**
   * Attempts to establish an MCP stdio connection to Serena.
   * Timeout or crash must not throw out of the adapter — WinCode stays up.
   */
  private async tryConnectSerena(operation?: OperationContext): Promise<boolean> {
    await this.resetConnection();
    this.resetPromise = null;

    let transport: StdioClientTransport | null = null;
    let client: Client | null = null;

    try {
      const spawnTarget = this.resolveSpawnTarget();
      transport = new StdioClientTransport({
        command: spawnTarget.command,
        args: spawnTarget.args,
        stderr: 'pipe',
        cwd: this.config.workspaceRoot,
      });
      // Own the PID as soon as spawn returns, before connect can reject and the
      // SDK clears transport.pid while asynchronously closing its streams.
      const startTransport = transport.start.bind(transport);
      transport.start = async () => {
        const started = startTransport();
        if (transport?.pid) {
          this.serenaPid = transport.pid;
          if (this.resources && !this.processResourceId)
            this.processResourceId = this.resources.register('process', 'serena', () => this.killSerenaProcess());
        }
        await started;
      };

      client = new Client(
        { name: 'wincode-serena-adapter', version: WINCODE_VERSION },
        { capabilities: {} }
      );

      transport.onclose = () => {
        this.handleTransportClosed();
      };
      transport.onerror = (err) => {
        this.recordError('crash', err, true);
      };

      await withTimeout(
        (async () => {
          await client!.connect(transport!, { signal: operation?.signal, timeout: this.timeouts.serenaConnectMs });
          checkOperation(operation);
          if (transport?.pid) {
            this.serenaPid = transport.pid;
            if (this.resources && this.serenaPid && !this.processResourceId) {
              this.processResourceId = this.resources.register('process', 'serena', () => this.killSerenaProcess());
            }
          }
          const toolsList = await client!.listTools(undefined, { signal: operation?.signal });
          checkOperation(operation);
          this.serenaTools.clear();
          for (const t of toolsList.tools) {
            this.serenaTools.add(t.name);
          }
        })(),
        this.timeouts.serenaConnectMs,
        'serena-connect'
      );

      this.serenaTransport = transport;
      this.serenaClient = client;
      this.isConnectedToSerena = true;
      if (transport.pid) {
        this.serenaPid = transport.pid;
        if (this.resources && this.serenaPid && !this.processResourceId) {
          this.processResourceId = this.resources.register('process', 'serena', () => this.killSerenaProcess());
        }
      }
      console.error(`[SerenaAdapter] Connected to upstream Serena MCP server with ${this.serenaTools.size} tools.`);
      return true;
    } catch (err) {
      this.recordError(err instanceof TimeoutError ? 'timeout' : 'error', err, true);
      const failPid = transport?.pid || this.serenaPid;
      if (failPid) {
        this.lastHandshakeFailedPid = failPid;
        await killProcessTree({ pid: failPid }).catch(() => {});
      }
      await this.closeClientAndTransport(client, transport);
      if (failPid) await killProcessTree({ pid: failPid });
      this.serenaPid = null;
      if (this.processResourceId && this.resources) {
        this.resources.unregister(this.processResourceId);
        this.processResourceId = null;
      }
      this.clearConnectionFields();
      return false;
    }
  }

  private handleTransportClosed(): void {
    if (this.disposing) return;
    if (!this.isConnectedToSerena && !this.serenaClient) return;
    this.recordError('crash', new Error('Serena stdio transport closed unexpectedly'), true);
    this.clearConnectionFields();
  }

  private async callSerenaTool(name: string, args: Record<string, unknown>, operation?: OperationContext): Promise<Awaited<ReturnType<Client['callTool']>>> {
    checkOperation(operation);
    if (!this.serenaClient) {
      throw new Error('Serena client is not connected');
    }
    try {
      return await withTimeout(
        this.serenaClient.callTool({ name, arguments: args }, { signal: operation?.signal, timeout: Math.max(1, Math.min(this.timeouts.serenaCallMs, (operation?.deadline ?? Infinity) - Date.now())) }),
        this.timeouts.serenaCallMs,
        'serena'
      );
    } catch (err) {
      this.recordError(err instanceof TimeoutError ? 'timeout' : 'crash', err, true);
      await this.resetConnection();
      throw err;
    }
  }

  /**
   * wincode_find_code_symbol: Serena when connected and project-active, else local regex scan.
   */
  async findSymbols(query: string, kindFilter?: string, operation?: OperationContext): Promise<CodeSymbol[]> {
    const res = await this.findSymbolsDetailed(query, kindFilter, undefined, operation);
    return res.symbols;
  }

  async findSymbolsDetailed(query: string, kindFilter?: string, relativePath?: string, operation?: OperationContext): Promise<FindSymbolsResult> {
    checkOperation(operation);
    const cacheKey = `serena_symbols_v3_${JSON.stringify([query, kindFilter, relativePath, this.config.workspaceRoot])}`;
    const fingerprint = await this.cache.computeWorkspaceFingerprint(this.config.workspaceRoot);

    const cached = await this.cache.get<FindSymbolsResult>(cacheKey, fingerprint);
    checkOperation(operation);
    if (cached && cached.queryComplete !== false) return cached;

    let symbols: CodeSymbol[] = [];
    let source: 'serena-mcp' | 'serena-adapter-fallback' = 'serena-adapter-fallback';
    let queryComplete = true;
    let queryError: string | undefined;
    let truncated = false;

    await this.ensureConnected(operation).catch(() => false);
    checkOperation(operation);

    const serenaToolName = ['find_symbol', 'find_symbols'].find((t) =>
      this.serenaTools.has(t)
    );

    if (this.isConnectedToSerena && this.serenaClient && serenaToolName) {
      try {
        const serenaRes = await this.callSerenaTool(serenaToolName, {
          [serenaToolName === 'find_symbol' ? 'name_path_pattern' : 'name_path']: query,
          relative_path: relativePath ?? '',
        }, operation);

        const rawText = this.serenaResultText(serenaRes);
        const isExplicitError =
          serenaRes.isError ||
          isSerenaTextError(rawText);

        if (isExplicitError) {
          queryComplete = false;
          queryError = typeof rawText === 'string' ? rawText : 'Serena MCP returned isError';
          if (typeof rawText === 'string' && (rawText.includes('没有激活项目') || rawText.includes('No active project'))) {
            this.projectActive = false;
          }
          console.warn(`[SerenaAdapter] Serena MCP ${serenaToolName} returned error:`, rawText);
        } else {
          const parsed = this.parseSerenaSymbols(rawText, kindFilter);
          truncated = parsed.shortened || rawText.length > 200_000;
          queryComplete = parsed.complete && !truncated;
          queryError = parsed.error ?? (truncated ? 'Serena symbol response exceeded the supported response size.' : undefined);
          symbols = parsed.items;
          if (parsed.complete || parsed.items.length > 0) source = 'serena-mcp';
          if (parsed.complete) this.projectActive = true;
        }
      } catch (err) {
        rethrowOperationError(err, operation);
        queryComplete = false;
        queryError = err instanceof Error ? err.message : String(err);
        console.warn('[SerenaAdapter] Serena MCP call failed, falling back to local indexing:', err);
      }
    }

    if (symbols.length === 0 && source === 'serena-adapter-fallback') {
      const local = await this.scanSymbolsLocally(query, kindFilter, relativePath, operation);
      symbols = local.items;
      queryComplete = queryComplete && local.complete;
      truncated ||= local.truncated;
      queryError = [queryError, local.error].filter(Boolean).join('; ') || undefined;
    }

    const { uniqueTypeMatch, typeMatchCount } = computeTypeMatchStats(symbols, query);
    const analysisCompleteness: FindSymbolsResult['analysisCompleteness'] = !queryComplete
      ? 'incomplete'
      : source === 'serena-mcp'
        ? 'semantic'
        : 'degraded';
    const limitations =
      source === 'serena-mcp' && queryComplete
        ? truncated
          ? ['Serena 返回可能被截断，符号列表不一定完整。']
          : []
        : [...SERENA_DEGRADED_LIMITATIONS];
    if (!queryComplete && queryError) {
      limitations.unshift(`查询不完整: ${queryError}`);
    }

    const result: FindSymbolsResult = {
      query,
      kindFilter,
      totalFound: symbols.length,
      symbols,
      source,
      analysisCompleteness,
      limitations,
      queryComplete,
      queryError,
      truncated,
      uniqueTypeMatch: queryComplete && !truncated && uniqueTypeMatch,
      typeMatchCount,
    };

    checkOperation(operation);
    if (queryComplete) {
      await this.cache.set(cacheKey, result, { fingerprint, ttlMs: 1000 * 60 * 5 });
    }
    return result;
  }

  /**
   * wincode_find_references: Serena when usable, else word-boundary text scan with limitations.
   */
  async findReferences(symbolName: string, relativePath?: string, operation?: OperationContext): Promise<SymbolReference[]> {
    const res = await this.findReferencesDetailed(symbolName, relativePath, operation);
    return res.references;
  }

  async findReferencesDetailed(symbolName: string, relativePath?: string, operation?: OperationContext): Promise<FindReferencesResult> {
    checkOperation(operation);
    const cacheKey = `serena_refs_v3_${JSON.stringify([symbolName, relativePath, this.config.workspaceRoot])}`;
    const fingerprint = await this.cache.computeWorkspaceFingerprint(this.config.workspaceRoot);

    const cached = await this.cache.get<FindReferencesResult>(cacheKey, fingerprint);
    checkOperation(operation);
    if (cached && cached.queryComplete !== false) return cached;

    let refs: SymbolReference[] = [];
    let source: 'serena-mcp' | 'serena-adapter-fallback' = 'serena-adapter-fallback';
    let queryComplete = true;
    let queryError: string | undefined;
    let truncated = false;
    let resolution: NonNullable<FindReferencesResult['resolution']> = 'unavailable';
    let candidates: CodeSymbol[] | undefined;
    let candidateCount: number | undefined;
    let target: FindReferencesResult['target'];
    let allowFallback = true;

    await this.ensureConnected(operation).catch(() => false);
    checkOperation(operation);

    const refToolName = ['find_referencing_symbols', 'find_references', 'get_references'].find((t) =>
      this.serenaTools.has(t)
    );

    if (this.isConnectedToSerena && this.serenaClient && refToolName) {
      try {
        let targetRelPath = relativePath;
        let targetNamePath = symbolName;

        // A file plus an explicit name path can be passed directly to upstream's
        // unique resolver. A simple name must first be resolved without picking a winner.
        if (!targetRelPath || !/[\/\[]/.test(symbolName)) {
          const found = await this.findSymbolsDetailed(symbolName, undefined, relativePath, operation);
          candidateCount = found.symbols.length;
          candidates = found.symbols.slice(0, 20);
          if (!found.queryComplete || found.truncated || found.source !== 'serena-mcp') {
            resolution = 'incomplete';
            queryComplete = false;
            queryError = found.queryError ?? 'Symbol identity could not be resolved by a complete semantic query.';
            truncated = found.truncated;
          } else if (found.symbols.length !== 1) {
            resolution = found.symbols.length === 0 ? 'not-found' : 'ambiguous';
            queryComplete = false;
            queryError = `Symbol identity is ${resolution}: ${found.symbols.length} candidates. Supply a full namePath and relativePath.`;
            source = 'serena-mcp';
            allowFallback = false;
          } else {
            const matched = found.symbols[0];
            if (matched.file && matched.namePath) {
              targetRelPath = matched.file;
              targetNamePath = matched.namePath;
              resolution = 'resolved';
            } else {
              resolution = 'incomplete';
              queryComplete = false;
              queryError = 'The candidate does not include an exact upstream namePath and defining file.';
            }
          }
        } else {
          resolution = 'resolved';
        }

        if (resolution === 'resolved' && targetRelPath) {
          target = { namePath: targetNamePath.replace(/^\//, ''), relativePath: targetRelPath };
          const serenaRes = await this.callSerenaTool(refToolName, {
            name_path: `/${target.namePath}`,
            relative_path: targetRelPath,
          }, operation);

          const rawText = this.serenaResultText(serenaRes);
          const isExplicitError =
            serenaRes.isError ||
            isSerenaTextError(rawText);

          if (isExplicitError) {
            resolution = 'incomplete';
            queryComplete = false;
            queryError = typeof rawText === 'string' ? rawText : 'Serena MCP returned isError';
            if (typeof rawText === 'string' && (rawText.includes('没有激活项目') || rawText.includes('No active project'))) {
              this.projectActive = false;
            }
            console.warn(`[SerenaAdapter] Serena MCP ${refToolName} returned error:`, rawText);
          } else {
            const parsed = this.parseSerenaReferences(rawText, symbolName);
            truncated = parsed.shortened || rawText.length > 200_000;
            refs = parsed.items;
            queryComplete = parsed.complete && !truncated;
            queryError = parsed.error ?? (truncated ? 'Serena reference response exceeded the supported response size.' : undefined);
            if (parsed.complete || parsed.items.length > 0) source = 'serena-mcp';
            if (parsed.complete) this.projectActive = true;
            if (!queryComplete) resolution = 'incomplete';
            allowFallback = !parsed.complete && parsed.items.length === 0;
          }
        }
      } catch (err) {
        resolution = 'incomplete';
        rethrowOperationError(err, operation);
        queryComplete = false;
        queryError = err instanceof Error ? err.message : String(err);
        console.warn('[SerenaAdapter] Serena MCP call failed, falling back to local reference scanner:', err);
      }
    }

    if (refs.length === 0 && source === 'serena-adapter-fallback' && allowFallback) {
      const displayName = symbolName.split('/').pop()!.replace(/\[\d+\]$/, '');
      const local = await this.scanReferencesLocally(displayName, operation);
      refs = local.items;
      queryComplete = queryComplete && local.complete;
      truncated ||= local.truncated;
      queryError = [queryError, local.error].filter(Boolean).join('; ') || undefined;
    }

    const analysisCompleteness: FindReferencesResult['analysisCompleteness'] = !queryComplete
      ? 'incomplete'
      : source === 'serena-mcp'
        ? 'semantic'
        : 'degraded';
    const limitations =
      source === 'serena-mcp' && queryComplete
        ? truncated
          ? ['Serena 返回可能被截断，引用列表不一定完整。']
          : []
        : [...SERENA_DEGRADED_LIMITATIONS];
    if (!queryComplete && queryError) {
      limitations.unshift(`查询不完整: ${queryError}`);
    }
    if (refs.length === 0) {
      limitations.push('未找到引用不得直接解释为“无影响”或“低风险”。');
    }

    const result: FindReferencesResult = {
      symbolName,
      totalReferences: refs.length,
      references: refs,
      source,
      analysisCompleteness,
      limitations,
      queryComplete,
      queryError,
      truncated,
      resolution,
      candidates,
      candidateCount,
      candidatesTruncated: candidateCount === undefined ? undefined : candidateCount > (candidates?.length ?? 0),
      target,
    };

    checkOperation(operation);
    if (queryComplete) {
      await this.cache.set(cacheKey, result, { fingerprint, ttlMs: 1000 * 60 * 5 });
    }
    return result;
  }

  private serenaResultText(result: Awaited<ReturnType<Client['callTool']>>): string {
    if (result.structuredContent !== undefined) return JSON.stringify(result.structuredContent);
    return Array.isArray(result.content)
      ? result.content.filter(block => block.type === 'text').map(block => (block as { text: string }).text).join('\n')
      : '';
  }

  private parsePayload(rawText: string): { value?: unknown; shortened: boolean; error?: string } {
    const shortened = /^\s*(?:The answer is too long|Shortened result:|Matched \d+>max_matches|References without surrounding lines:|Reference counts per file:|Found \d+ references\.)/i.test(rawText);
    if (shortened) return { shortened: true, error: 'Serena returned a shortened response; refine the query.' };
    try {
      return { value: JSON.parse(rawText), shortened: false };
    } catch {
      return { shortened: false, error: 'Serena response is not valid JSON.' };
    }
  }

  private isRecord(value: unknown): value is Record<string, any> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  /** LSP coordinates are zero-based; legacy plain line fields are already one-based. */
  private oneBasedLine(zeroBased: unknown, legacy?: unknown): number | undefined {
    if (typeof zeroBased === 'number' && Number.isInteger(zeroBased) && zeroBased >= 0) return zeroBased + 1;
    if (zeroBased !== undefined && zeroBased !== null) return undefined;
    if (typeof legacy === 'number' && Number.isInteger(legacy) && legacy >= 1) return legacy;
    return undefined;
  }

  private parseSerenaSymbols(rawText: string, kindFilter?: string): ParsedSerenaResult<CodeSymbol> {
    const payload = this.parsePayload(rawText);
    if (payload.error) return { items: [], complete: false, shortened: payload.shortened, error: payload.error };
    const value = payload.value;
    const rawList = Array.isArray(value) ? value :
      this.isRecord(value) && Array.isArray(value.symbols) && Object.keys(value).length === 1 ? value.symbols : undefined;
    if (!rawList) return { items: [], complete: false, shortened: false, error: 'Unsupported Serena symbol response structure.' };
    const items: CodeSymbol[] = [];
    let invalid = 0;
    for (const item of rawList) {
      if (!this.isRecord(item)) { invalid++; continue; }
      const namePath = typeof item.name_path === 'string' && item.name_path.trim() ? item.name_path : undefined;
      const parts = namePath?.split('/');
      const leafName = parts?.pop()?.replace(/\[\d+\]$/, '');
      const name = typeof item.name === 'string' && item.name ? item.name : leafName;
      const file = item.relative_path ?? item.file ?? item.path;
      const line = this.oneBasedLine(item.body_location?.start_line ?? item.location?.range?.start?.line, item.line);
      const kind = typeof item.kind === 'string' ? item.kind.toLowerCase() : undefined;
      if (!name || typeof file !== 'string' || !file || line === undefined || !kind) { invalid++; continue; }
      const signature = item.signature ?? item.preview ?? (typeof item.info === 'string' ? item.info : item.info?.description);
      items.push({
        name, namePath, file, line, kind: kind as CodeSymbol['kind'],
        containerName: parts?.length ? parts.join('/') : typeof item.containerName === 'string' ? item.containerName : undefined,
        signature: typeof signature === 'string' ? signature : undefined,
      });
    }
    return {
      items: kindFilter ? items.filter(s => s.kind === kindFilter.toLowerCase()) : items,
      complete: invalid === 0, shortened: false,
      error: invalid ? 'Serena symbol response contains ' + invalid + ' invalid entries.' : undefined,
    };
  }

  /** Compatibility wrapper. Detailed queries also inspect the parser's completeness. */
  public mapSerenaSymbols(rawText: string, _query: string, kindFilter?: string): CodeSymbol[] {
    return this.parseSerenaSymbols(rawText, kindFilter).items;
  }

  private parseSerenaReferences(rawText: string, symbolName: string): ParsedSerenaResult<SymbolReference> {
    const payload = this.parsePayload(rawText);
    if (payload.error) return { items: [], complete: false, shortened: payload.shortened, error: payload.error };
    const items: SymbolReference[] = [];
    let invalid = 0;
    const visit = (node: unknown, currentPath = '', level = 0): void => {
      if (Array.isArray(node)) {
        for (const item of node) visit(item, currentPath, level + 1);
        return;
      }
      if (!this.isRecord(node)) { invalid++; return; }
      const keys = Object.keys(node);
      // The official grouped empty reference result is {}, and ungrouped is [].
      if (keys.length === 0) {
        if (level > 0) invalid++;
        return;
      }
      const leaf = ['body_location', 'reference_line', 'content_around_reference', 'line', 'snippet', 'line_content', 'preview']
        .some(key => key in node);
      if (leaf) {
        const file = node.relative_path ?? node.file ?? node.path ?? currentPath;
        const hasReferenceLine = node.reference_line !== undefined && node.reference_line !== null;
        const zeroLine = hasReferenceLine ? node.reference_line : node.body_location?.start_line ?? node.location?.range?.start?.line;
        const line = this.oneBasedLine(zeroLine, node.line);
        const preview = node.content_around_reference ?? node.preview ?? node.snippet ?? node.line_content ??
          (typeof node.name_path === 'string' ? 'Reference in ' + node.name_path : undefined);
        if (typeof file !== 'string' || !file || line === undefined || typeof preview !== 'string') { invalid++; return; }
        items.push({
          symbolName, file, line, preview: preview.trim(),
          lineKind: hasReferenceLine || node.line !== undefined ? 'reference' : 'containing-symbol',
        });
        return;
      }
      if (keys.length === 1 && Array.isArray(node.references)) {
        visit(node.references, currentPath, level + 1);
        return;
      }
      for (const [key, child] of Object.entries(node)) {
        if (!currentPath && (key.includes('/') || key.includes('\\') || /\.[a-zA-Z0-9]+$/.test(key))) {
          visit(child, key, level + 1);
        } else if (currentPath && /^[A-Z][a-zA-Z]+$/.test(key)) {
          visit(child, currentPath, level + 1);
        } else {
          invalid++;
        }
      }
    };
    visit(payload.value);
    return {
      items, complete: invalid === 0, shortened: false,
      error: invalid ? 'Serena reference response contains ' + invalid + ' invalid entries or groups.' : undefined,
    };
  }

  /** Compatibility wrapper. Empty items alone do not establish a complete query. */
  public mapSerenaReferences(rawText: string, symbolName: string): SymbolReference[] {
    return this.parseSerenaReferences(rawText, symbolName).items;
  }

  /**
   * Local regex symbol scan (C#, TypeScript/JS, Python). Not AST, LSP, or Roslyn.
   */
  private async scanSymbolsLocally(query: string, kindFilter?: string, relativePath?: string, operation?: OperationContext): Promise<LocalScanResult<CodeSymbol>> {
    const lowerQuery = query.toLowerCase();
    return this.scanLocalFiles(['.cs', '.ts', '.js', '.py'], 500, (content, relPath, ext) =>
      this.parseFileSymbols(content, relPath, ext).filter(sym =>
        sym.name.toLowerCase().includes(lowerQuery) && (!kindFilter || sym.kind.toLowerCase() === kindFilter.toLowerCase())
      ), relativePath, operation);
  }

  /** One budget spans all directories; only UTF-8 regular files inside the workspace are scanned. */
  private async scanLocalFiles<T>(extensions: string[], maxResults: number,
    extract: (content: string, relPath: string, ext: string) => Iterable<T>, relativePath?: string, operation?: OperationContext
  ): Promise<LocalScanResult<T>> {
    const root = this.config.workspaceRoot;
    const items: T[] = [];
    const reasons = new Set<string>();
    const deadline = Date.now() + this.timeouts.fileScanMs;
    const fileLimit = 256 * 1024;
    const totalLimit = 8 * 1024 * 1024;
    let bytesRead = 0;
    let entriesVisited = 0;
    let stopped = false;
    let truncated = false;
    const ignoredDirs = new Set(['node_modules', 'bin', 'obj', 'dist', '.git', '.vs', 'trash', '.cache', '.deps', '.packages', '.dotnet', '.dotnet_cli_home']);
    const mark = (reason: string, bounded = false, stop = false): void => {
      reasons.add(reason);
      truncated ||= bounded;
      stopped ||= stop;
    };
    const canContinue = (): boolean => {
      checkOperation(operation);
      if (Date.now() >= deadline) mark('deadline', true, true);
      return !stopped;
    };
    const isInside = (candidate: string, base: string): boolean => {
      const rel = path.relative(base, candidate);
      return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
    };
    let realRoot: string;
    try { realRoot = await fs.realpath(root); }
    catch { return { items, complete: false, truncated: false, error: 'Local scan: read-error' }; }

    const read = async (fullPath: string): Promise<void> => {
      if (!canContinue()) return;
      const ext = path.extname(fullPath).toLowerCase();
      if (!extensions.includes(ext)) return;
      try {
        // Also guards a scoped path whose intermediate directory is a junction.
        const actualPath = await fs.realpath(fullPath);
        if (!isInside(actualPath, realRoot)) { mark('invalid-scope'); return; }
        if (!canContinue()) return;
        const handle = await fs.open(actualPath, 'r');
        try {
          const stat = await handle.stat();
          if (!stat.isFile()) { mark('read-error'); return; }
          if (stat.size > fileLimit) { mark('file-byte-limit', true); return; }
          const remaining = totalLimit - bytesRead;
          if (remaining <= 0) { mark('total-byte-limit', true, true); return; }
          // One extra byte detects a file growing after stat, without an unbounded readFile.
          const buffer = Buffer.alloc(Math.min(fileLimit + 1, remaining));
          let used = 0;
          let eof = false;
          while (used < buffer.length && canContinue()) {
            const chunk = await handle.read(buffer, used, buffer.length - used, null);
            bytesRead += chunk.bytesRead;
            used += chunk.bytesRead;
            if (chunk.bytesRead === 0) { eof = true; break; }
          }
          if (!canContinue()) return;
          if (used > fileLimit) { mark('file-byte-limit', true); return; }
          if (!eof && used === remaining) { mark('total-byte-limit', true, true); return; }
          let content: string;
          try {
            content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, used));
            if (content.includes('\0')) { mark('encoding'); return; }
          } catch { mark('encoding'); return; }
          for (const item of extract(content, path.relative(root, fullPath), ext)) {
            if (!canContinue()) break;
            items.push(item);
            if (items.length >= maxResults) { mark('result-limit', true, true); break; }
          }
        } finally { await handle.close(); }
      } catch (error) { rethrowOperationError(error, operation); mark('read-error'); }
    };
    const walk = async (dir: string): Promise<void> => {
      if (!canContinue()) return;
      try {
        // Stream directory entries so an enormous directory does not allocate an unbounded array.
        const handle = await fs.opendir(dir);
        for await (const entry of handle) {
          if (!canContinue()) break;
          if (++entriesVisited > 5000) { mark('entry-limit', true, true); break; }
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory() && !ignoredDirs.has(entry.name)) await walk(fullPath);
          else if (entry.isFile()) await read(fullPath);
          else if (entry.isSymbolicLink()) mark('symlink-skipped');
        }
      } catch (error) { rethrowOperationError(error, operation); mark('read-error'); }
    };
    if (relativePath) {
      const scopedPath = path.resolve(root, relativePath);
      if (path.isAbsolute(relativePath) || !isInside(scopedPath, root)) mark('invalid-scope');
      else await read(scopedPath);
    } else await walk(root);
    return { items, complete: reasons.size === 0, truncated,
      error: reasons.size ? `Local scan: ${[...reasons].join(', ')}` : undefined };
  }

  /** Bounded callers supply already validated file content; no workspace traversal or semantic guarantees. */
  findSymbolsInContent(content: string, relPath: string): CodeSymbol[] {
    return this.parseFileSymbols(content, relPath, path.extname(relPath).toLowerCase());
  }

  private parseFileSymbols(content: string, relPath: string, ext: string): CodeSymbol[] {
    const symbols: CodeSymbol[] = [];
    const lines = content.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const lineNum = i + 1;

      // C# symbol patterns
      if (ext === '.cs') {
        const classMatch = trimmed.match(/(?:public|private|protected|internal)?\s*(?:static|abstract|sealed|partial)?\s*class\s+([A-Za-z0-9_]+)/);
        if (classMatch) {
          symbols.push({ name: classMatch[1], kind: 'class', file: relPath, line: lineNum, signature: trimmed });
          continue;
        }

        const structMatch = trimmed.match(/(?:public|private|protected|internal)?\s*(?:readonly|ref)?\s*struct\s+([A-Za-z0-9_]+)/);
        if (structMatch) {
          symbols.push({ name: structMatch[1], kind: 'struct', file: relPath, line: lineNum, signature: trimmed });
          continue;
        }

        const enumMatch = trimmed.match(/(?:public|private|protected|internal)?\s*enum\s+([A-Za-z0-9_]+)/);
        if (enumMatch) {
          symbols.push({ name: enumMatch[1], kind: 'enum', file: relPath, line: lineNum, signature: trimmed });
          continue;
        }

        const interfaceMatch = trimmed.match(/(?:public|private|protected|internal)?\s*interface\s+([A-Za-z0-9_]+)/);
        if (interfaceMatch) {
          symbols.push({ name: interfaceMatch[1], kind: 'interface', file: relPath, line: lineNum, signature: trimmed });
          continue;
        }

        const methodMatch = trimmed.match(/(?:public|private|protected|internal)\s+(?:async\s+)?(?:static\s+|virtual\s+|override\s+|sealed\s+)?([A-Za-z0-9_<>?, \[\]]+)\s+([A-Za-z0-9_]+)\s*\(/);
        if (methodMatch && !['if', 'for', 'while', 'switch', 'using', 'catch'].includes(methodMatch[2])) {
          symbols.push({ name: methodMatch[2], kind: 'method', file: relPath, line: lineNum, signature: trimmed });
          continue;
        }
      }

      // TypeScript / JavaScript symbol patterns
      if (ext === '.ts' || ext === '.js') {
        const classMatch = trimmed.match(/(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_]+)/);
        if (classMatch) {
          symbols.push({ name: classMatch[1], kind: 'class', file: relPath, line: lineNum, signature: trimmed });
          continue;
        }

        const interfaceMatch = trimmed.match(/(?:export\s+)?interface\s+([A-Za-z0-9_]+)/);
        if (interfaceMatch) {
          symbols.push({ name: interfaceMatch[1], kind: 'interface', file: relPath, line: lineNum, signature: trimmed });
          continue;
        }

        const enumMatch = trimmed.match(/(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z0-9_]+)/);
        if (enumMatch) {
          symbols.push({ name: enumMatch[1], kind: 'enum', file: relPath, line: lineNum, signature: trimmed });
          continue;
        }

        const typeMatch = trimmed.match(/(?:export\s+)?type\s+([A-Za-z0-9_]+)\s*=/);
        if (typeMatch) {
          symbols.push({ name: typeMatch[1], kind: 'type', file: relPath, line: lineNum, signature: trimmed });
          continue;
        }

        const funcMatch = trimmed.match(/(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/);
        if (funcMatch) {
          symbols.push({ name: funcMatch[1], kind: 'function', file: relPath, line: lineNum, signature: trimmed });
          continue;
        }

        const arrowFuncMatch = trimmed.match(/(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::\s*[^=]+)?\s*=>/);
        if (arrowFuncMatch) {
          symbols.push({ name: arrowFuncMatch[1], kind: 'function', file: relPath, line: lineNum, signature: trimmed });
          continue;
        }

        const classMethodMatch = trimmed.match(/^(?:public|private|protected)?\s*(?:static\s+)?(?:async\s+)?([A-Za-z0-9_]+)\s*\([^)]*\)\s*(?::\s*[^;{]+)?\s*\{/);
        if (classMethodMatch && !['if', 'for', 'while', 'switch', 'constructor', 'catch'].includes(classMethodMatch[1])) {
          symbols.push({ name: classMethodMatch[1], kind: 'method', file: relPath, line: lineNum, signature: trimmed });
          continue;
        }
      }

      // Python symbol patterns
      if (ext === '.py') {
        const classMatch = trimmed.match(/^class\s+([A-Za-z0-9_]+)/);
        if (classMatch) {
          symbols.push({ name: classMatch[1], kind: 'class', file: relPath, line: lineNum, signature: trimmed });
          continue;
        }

        const defMatch = trimmed.match(/^(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*\(/);
        if (defMatch) {
          symbols.push({ name: defMatch[1], kind: 'function', file: relPath, line: lineNum, signature: trimmed });
          continue;
        }
      }
    }

    return symbols;
  }

  private async scanReferencesLocally(symbolName: string, operation?: OperationContext): Promise<LocalScanResult<SymbolReference>> {
    const regex = new RegExp(`\\b${escapeRegExp(symbolName)}\\b`);
    const declaration = new RegExp(String.raw`(^|\s)(class|interface|struct|enum)\s+${escapeRegExp(symbolName)}\b`);
    return this.scanLocalFiles<SymbolReference>(['.cs', '.ts', '.tsx', '.js', '.jsx', '.py', '.xaml', '.xml', '.csproj', '.sln'], 200,
      function* (content, relPath) {
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const trimmed = lines[i].trim();
          if (/^(?:\/\/|\*|\/\*|#|<!--)/.test(trimmed) || declaration.test(trimmed)) continue;
          if (regex.test(lines[i])) yield { symbolName, file: relPath, line: i + 1, preview: trimmed };
        }
      }, undefined, operation);
  }

  async dispose(): Promise<void> {
    await this.resetConnection();
    this.commandFound = false;
    this.lastError = null;
  }

  /**
   * Close MCP transport + process tree. Idempotent. Used on workspace switch,
   * crash, timeout, and gateway shutdown. Leaves commandFound intact so the
   * next call can reconnect.
   */
  async resetConnection(): Promise<void> {
    if (this.resetPromise && !this.serenaClient && !this.serenaTransport && !this.serenaPid) return this.resetPromise;
    this.resetPromise = this.resetConnectionOnce();
    return this.resetPromise;
  }

  private resetPromise: Promise<void> | null = null;

  private async resetConnectionOnce(): Promise<void> {
    if (this.disposing && !this.serenaClient && !this.serenaTransport && !this.serenaPid) {
      return;
    }
    this.disposing = true;
    const client = this.serenaClient;
    const transport = this.serenaTransport;
    const pid = this.serenaPid;
    this.clearConnectionFields();
    this.serenaPid = null;
    if (this.processResourceId && this.resources) {
      this.resources.unregister(this.processResourceId);
      this.processResourceId = null;
    }
    const failures: unknown[] = [];
    try {
      // Kill the process tree first, while cmd.exe still parents grandchildren.
      if (pid) {
        try { await killProcessTree({ pid }); } catch (error) { failures.push(error); }
      }
      try { await this.closeClientAndTransport(client, transport); } catch (error) { failures.push(error); }
      if (failures.length) {
        this.recordError('error', new Error('Serena cleanup failed; the reset result remains failed.'), false);
        throw new AggregateError(failures, 'Serena reset failed.');
      }
    } finally {
      this.disposing = false;
    }
  }

  private async closeClientAndTransport(
    client: Client | null,
    transport: StdioClientTransport | null
  ): Promise<void> {
    const prePid = transport?.pid;
    const failures: unknown[] = [];
    if (prePid) {
      try { await killProcessTree({ pid: prePid }); } catch (error) { failures.push(error); }
    }
    if (client) {
      try {
        await withTimeout(client.close(), 2000, 'serena-client-close');
      } catch (error) {
        failures.push(error);
      }
    }
    if (transport) {
      try {
        await withTimeout(transport.close(), 2000, 'serena-transport-close');
      } catch (error) {
        failures.push(error);
      }
    }
    const postPid = transport?.pid;
    if (postPid && postPid !== prePid) {
      try { await killProcessTree({ pid: postPid }); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Serena client/transport cleanup failed.');
  }

  private async killSerenaProcess(): Promise<void> {
    const pid = this.serenaPid;
    this.serenaPid = null;
    if (this.processResourceId && this.resources) {
      this.resources.unregister(this.processResourceId);
      this.processResourceId = null;
    }
    if (!pid) return;
    await killProcessTree({ pid });
  }

  private clearConnectionFields(): void {
    this.serenaClient = null;
    this.serenaTransport = null;
    this.isConnectedToSerena = false;
    this.serenaTools.clear();
    this.projectActive = null;
  }
}
