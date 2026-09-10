import { type OperationContext, checkOperation, rethrowOperationError } from '../Core/OperationContext.js';
import { spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { stripVTControlCharacters } from 'node:util';
import { IAdapter, AdapterHealth, AdapterLastError } from './IAdapter.js';
import { WinCodeConfig, getDefaultTimeouts } from '../Core/Config.js';
import { CacheManager } from '../Core/Cache.js';
import { ResourceManager, TimeoutError, killProcessTree, toExternalOpFailure } from '../Core/ResourceManager.js';

import { RepomixPackOptions, RepomixPackResult } from '../Core/ContextPacking.js';
export type { RepomixPackOptions, RepomixPackResult } from '../Core/ContextPacking.js';

export class RepomixAdapter implements IAdapter {
  readonly name = 'RepomixAdapter';
  readonly description =
    'Repository packing via Repomix CLI when installed; otherwise a capped builtin packer. candidateFiles is a closed set and never dumps the whole tree';

  private config: WinCodeConfig;
  private cache: CacheManager;
  private resources?: ResourceManager;
  private isCliAvailable = false;
  private cliEntry: string | null = null;
  private activeProcesses: Set<ChildProcess> = new Set();
  private healthCache: { at: number; value: AdapterHealth } | null = null;
  private inflightPacks = new Map<string, Promise<RepomixPackResult>>();
  lastError: AdapterLastError | null = null;

  constructor(config: WinCodeConfig, cache: CacheManager, resources?: ResourceManager) {
    this.config = config;
    this.cache = cache;
    this.resources = resources;
  }

  get activeProcessCount(): number {
    return this.activeProcesses.size;
  }

  async initialize(): Promise<void> {
    const health = await this.checkHealth();
    this.isCliAvailable = health.available && health.source === 'installed';
  }

  getKnownHealth(): { observedAt: string | null; health: AdapterHealth | null } {
    if (!this.config.adapters.repomix.useCli) return { observedAt: null, health: {
      available: true, source: 'fallback' as const, details: 'Repomix CLI disabled by configuration; builtin packer available.',
    } };
    return { observedAt: this.healthCache ? new Date(this.healthCache.at).toISOString() : null,
      health: this.healthCache ? { ...this.healthCache.value, lastError: this.lastError ?? this.healthCache.value.lastError } : null };
  }

  async checkHealth(timeoutMs?: number): Promise<AdapterHealth> {
    // Configuration is authoritative even when an earlier probe found an installed CLI.
    if (!this.config.adapters.repomix.useCli) {
      this.isCliAvailable = false;
      this.cliEntry = null;
      this.healthCache = null;
      return {
        available: true,
        source: 'fallback',
        details: 'Repomix CLI disabled by configuration; using WinCode built-in resilient context packer',
      };
    }
    const defaultMs = this.config.timeouts?.repomixHealthMs ?? getDefaultTimeouts().repomixHealthMs;
    const waitMs = timeoutMs ?? defaultMs;
    // Explicit timeout (tests / force) bypasses the short health memo.
    if (timeoutMs === undefined && this.healthCache && Date.now() - this.healthCache.at < 30_000) {
      return this.healthCache.value;
    }

    this.cliEntry = await this.resolveCliEntry();
    if (!this.config.adapters.repomix.useCli) return this.checkHealth(timeoutMs);
    if (!this.cliEntry) {
      this.isCliAvailable = false;
      const health: AdapterHealth = { available: true, source: 'fallback',
        details: 'Repomix JavaScript CLI entry not found; using builtin packer. Install locally or configure an absolute customCliPath (.js/.cjs/.mjs); npx caches and shell wrappers are not executed.' };
      this.healthCache = { at: Date.now(), value: health };
      return health;
    }
    const health = await new Promise<AdapterHealth>((resolve) => {
      let isSettled = false;
      const proc = spawn(process.execPath, [this.cliEntry!, '--version'], {
        cwd: this.config.workspaceRoot,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'ignore'],
      });

      this.trackProcess(proc);

      const timer = setTimeout(async () => {
        if (isSettled) return;
        isSettled = true;
        this.untrackProcess(proc);
        await killProcessTree(proc).catch(() => {});
        this.lastError = {
          at: new Date().toISOString(),
          reason: 'timeout',
          message: `Repomix CLI health check timed out (${waitMs}ms)`,
          recoverable: true,
        };
        resolve({
          available: true,
          source: 'fallback',
          details: `Repomix CLI health check timed out (${waitMs}ms); using WinCode built-in resilient context packer`,
          lastError: this.lastError,
        });
      }, waitMs);

      let stdout = '';
      proc.stdout?.on('data', (d) => { stdout = (stdout + d.toString()).slice(0, 4096); });

      proc.on('close', (code) => {
        if (isSettled) return;
        isSettled = true;
        clearTimeout(timer);
        this.untrackProcess(proc);

        if (code === 0 && stdout.trim()) {
          resolve({
            available: true,
            version: stdout.trim(),
            source: 'installed',
            details: `Repomix CLI is available (${stdout.trim()})`,
          });
        } else {
          resolve({
            available: true,
            source: 'fallback',
            details: 'Repomix CLI not installed; using WinCode built-in resilient context packer',
          });
        }
      });

      proc.on('error', (err) => {
        if (isSettled) return;
        isSettled = true;
        clearTimeout(timer);
        this.untrackProcess(proc);
        this.lastError = {
          at: new Date().toISOString(),
          reason: 'error',
          message: err.message,
          recoverable: true,
        };
        resolve({
          available: true,
          source: 'fallback',
          details: 'Repomix execution error; using WinCode built-in resilient context packer',
          lastError: this.lastError,
        });
      });
    });

    this.healthCache = { at: Date.now(), value: health };
    this.isCliAvailable = health.source === 'installed';
    return health;
  }

  private async resolveCliEntry(): Promise<string | null> {
    const validEntry = async (entry: string): Promise<string | null> => {
      if (!path.isAbsolute(entry) || !/\.(?:cjs|mjs|js)$/i.test(entry)) return null;
      return await fs.stat(entry).then(stat => stat.isFile() ? entry : null).catch(() => null);
    };
    const custom = this.config.adapters.repomix.customCliPath;
    // An invalid explicit override must not silently launch a different installation.
    if (custom !== undefined) return validEntry(custom);
    const searchPaths = new Set([
      ...(createRequire(path.join(this.config.workspaceRoot, 'package.json')).resolve.paths('repomix') ?? []),
      ...(createRequire(import.meta.url).resolve.paths('repomix') ?? []),
    ]);
    for (const base of searchPaths) {
      const packageRoot = path.join(base, 'repomix');
      try {
        const manifestPath = path.join(packageRoot, 'package.json');
        if ((await fs.stat(manifestPath)).size > 64 * 1024) continue;
        const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
        const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.repomix;
        if (manifest.name !== 'repomix' || typeof bin !== 'string' || path.isAbsolute(bin)) continue;
        const entry = path.resolve(packageRoot, bin);
        const relative = path.relative(packageRoot, entry);
        if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
        const realRoot = await fs.realpath(packageRoot);
        const realEntry = await fs.realpath(entry);
        const realRelative = path.relative(realRoot, realEntry);
        if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) continue;
        if (await validEntry(realEntry)) return realEntry;
      } catch { /* Missing or malformed packages leave the builtin packer available. */ }
    }
    return null;
  }

  private trackProcess(proc: ChildProcess): void {
    this.activeProcesses.add(proc);
    this.resources?.registerProcess('repomix', proc);
  }

  private untrackProcess(proc: ChildProcess): void {
    this.activeProcesses.delete(proc);
  }

  /**
   * Packs workspace into a structured AI context snapshot
   */
  async packWorkspace(options?: RepomixPackOptions, operation?: OperationContext): Promise<RepomixPackResult> {
    checkOperation(operation);
    const allowCli = this.config.adapters.repomix.useCli;
    // CLI output has no verified input manifest. Only the builtin path caches, after reading its actual inputs.
    const result = await this.packWorkspaceUncached(options, allowCli, operation);
    checkOperation(operation);
    return result.contentOmitted ? result : this.spillIfOversized(result);
  }

  private async packWorkspaceUncached(options: RepomixPackOptions | undefined, allowCli: boolean, operation?: OperationContext): Promise<RepomixPackResult> {
    // Explicit candidate list is a closed set — never fall through to a full-repo CLI pack.
    if (Array.isArray(options?.candidateFiles)) {
      return this.packWithFallback(options, operation);
    }
    if (allowCli && this.config.adapters.repomix.useCli && this.isCliAvailable) {
      try {
        return await this.packWithCli(options, operation);
      } catch (err) {
        rethrowOperationError(err, operation);
        const failure = toExternalOpFailure(err, 'repomix');
        this.lastError = {
          at: new Date().toISOString(),
          reason: failure.reason,
          message: failure.message,
          recoverable: true,
        };
        console.warn('[RepomixAdapter] CLI packing failed, falling back to built-in packer:', failure.message);
        return this.packWithFallback(options, operation);
      }
    }
    return this.packWithFallback(options, operation);
  }

  /**
   * Invokes official Repomix CLI to generate a repository snapshot
   */
  private async packWithCli(options?: RepomixPackOptions, operation?: OperationContext): Promise<RepomixPackResult> {
    const root = this.config.workspaceRoot;
    const style = options?.outputFormat || 'markdown';
    const tempOutputDir = path.join(this.config.cacheDir, 'repomix_tmp');
    await fs.mkdir(tempOutputDir, { recursive: true });
    checkOperation(operation);
    // Disabling during the preceding await must still prevent the process launch.
    if (!this.config.adapters.repomix.useCli) return this.packWithFallback(options, operation);

    const ext = style === 'xml' ? 'xml' : 'md';
    const tempOutputFile = path.join(tempOutputDir, `repomix_${crypto.randomUUID()}.${ext}`);
    const entry = this.cliEntry;
    if (!entry) throw new Error('Repomix CLI entry has not passed its health check');

    const args = [
      entry,
      '--style',
      style,
      '-o',
      tempOutputFile,
      '-i',
      'trash/**,**/.cache/**,**/bin/**,**/obj/**,package-lock.json,yarn.lock,pnpm-lock.yaml,cargo.lock',
    ];

    if (options?.include && options.include.length > 0) {
      args.push('--include', options.include.join(','));
    }

    if (options?.compress) {
      args.push('--compress');
    }

    return new Promise((resolve, reject) => {
      let isSettled = false;
      const proc = spawn(process.execPath, args, {
        cwd: root,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.trackProcess(proc);

      let stderr = '';
      let stdout = '';
      proc.stdout?.on('data', (d) => { stdout = (stdout + d.toString()).slice(-16384); });
      proc.stderr?.on('data', (d) => { stderr = (stderr + d.toString()).slice(-4096); });

      const packTimeoutMs = this.config.timeouts?.repomixPackMs ?? 30_000;
      const cancel = async () => {
        if (isSettled) return;
        isSettled = true;
        clearTimeout(timeout);
        operation?.signal?.removeEventListener('abort', cancel);
        try {
          await killProcessTree(proc);
          this.untrackProcess(proc);
          await fs.unlink(tempOutputFile).catch(() => {});
          checkOperation(operation);
        } catch (error) { reject(error); }
      };
      const timeout = setTimeout(async () => {
        if (isSettled) return;
        isSettled = true;
        operation?.signal?.removeEventListener('abort', cancel);
        this.untrackProcess(proc);
        await killProcessTree(proc).catch(() => {});
        await fs.unlink(tempOutputFile).catch(() => {});
        reject(new TimeoutError('repomix', packTimeoutMs));
      }, packTimeoutMs);
      operation?.signal?.addEventListener('abort', cancel, { once: true });
      if (operation?.signal?.aborted) void cancel();

      proc.on('close', async (code) => {
        if (isSettled) return;
        isSettled = true;
        clearTimeout(timeout);
        operation?.signal?.removeEventListener('abort', cancel);
        this.untrackProcess(proc);

        try {
          if (code === 0) {
            const content = await fs.readFile(tempOutputFile, 'utf-8');
            await fs.unlink(tempOutputFile).catch(() => {});

            // Output bodies and format explanations can contain fake file headers.
            // Use the CLI's separate count; an unsupported/missing summary falls
            // back instead of inventing a nonzero count for an empty snapshot.
            const counts = [...stripVTControlCharacters(stdout).matchAll(/^\s*Total Files: (\d+(?:,\d{3})*) files\s*$/gm)];
            const fileCount = counts.length === 1 ? Number(counts[0][1].replaceAll(',', '')) : NaN;
            if (!Number.isSafeInteger(fileCount) || fileCount < 0)
              throw new Error('Repomix CLI did not provide a supported file-count summary.');

            resolve({
              content,
              fileCount,
              totalCharacters: content.length,
              fromCache: false,
              source: 'repomix-cli',
            });
          } else {
            await fs.unlink(tempOutputFile).catch(() => {});
            reject(new Error(`Repomix exited with code ${code}: ${stderr}`));
          }
        } catch (e) {
          reject(e);
        }
      });

      proc.on('error', (err) => {
        if (isSettled) return;
        isSettled = true;
        clearTimeout(timeout);
        operation?.signal?.removeEventListener('abort', cancel);
        this.untrackProcess(proc);
        reject(err);
      });
    });
  }

  /**
   * Resilient built-in context packer when Repomix CLI is not present or fails
   */
  private async packWithFallback(options?: RepomixPackOptions, operation?: OperationContext): Promise<RepomixPackResult> {
    const root = this.config.workspaceRoot;
    const maxFiles = options?.maxFiles ?? 50;
    const collectedFiles: { relPath: string; content: string }[] = [];

    // Closed candidate set: even an empty array means "only these files", never the whole tree.
    if (Array.isArray(options?.candidateFiles)) {
      for (const cand of options.candidateFiles) {
        checkOperation(operation);
        if (collectedFiles.length >= maxFiles) break;
        const fullPath = path.isAbsolute(cand) ? cand : path.join(root, cand);
        try {
          const stat = await fs.stat(fullPath);
          if (stat.isFile() && stat.size < 500_000) {
            const relPath = path.relative(root, fullPath).replace(/\\/g, '/');
            const content = await fs.readFile(fullPath, { encoding: 'utf8', signal: operation?.signal });
            collectedFiles.push({ relPath, content });
          }
        } catch (error) {
          rethrowOperationError(error, operation);
          // Ignore non-existent candidate files
        }
      }
      checkOperation(operation);
      return this.cacheCollectedFiles(collectedFiles, root, options, operation);
    }

    const defaultExcludes = new Set([
      'node_modules',
      'dist',
      'bin',
      'obj',
      '.git',
      '.vs',
      'trash',
      '.cache',
      '.deps',
      '.packages',
      '.dotnet',
      '.dotnet_cli_home',
      'package-lock.json',
      'yarn.lock',
      'pnpm-lock.yaml',
      'cargo.lock',
    ]);

    // Normalize include patterns / focusAreas
    const normalizedIncludes = (options?.include || []).map((inc) =>
      inc.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '').toLowerCase()
    );

    const walk = async (dir: string): Promise<void> => {
      checkOperation(operation);
      if (collectedFiles.length >= maxFiles) return;

      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        checkOperation(operation);
        // [P2 Fix]: Stop walking immediately when maxFiles reached
        if (collectedFiles.length >= maxFiles) break;

        if (defaultExcludes.has(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        const relDirOrFile = path.relative(root, fullPath).replace(/\\/g, '/').toLowerCase();

        if (entry.isDirectory()) {
          // Check if directory matches or can contain include patterns
          if (normalizedIncludes.length > 0) {
            const matchesDir = normalizedIncludes.some(
              (inc) => inc.startsWith(relDirOrFile) || relDirOrFile.startsWith(inc)
            );
            if (!matchesDir) continue;
          }
          await walk(fullPath);
        } else if (entry.isFile()) {
          // Check if file matches include patterns
          if (normalizedIncludes.length > 0) {
            const matchesFile = normalizedIncludes.some(
              (inc) => relDirOrFile.startsWith(inc) || relDirOrFile.includes(inc)
            );
            if (!matchesFile) continue;
          }

          const ext = path.extname(entry.name).toLowerCase();
          const codeExts = ['.ts', '.js', '.cs', '.py', '.json', '.md', '.xml', '.xaml', '.csproj', '.sln'];
          if (codeExts.includes(ext) || entry.name.toLowerCase() === 'dockerfile') {
            const relPath = path.relative(root, fullPath).replace(/\\/g, '/');
            try {
              const stat = await fs.stat(fullPath);
              if (stat.size < 250_000) {
                const content = await fs.readFile(fullPath, { encoding: 'utf8', signal: operation?.signal });
                collectedFiles.push({ relPath, content });
                // [P2 Fix]: Stop immediately when maxFiles reached
                if (collectedFiles.length >= maxFiles) break;
              }
            } catch (error) {
              rethrowOperationError(error, operation);
              // Ignore unreadable
            }
          }
        }
      }
    };

    await walk(root);

    checkOperation(operation);
    return this.cacheCollectedFiles(collectedFiles, root, options, operation);
  }

  private async cacheCollectedFiles(files: { relPath: string; content: string }[], root: string,
    options?: RepomixPackOptions, operation?: OperationContext): Promise<RepomixPackResult> {
    // Length-delimited tuples bind both file selection and the exact bytes decoded for this pack.
    const digest = crypto.createHash('sha256');
    for (const file of files) digest.update(JSON.stringify([file.relPath, file.content]));
    const fingerprint = digest.digest('hex');
    const cacheKey = `repomix_inputs_v1_${root}_${JSON.stringify(options ?? {})}`;
    const cached = await this.cache.get<RepomixPackResult>(cacheKey, fingerprint);
    checkOperation(operation);
    if (cached) return { ...cached, fromCache: true };
    const inflightKey = `${cacheKey}:${fingerprint}`;
    const existing = this.inflightPacks.get(inflightKey);
    if (!operation && existing) return { ...await existing, fromCache: true };
    const pending = (async () => {
      const result = await this.spillIfOversized(this.formatPackedResult(files, root, options?.outputFormat));
      checkOperation(operation);
      await this.cache.set(cacheKey, result, { fingerprint, ttlMs: 600_000 });
      return result;
    })();
    if (!operation) this.inflightPacks.set(inflightKey, pending);
    try { return await pending; }
    finally { if (!operation) this.inflightPacks.delete(inflightKey); }
  }

  /**
   * Oversized snapshots go to disk; the in-memory result keeps a preview only.
   * Matches the v0.5 rule: do not retain hundred-MB strings in the Node heap.
   */
  private async spillIfOversized(result: RepomixPackResult): Promise<RepomixPackResult> {
    const limit = this.cache.maxEntryByteLimit;
    const bytes = this.cache.estimateBytes(result.content);
    if (bytes <= limit) return result;

    const overflowPath = await this.cache.writeOverflow(result.content);
    const previewChars = Math.min(result.content.length, 2_000);
    return {
      ...result,
      content:
        result.content.slice(0, previewChars) +
        `\n\n[content omitted from heap; ${result.totalCharacters} chars written to ${overflowPath}]`,
      overflowPath,
      contentOmitted: true,
    };
  }

  /**
   * Formats collected files into XML or Markdown
   */
  private formatPackedResult(
    collectedFiles: { relPath: string; content: string }[],
    root: string,
    outputFormat?: string
  ): RepomixPackResult {
    let output = '';
    const fileSpans: NonNullable<RepomixPackResult['fileSpans']> = [];

    // [P2 Fix]: True XML format generation when requested
    if (outputFormat === 'xml') {
      output = `<?xml version="1.0" encoding="UTF-8"?>\n`;
      output += `<project_context root="${root}" total_files="${collectedFiles.length}">\n`;
      for (const file of collectedFiles) {
        output += `  <file path="${file.relPath}">\n<![CDATA[\n`;
        fileSpans.push({ file: file.relPath, start: output.length, end: output.length + file.content.length });
        output += `${file.content}\n]]>\n  </file>\n`;
      }
      output += `</project_context>\n`;
    } else {
      output = `# Project Context Snapshot\n\n`;
      output += `Workspace Root: ${root}\n`;
      output += `Total Packed Files: ${collectedFiles.length}\n\n`;

      for (const file of collectedFiles) {
        output += `================================================\n`;
        output += `File: ${file.relPath}\n`;
        output += `================================================\n`;
        fileSpans.push({ file: file.relPath, start: output.length, end: output.length + file.content.length });
        output += file.content + `\n\n`;
      }
    }

    return {
      content: output,
      fileCount: collectedFiles.length,
      totalCharacters: output.length,
      fromCache: false,
      source: 'builtin-fallback',
      fileSpans,
    };
  }

  async dispose(): Promise<void> {
    this.healthCache = null;
    this.inflightPacks.clear();
    const procs = Array.from(this.activeProcesses);
    const outcomes = await Promise.allSettled(procs.map(async proc => {
      await killProcessTree(proc);
      this.activeProcesses.delete(proc);
    }));
    const failures = outcomes.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Repomix processes failed to close.');
  }
}
