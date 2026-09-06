import { spawn, exec, ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { IAdapter, AdapterHealth } from './IAdapter.js';
import { WinCodeConfig } from '../Core/Config.js';
import { CacheManager } from '../Core/Cache.js';

export interface RepomixPackOptions {
  include?: string[];
  exclude?: string[];
  maxFiles?: number;
  outputFormat?: 'markdown' | 'xml' | 'plain';
  compress?: boolean;
  candidateFiles?: string[];
}

export interface RepomixPackResult {
  content: string;
  fileCount: number;
  totalCharacters: number;
  fromCache: boolean;
  source: 'repomix-cli' | 'builtin-fallback';
}

export class RepomixAdapter implements IAdapter {
  readonly name = 'RepomixAdapter';
  readonly description =
    'Repository packing via Repomix CLI when installed; otherwise a capped builtin packer. candidateFiles is a closed set and never dumps the whole tree';

  private config: WinCodeConfig;
  private cache: CacheManager;
  private isCliAvailable = false;
  private activeProcesses: Set<ChildProcess> = new Set();

  constructor(config: WinCodeConfig, cache: CacheManager) {
    this.config = config;
    this.cache = cache;
  }

  get activeProcessCount(): number {
    return this.activeProcesses.size;
  }

  async initialize(): Promise<void> {
    const health = await this.checkHealth();
    this.isCliAvailable = health.available && health.source === 'installed';
  }

  /**
   * Kills a child process and its entire process tree (especially on Windows)
   */
  private async killProcessTree(proc: ChildProcess): Promise<void> {
    const pid = proc.pid;
    try {
      proc.kill('SIGTERM');
    } catch {}

    if (pid && process.platform === 'win32') {
      await new Promise<void>((resolve) => {
        exec(`taskkill /pid ${pid} /T /F`, { windowsHide: true }, () => resolve());
      });
    } else if (pid) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
    }
  }

  async checkHealth(timeoutMs = 3000): Promise<AdapterHealth> {
    return new Promise((resolve) => {
      let isSettled = false;
      const proc = spawn('cmd', ['/c', 'npx --no-install repomix --version'], {
        cwd: this.config.workspaceRoot,
        windowsHide: true,
      });

      this.activeProcesses.add(proc);

      const timer = setTimeout(async () => {
        if (isSettled) return;
        isSettled = true;
        this.activeProcesses.delete(proc);
        await this.killProcessTree(proc).catch(() => {});
        resolve({
          available: true,
          source: 'fallback',
          details: `Repomix CLI health check timed out (${timeoutMs}ms); using WinCode built-in resilient context packer`,
        });
      }, timeoutMs);

      let stdout = '';
      proc.stdout?.on('data', (d) => (stdout += d.toString()));

      proc.on('close', (code) => {
        if (isSettled) return;
        isSettled = true;
        clearTimeout(timer);
        this.activeProcesses.delete(proc);

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

      proc.on('error', () => {
        if (isSettled) return;
        isSettled = true;
        clearTimeout(timer);
        this.activeProcesses.delete(proc);

        resolve({
          available: true,
          source: 'fallback',
          details: 'Repomix execution error; using WinCode built-in resilient context packer',
        });
      });
    });
  }

  /**
   * Packs workspace into a structured AI context snapshot
   */
  async packWorkspace(options?: RepomixPackOptions): Promise<RepomixPackResult> {
    const cacheKey = `repomix_pack_${JSON.stringify(options || {})}_${this.config.workspaceRoot}`;
    const fingerprint = await this.cache.computeWorkspaceFingerprint(this.config.workspaceRoot);

    const cached = await this.cache.get<RepomixPackResult>(cacheKey, fingerprint);
    if (cached) {
      return { ...cached, fromCache: true };
    }

    let result: RepomixPackResult;

    // Explicit candidate list is a closed set — never fall through to a full-repo CLI pack.
    if (Array.isArray(options?.candidateFiles)) {
      result = await this.packWithFallback(options);
    } else if (this.isCliAvailable) {
      try {
        result = await this.packWithCli(options);
      } catch (err) {
        console.warn('[RepomixAdapter] CLI packing failed, falling back to built-in packer:', err);
        result = await this.packWithFallback(options);
      }
    } else {
      result = await this.packWithFallback(options);
    }

    await this.cache.set(cacheKey, result, { fingerprint, ttlMs: 1000 * 60 * 10 });
    return result;
  }

  /**
   * Invokes official Repomix CLI to generate a repository snapshot
   */
  private async packWithCli(options?: RepomixPackOptions): Promise<RepomixPackResult> {
    const root = this.config.workspaceRoot;
    const style = options?.outputFormat || 'markdown';
    const tempOutputDir = path.join(this.config.cacheDir, 'repomix_tmp');
    await fs.mkdir(tempOutputDir, { recursive: true });

    const ext = style === 'xml' ? 'xml' : 'md';
    const tempOutputFile = path.join(tempOutputDir, `repomix_${Date.now()}.${ext}`);

    const args = [
      '/c',
      'npx',
      '--no-install',
      'repomix',
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
      const proc = spawn('cmd', args, {
        cwd: root,
        windowsHide: true,
      });

      this.activeProcesses.add(proc);

      let stderr = '';
      proc.stderr?.on('data', (d) => (stderr += d.toString()));

      const timeout = setTimeout(async () => {
        if (isSettled) return;
        isSettled = true;
        this.activeProcesses.delete(proc);
        await this.killProcessTree(proc).catch(() => {});
        reject(new Error('Repomix CLI execution timed out after 30s'));
      }, 30000);

      proc.on('close', async (code) => {
        if (isSettled) return;
        isSettled = true;
        clearTimeout(timeout);
        this.activeProcesses.delete(proc);

        try {
          if (code === 0) {
            const content = await fs.readFile(tempOutputFile, 'utf-8');
            await fs.unlink(tempOutputFile).catch(() => {});

            // Count files from content headers
            const fileMatches = content.match(/File: |<file path=/g) || [];
            const fileCount = fileMatches.length;

            resolve({
              content,
              fileCount: fileCount || 1,
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
        this.activeProcesses.delete(proc);
        reject(err);
      });
    });
  }

  /**
   * Resilient built-in context packer when Repomix CLI is not present or fails
   */
  private async packWithFallback(options?: RepomixPackOptions): Promise<RepomixPackResult> {
    const root = this.config.workspaceRoot;
    const maxFiles = options?.maxFiles ?? 50;
    const collectedFiles: { relPath: string; content: string }[] = [];

    // Closed candidate set: even an empty array means "only these files", never the whole tree.
    if (Array.isArray(options?.candidateFiles)) {
      for (const cand of options.candidateFiles) {
        if (collectedFiles.length >= maxFiles) break;
        const fullPath = path.isAbsolute(cand) ? cand : path.join(root, cand);
        try {
          const stat = await fs.stat(fullPath);
          if (stat.isFile() && stat.size < 500_000) {
            const relPath = path.relative(root, fullPath).replace(/\\/g, '/');
            const content = await fs.readFile(fullPath, 'utf-8');
            collectedFiles.push({ relPath, content });
          }
        } catch {
          // Ignore non-existent candidate files
        }
      }
      return this.formatPackedResult(collectedFiles, root, options?.outputFormat);
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
      if (collectedFiles.length >= maxFiles) return;

      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
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
                const content = await fs.readFile(fullPath, 'utf-8');
                collectedFiles.push({ relPath, content });
                // [P2 Fix]: Stop immediately when maxFiles reached
                if (collectedFiles.length >= maxFiles) break;
              }
            } catch {
              // Ignore unreadable
            }
          }
        }
      }
    };

    await walk(root);

    return this.formatPackedResult(collectedFiles, root, options?.outputFormat);
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

    // [P2 Fix]: True XML format generation when requested
    if (outputFormat === 'xml') {
      output = `<?xml version="1.0" encoding="UTF-8"?>\n`;
      output += `<project_context root="${root}" total_files="${collectedFiles.length}">\n`;
      for (const file of collectedFiles) {
        output += `  <file path="${file.relPath}">\n<![CDATA[\n${file.content}\n]]>\n  </file>\n`;
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
        output += file.content + `\n\n`;
      }
    }

    return {
      content: output,
      fileCount: collectedFiles.length,
      totalCharacters: output.length,
      fromCache: false,
      source: 'builtin-fallback',
    };
  }

  async dispose(): Promise<void> {
    const procs = Array.from(this.activeProcesses);
    this.activeProcesses.clear();
    await Promise.all(procs.map((p) => this.killProcessTree(p).catch(() => {})));
  }
}
