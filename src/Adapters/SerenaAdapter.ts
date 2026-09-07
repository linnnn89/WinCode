import fs from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
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

export const SERENA_DEGRADED_LIMITATIONS: string[] = [
  '本地正则扫描仅作为文本检索降级方案，不保证符号身份、重载区分、跨文件引用完整性或安全重命名。',
  '本地正则扫描无法替代完整 Roslyn/TypeScript LSP 语义层面的跨文件重命名与重载解析。',
  '未找到引用不得直接解释为“无影响”或“低风险”。',
];

export interface CodeSymbol {
  name: string;
  kind: 'class' | 'interface' | 'method' | 'function' | 'property' | 'enum' | 'struct' | 'type';
  file: string;
  line: number;
  signature?: string;
  containerName?: string;
}

export interface SymbolReference {
  symbolName: string;
  file: string;
  line: number;
  preview: string;
}

export interface FindSymbolsResult {
  query: string;
  kindFilter?: string;
  totalFound: number;
  symbols: CodeSymbol[];
  source: 'serena-mcp' | 'serena-adapter-fallback';
  analysisCompleteness: 'semantic' | 'degraded' | 'incomplete';
  limitations: string[];
  queryComplete: boolean;
  queryError?: string;
  truncated: boolean;
  uniqueTypeMatch: boolean;
  typeMatchCount: number;
}

export interface FindReferencesResult {
  symbolName: string;
  totalReferences: number;
  references: SymbolReference[];
  source: 'serena-mcp' | 'serena-adapter-fallback';
  analysisCompleteness: 'semantic' | 'degraded' | 'incomplete';
  limitations: string[];
  queryComplete: boolean;
  queryError?: string;
  truncated: boolean;
}

