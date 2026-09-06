import { spawn } from 'node:child_process';
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
  readonly description = 'Repository context packing and structure extraction via Repomix';

  private config: WinCodeConfig;
  private cache: CacheManager;
  private isCliAvailable = false;

  constructor(config: WinCodeConfig, cache: CacheManager) {
    this.config = config;
    this.cache = cache;
  }

  async initialize(): Promise<void> {
    const health = await this.checkHealth();
    this.isCliAvailable = health.available && health.source === 'installed';
  }

  async checkHealth(): Promise<AdapterHealth> {
    return new Promise((resolve) => {
      const proc = spawn('cmd', ['/c', 'npx repomix --version'], {
        cwd: this.config.workspaceRoot,
        windowsHide: true,
      });

      let stdout = '';
      proc.stdout?.on('data', (d) => (stdout += d.toString()));

      proc.on('close', (code) => {
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

    if (this.isCliAvailable) {
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
      'repomix',
      '--style',
      style,
      '-o',
      tempOutputFile,
      '-i',
      'trash/**,**/.cache/**,**/bin/**,**/obj/**,package-lock.json,yarn.lock,pnpm-lock.yaml,cargo.lock',
    ];

    if (options?.compress) {
      args.push('--compress');
    }

    return new Promise((resolve, reject) => {
      const proc = spawn('cmd', args, {
        cwd: root,
        windowsHide: true,
      });

      let stderr = '';
      proc.stderr?.on('data', (d) => (stderr += d.toString()));

      const timeout = setTimeout(() => {
        proc.kill();
        reject(new Error('Repomix CLI execution timed out after 30s'));
      }, 30000);

      proc.on('close', async (code) => {
        clearTimeout(timeout);
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
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  /**
   * Resilient built-in context packer when Repomix CLI is not present or fails
   */
  private async packWithFallback(options?: RepomixPackOptions): Promise<RepomixPackResult> {
    const root = this.config.workspaceRoot;
    const maxFiles = options?.maxFiles || 50;
    const collectedFiles: { relPath: string; content: string }[] = [];

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
      'package-lock.json',
      'yarn.lock',
      'pnpm-lock.yaml',
      'cargo.lock',
    ]);

    const walk = async (dir: string): Promise<void> => {
      if (collectedFiles.length >= maxFiles) return;

      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (defaultExcludes.has(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          const codeExts = ['.ts', '.js', '.cs', '.py', '.json', '.md', '.xml', '.xaml', '.csproj', '.sln'];
          if (codeExts.includes(ext) || entry.name.toLowerCase() === 'dockerfile') {
            const relPath = path.relative(root, fullPath);
            try {
              const stat = await fs.stat(fullPath);
              if (stat.size < 250_000) {
                const content = await fs.readFile(fullPath, 'utf-8');
                collectedFiles.push({ relPath, content });
              }
            } catch {
              // Ignore unreadable
            }
          }
        }
      }
    };

    await walk(root);

    let output = `# Project Context Snapshot\n\n`;
    output += `Workspace Root: ${root}\n`;
    output += `Total Packed Files: ${collectedFiles.length}\n\n`;

    for (const file of collectedFiles) {
      output += `================================================\n`;
      output += `File: ${file.relPath}\n`;
      output += `================================================\n`;
      output += file.content + `\n\n`;
    }

    return {
      content: output,
      fileCount: collectedFiles.length,
      totalCharacters: output.length,
      fromCache: false,
      source: 'builtin-fallback',
    };
  }

  async dispose(): Promise<void> {}
}