const TYPE_KINDS = new Set(['class', 'interface', 'struct', 'enum']);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function computeTypeMatchStats(
  symbols: CodeSymbol[],
  query: string
): { uniqueTypeMatch: boolean; typeMatchCount: number } {
  const q = query.toLowerCase();
  const typeMatches = symbols.filter(
    (s) => TYPE_KINDS.has((s.kind || '').toLowerCase()) && s.name.toLowerCase() === q
  );
  const files = new Set(typeMatches.map((s) => (s.file || '').replace(/\\/g, '/').toLowerCase()));
  const typeMatchCount = files.size;
  return {
    typeMatchCount,
    uniqueTypeMatch: typeMatchCount === 1,
  };
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
  async ensureConnected(): Promise<boolean> {
    if (!this.config.adapters.serena.enabled) return false;
    if (this.isConnectedToSerena && this.serenaClient) return true;
    if (this.connectPromise) return this.connectPromise;
    if (!this.commandFound) {
      this.commandFound = await this.probeCommand();
    }
    if (!this.commandFound && !this.config.adapters.serena.customCommand && !this.config.adapters.serena.customEndpoint) {
      return false;
    }
    this.connectPromise = this.tryConnectSerena().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  /**
   * Attempts to establish an MCP stdio connection to Serena.
   * Timeout or crash must not throw out of the adapter — WinCode stays up.
   */
  private async tryConnectSerena(): Promise<boolean> {
    await this.resetConnection();

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
          await client!.connect(transport!);
          if (transport?.pid) {
            this.serenaPid = transport.pid;
            if (this.resources && this.serenaPid && !this.processResourceId) {
              this.processResourceId = this.resources.register('process', 'serena', () => this.killSerenaProcess());
            }
          }
          const toolsList = await client!.listTools();
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

  private async callSerenaTool(name: string, args: Record<string, unknown>): Promise<Awaited<ReturnType<Client['callTool']>>> {
    if (!this.serenaClient) {
      throw new Error('Serena client is not connected');
    }
    try {
      return await withTimeout(
        this.serenaClient.callTool({ name, arguments: args }),
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
  async findSymbols(query: string, kindFilter?: string): Promise<CodeSymbol[]> {
    const res = await this.findSymbolsDetailed(query, kindFilter);
    return res.symbols;
  }

  async findSymbolsDetailed(query: string, kindFilter?: string): Promise<FindSymbolsResult> {
    const cacheKey = `serena_symbols_${query}_${kindFilter || 'all'}_${this.config.workspaceRoot}`;
    const fingerprint = await this.cache.computeWorkspaceFingerprint(this.config.workspaceRoot);

    const cached = await this.cache.get<FindSymbolsResult>(cacheKey, fingerprint);
    if (cached && cached.queryComplete !== false) return cached;

    let symbols: CodeSymbol[] = [];
    let source: 'serena-mcp' | 'serena-adapter-fallback' = 'serena-adapter-fallback';
    let queryComplete = true;
    let queryError: string | undefined;
    let truncated = false;

    await this.ensureConnected().catch(() => false);

    const serenaToolName = ['find_symbol', 'find_symbols', 'get_symbols_overview'].find((t) =>
      this.serenaTools.has(t)
    );

    if (this.isConnectedToSerena && this.serenaClient && serenaToolName) {
      try {
        const serenaRes = await this.callSerenaTool(serenaToolName, {
          name_path_pattern: query,
          name_path: query,
          relative_path: '',
        });

        const rawText = (serenaRes.content as any[])?.[0]?.text;
        const isExplicitError =
          serenaRes.isError ||
          (typeof rawText === 'string' &&
            (rawText.startsWith('Error:') || rawText.includes('没有激活项目') || rawText.includes('No active project')));

        if (isExplicitError) {
          queryComplete = false;
          queryError = typeof rawText === 'string' ? rawText : 'Serena MCP returned isError';
          if (typeof rawText === 'string' && (rawText.includes('没有激活项目') || rawText.includes('No active project'))) {
            this.projectActive = false;
          }
          console.warn(`[SerenaAdapter] Serena MCP ${serenaToolName} returned error:`, rawText);
        } else if (rawText) {
          truncated = rawText.length > 200_000;
          symbols = this.mapSerenaSymbols(rawText, query, kindFilter);
          source = 'serena-mcp';
          this.projectActive = true;
          if (truncated) {
            queryComplete = false;
            queryError = 'Serena symbol response exceeded 200k characters and may be truncated.';
          }
        }
      } catch (err) {
        queryComplete = false;
        queryError = err instanceof Error ? err.message : String(err);
        console.warn('[SerenaAdapter] Serena MCP call failed, falling back to local indexing:', err);
      }
    }

    if (symbols.length === 0 && source === 'serena-adapter-fallback') {
      symbols = await this.scanSymbolsLocally(query, kindFilter);
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
      limitations.unshift(`上游查询不完整: ${queryError}`);
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
      uniqueTypeMatch,
      typeMatchCount,
    };

    if (queryComplete) {
      await this.cache.set(cacheKey, result, { fingerprint, ttlMs: 1000 * 60 * 5 });
    }
    return result;
  }

  /**
   * wincode_find_references: Serena when usable, else word-boundary text scan with limitations.
   */
  async findReferences(symbolName: string, relativePath?: string): Promise<SymbolReference[]> {
    const res = await this.findReferencesDetailed(symbolName, relativePath);
    return res.references;
  }

  async findReferencesDetailed(symbolName: string, relativePath?: string): Promise<FindReferencesResult> {
    const cacheKey = `serena_refs_${symbolName}_${relativePath || 'auto'}_${this.config.workspaceRoot}`;
    const fingerprint = await this.cache.computeWorkspaceFingerprint(this.config.workspaceRoot);

    const cached = await this.cache.get<FindReferencesResult>(cacheKey, fingerprint);
    if (cached && cached.queryComplete !== false) return cached;

    let refs: SymbolReference[] = [];
    let source: 'serena-mcp' | 'serena-adapter-fallback' = 'serena-adapter-fallback';
    let queryComplete = true;
    let queryError: string | undefined;
    let truncated = false;

    await this.ensureConnected().catch(() => false);

    const refToolName = ['find_referencing_symbols', 'find_references', 'get_references'].find((t) =>
      this.serenaTools.has(t)
    );

    if (this.isConnectedToSerena && this.serenaClient && refToolName) {
      try {
        let targetRelPath = relativePath;
        let targetNamePath = symbolName;

        // Serena's find_referencing_symbols requires relative_path.
        // If not supplied, resolve symbol definition first to determine defining file & name_path.
        if (!targetRelPath) {
          const found = await this.findSymbols(symbolName);
          const matched = found.find((s) => s.name === symbolName) || found[0];
          if (matched?.file) {
            targetRelPath = matched.file;
            if (matched.containerName) {
              targetNamePath = `${matched.containerName}/${matched.name}`;
            }
          }
        }

        if (targetRelPath) {
          const serenaRes = await this.callSerenaTool(refToolName, {
            name_path: targetNamePath,
            relative_path: targetRelPath,
          });

          const rawText = (serenaRes.content as any[])?.[0]?.text;
          const isExplicitError =
            serenaRes.isError ||
            (typeof rawText === 'string' &&
              (rawText.startsWith('Error:') || rawText.includes('没有激活项目') || rawText.includes('No active project')));

          if (isExplicitError) {
            queryComplete = false;
            queryError = typeof rawText === 'string' ? rawText : 'Serena MCP returned isError';
            if (typeof rawText === 'string' && (rawText.includes('没有激活项目') || rawText.includes('No active project'))) {
              this.projectActive = false;
            }
            console.warn(`[SerenaAdapter] Serena MCP ${refToolName} returned error:`, rawText);
          } else if (rawText) {
            truncated = rawText.length > 200_000;
            refs = this.mapSerenaReferences(rawText, symbolName);
            source = 'serena-mcp';
            this.projectActive = true;
            if (truncated) {
              queryComplete = false;
              queryError = 'Serena reference response exceeded 200k characters and may be truncated.';
            }
          }
        } else {
          queryComplete = false;
          queryError = `Could not determine relative_path for symbol '${symbolName}'`;
          console.warn(
            `[SerenaAdapter] Could not determine relative_path for symbol '${symbolName}', skipping Serena upstream and falling back to local scanner.`
          );
        }
      } catch (err) {
        queryComplete = false;
        queryError = err instanceof Error ? err.message : String(err);
        console.warn('[SerenaAdapter] Serena MCP call failed, falling back to local reference scanner:', err);
      }
    }

    if (refs.length === 0 && source === 'serena-adapter-fallback') {
      refs = await this.scanReferencesLocally(symbolName);
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
      limitations.unshift(`上游查询不完整: ${queryError}`);
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
    };

    if (queryComplete) {
      await this.cache.set(cacheKey, result, { fingerprint, ttlMs: 1000 * 60 * 5 });
    }
    return result;
  }

  /**
   * Maps Serena MCP response formats to WinCode CodeSymbol schema
   */
  public mapSerenaSymbols(rawText: string, query: string, kindFilter?: string): CodeSymbol[] {
    const symbols: CodeSymbol[] = [];
    try {
      const parsed = JSON.parse(rawText);
      const rawList: any[] = [];

      if (Array.isArray(parsed)) {
        rawList.push(...parsed);
      } else if (parsed && typeof parsed === 'object') {
        if (Array.isArray(parsed.symbols)) {
          rawList.push(...parsed.symbols);
        } else {
          // Support grouped structures like { "Class": [...], "Method": [...] }
          for (const val of Object.values(parsed)) {
            if (Array.isArray(val)) {
              rawList.push(...val);
            } else if (val && typeof val === 'object') {
              rawList.push(val);
            }
          }
        }
      }

      for (const item of rawList) {
        if (!item || typeof item !== 'object') continue;

        // Parse name & containerName from item.name_path or item.name
        let symbolName = item.name;
        let containerName = item.containerName;

        if (!symbolName && item.name_path) {
          const parts = String(item.name_path).split('/');
          const rawName = parts.pop() || '';
          symbolName = rawName.replace(/\[\d+\]$/, '');
          if (parts.length > 0) {
            containerName = parts.join('/');
          }
        }
        symbolName = symbolName || query;

        // Parse file / relative_path
        const file =
          item.relative_path ||
          item.file ||
          item.path ||
          item.location?.uri ||
          item.location?.relative_path ||
          '';

        // Parse line / body_location
        const line =
          item.body_location?.start_line ||
          item.line ||
          item.location?.range?.start?.line ||
          item.body_location?.start ||
          1;

        // Parse kind
        const kind = (item.kind || 'class').toLowerCase();

        // Parse signature / info
        const signature =
          item.signature ||
          item.preview ||
          (typeof item.info === 'string' ? item.info : item.info?.description) ||
          undefined;

        symbols.push({
          name: symbolName,
          kind: kind as any,
          file,
          line: typeof line === 'number' ? line : parseInt(String(line), 10) || 1,
          signature,
          containerName,
        });
      }
    } catch {
      // If plaintext output from Serena, parse line by line
      const lines = rawText.split(/\r?\n/);
      for (const l of lines) {
        const match = l.match(/(?:Symbol|Function|Class|Method):\s*([A-Za-z0-9_]+)\s+in\s+([^\s:]+):(\d+)/i);
        if (match) {
          symbols.push({
            name: match[1],
            kind: 'class',
            file: match[2],
            line: parseInt(match[3], 10),
            signature: l.trim(),
          });
        }
      }
    }

    if (kindFilter) {
      return symbols.filter((s) => s.kind.toLowerCase() === kindFilter.toLowerCase());
    }
    return symbols;
  }

  /**
   * Maps Serena MCP response formats to WinCode SymbolReference schema
   */
  public mapSerenaReferences(rawText: string, symbolName: string): SymbolReference[] {
    const refs: SymbolReference[] = [];
    try {
      const parsed = JSON.parse(rawText);

      const collectRefs = (node: any, currentPath = '') => {
        if (!node) return;

        if (Array.isArray(node)) {
          for (const item of node) {
            collectRefs(item, currentPath);
          }
          return;
        }

        if (typeof node === 'object') {
          // Detect if this object itself represents a reference leaf node
          const hasRefSignal =
            node.content_around_reference !== undefined ||
            node.body_location !== undefined ||
            node.reference_line !== undefined ||
            node.snippet !== undefined ||
            node.line_content !== undefined ||
            (node.preview !== undefined && (node.file || node.relative_path || currentPath));

          if (hasRefSignal) {
            const file = node.relative_path || node.file || node.path || currentPath || '';
            const line =
              node.reference_line ||
              node.body_location?.start_line ||
              node.line ||
              node.location?.range?.start?.line ||
              1;
            const preview =
              node.content_around_reference ||
              node.preview ||
              node.snippet ||
              node.line_content ||
              (node.name_path ? `Reference in ${node.name_path}` : '');

            refs.push({
              symbolName,
              file,
              line: typeof line === 'number' ? line : parseInt(String(line), 10) || 1,
              preview: String(preview).trim(),
            });
            return;
          }

          if (Array.isArray(node.references)) {
            collectRefs(node.references, currentPath);
            return;
          }

          for (const [key, value] of Object.entries(node)) {
            // Check if key is a file path (has extension or path separator)
            const isPathLike =
              !currentPath && (key.includes('/') || key.includes('\\') || /\.[a-zA-Z0-9]+$/i.test(key));
            const nextPath = isPathLike ? key : currentPath;
            collectRefs(value, nextPath);
          }
        }
      };

      collectRefs(parsed);
    } catch {
      // Plain text fallback parsing
      const lines = rawText.split(/\r?\n/);
      for (const l of lines) {
        const match = l.match(/([^\s:]+):(\d+):\s*(.*)/);
        if (match) {
          refs.push({
            symbolName,
            file: match[1],
            line: parseInt(match[2], 10),
            preview: match[3].trim(),
          });
        }
      }
    }
    return refs;
  }

  /**
   * Local regex symbol scan (C#, TypeScript/JS, Python). Not AST, LSP, or Roslyn.
   */
  private async scanSymbolsLocally(query: string, kindFilter?: string): Promise<CodeSymbol[]> {
    const root = this.config.workspaceRoot;
    const results: CodeSymbol[] = [];
    const lowerQuery = query.toLowerCase();
    const deadline = Date.now() + this.timeouts.fileScanMs;

    const ignoredDirs = new Set(['node_modules', 'bin', 'obj', 'dist', '.git', '.vs', 'trash', '.cache', '.deps', '.packages', '.dotnet', '.dotnet_cli_home']);

    const walk = async (dir: string): Promise<void> => {
      if (Date.now() > deadline) return;
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (Date.now() > deadline) return;
        if (ignoredDirs.has(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (['.cs', '.ts', '.js', '.py'].includes(ext)) {
            const relPath = path.relative(root, fullPath);
            try {
              const content = await fs.readFile(fullPath, 'utf-8');
              const fileSymbols = this.parseFileSymbols(content, relPath, ext);

              for (const sym of fileSymbols) {
                if (sym.name.toLowerCase().includes(lowerQuery)) {
                  if (!kindFilter || sym.kind.toLowerCase() === kindFilter.toLowerCase()) {
                    results.push(sym);
                  }
                }
              }
            } catch {
              // Ignore unreadable
            }
          }
        }
      }
    };

    await walk(root);
    return results;
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

  private async scanReferencesLocally(symbolName: string): Promise<SymbolReference[]> {
    const root = this.config.workspaceRoot;
    const refs: SymbolReference[] = [];
    const ignoredDirs = new Set(['node_modules', 'bin', 'obj', 'dist', '.git', '.vs', 'trash', '.cache', '.deps', '.packages', '.dotnet', '.dotnet_cli_home']);
    const deadline = Date.now() + this.timeouts.fileScanMs;

    const regex = new RegExp(`\\b${escapeRegExp(symbolName)}\\b`);

    const walk = async (dir: string): Promise<void> => {
      if (Date.now() > deadline) return;
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (Date.now() > deadline) return;
        if (ignoredDirs.has(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          const codeExts = ['.cs', '.ts', '.tsx', '.js', '.jsx', '.py', '.xaml', '.xml', '.csproj', '.sln'];
          if (codeExts.includes(ext)) {
            const relPath = path.relative(root, fullPath);
            try {
              const content = await fs.readFile(fullPath, 'utf-8');
              const lines = content.split(/\r?\n/);

              for (let i = 0; i < lines.length; i++) {
                const trimmed = lines[i].trim();
                // Exclude pure comments and documentation lines
                if (
                  trimmed.startsWith('//') ||
                  trimmed.startsWith('///') ||
                  trimmed.startsWith('*') ||
                  trimmed.startsWith('/*') ||
                  trimmed.startsWith('#') ||
                  trimmed.startsWith('<!--')
                ) {
                  continue;
                }

                const isDeclaration = new RegExp(
                  String.raw`(^|\s)(class|interface|struct|enum)\s+${escapeRegExp(symbolName)}\b`
                ).test(trimmed);
                if (isDeclaration) {
                  continue;
                }

                if (regex.test(lines[i])) {
                  refs.push({
                    symbolName,
                    file: relPath,
                    line: i + 1,
                    preview: trimmed,
                  });
                  if (refs.length >= 200) return;
                }
              }
            } catch {
              // Ignore unreadable
            }
          }
        }
      }
    };

    await walk(root);
    return refs;
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
    try {
      // Kill the process tree first, while cmd.exe still parents grandchildren.
      if (pid) {
        await killProcessTree({ pid });
      }
      await this.closeClientAndTransport(client, transport);
    } finally {
      this.disposing = false;
    }
  }

  private async closeClientAndTransport(
    client: Client | null,
    transport: StdioClientTransport | null
  ): Promise<void> {
    const prePid = transport?.pid;
    if (prePid) {
      await killProcessTree({ pid: prePid }).catch(() => {});
    }
    if (client) {
      try {
        await withTimeout(client.close(), 2000, 'serena-client-close');
      } catch {
        // ignore
      }
    }
    if (transport) {
      try {
        await withTimeout(transport.close(), 2000, 'serena-transport-close');
      } catch {
        // ignore
      }
    }
    const postPid = transport?.pid;
    if (postPid && postPid !== prePid) {
      await killProcessTree({ pid: postPid }).catch(() => {});
    }
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
