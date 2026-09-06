import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export interface CacheEntry<T> {
  timestamp: number;
  ttlMs?: number;
  fingerprint?: string;
  data: T;
}

export class CacheManager {
  private cacheDir: string;
  private memoryCache: Map<string, CacheEntry<unknown>> = new Map();
  private maxMemoryEntries: number;
  private maxDiskEntries: number;
  private writeCount = 0;

  constructor(cacheDir: string, maxMemoryEntries = 500, maxDiskEntries = 500) {
    this.cacheDir = cacheDir;
    this.maxMemoryEntries = maxMemoryEntries;
    this.maxDiskEntries = maxDiskEntries;
  }

  async initialize(): Promise<void> {
    try {
      await fs.mkdir(this.cacheDir, { recursive: true });
      await this.pruneDiskCache();
    } catch {
      // Ignore if directory already exists
    }
  }

  get memoryEntryCount(): number {
    return this.memoryCache.size;
  }

  /**
   * Generates a safe filename for a cache key
   */
  private getCacheFilePath(key: string): string {
    const hash = crypto.createHash('sha256').update(key).digest('hex').substring(0, 16);
    const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 32);
    return path.join(this.cacheDir, `${safeKey}_${hash}.json`);
  }

  /**
   * Retrieves data from memory or disk cache with LRU access refresh
   */
  async get<T>(key: string, currentFingerprint?: string): Promise<T | null> {
    const now = Date.now();

    // Check memory cache first
    const memEntry = this.memoryCache.get(key);
    if (memEntry) {
      if (memEntry.ttlMs && now - memEntry.timestamp > memEntry.ttlMs) {
        this.memoryCache.delete(key);
      } else if (!currentFingerprint || memEntry.fingerprint === currentFingerprint) {
        // LRU: Refresh access order (move to end of Map)
        this.memoryCache.delete(key);
        this.memoryCache.set(key, memEntry);
        return memEntry.data as T;
      }
    }

    // Check disk cache
    const filePath = this.getCacheFilePath(key);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const entry: CacheEntry<T> = JSON.parse(content);

      if (entry.ttlMs && now - entry.timestamp > entry.ttlMs) {
        await fs.unlink(filePath).catch(() => {});
        return null;
      }

      if (currentFingerprint && entry.fingerprint !== currentFingerprint) {
        return null;
      }

      // Populate memory cache with LRU bound
      this.setMemoryEntry(key, entry);
      return entry.data;
    } catch {
      return null;
    }
  }

  /**
   * Saves data into memory and disk cache with LRU capacity eviction
   */
  async set<T>(key: string, data: T, options?: { ttlMs?: number; fingerprint?: string }): Promise<void> {
    const entry: CacheEntry<T> = {
      timestamp: Date.now(),
      ttlMs: options?.ttlMs,
      fingerprint: options?.fingerprint,
      data,
    };

    this.setMemoryEntry(key, entry);

    const filePath = this.getCacheFilePath(key);
    try {
      await fs.mkdir(this.cacheDir, { recursive: true });
      await fs.writeFile(filePath, JSON.stringify(entry, null, 2), 'utf-8');
      this.writeCount++;

      // Periodically prune disk cache (every 50 writes)
      if (this.writeCount % 50 === 0) {
        await this.pruneDiskCache();
        this.pruneExpiredMemory();
      }
    } catch (err) {
      console.warn(`[CacheManager] Failed to write cache to ${filePath}:`, err);
    }
  }

  /**
   * Internal helper to insert memory entry with LRU bound enforcement
   */
  private setMemoryEntry(key: string, entry: CacheEntry<unknown>): void {
    if (this.memoryCache.has(key)) {
      this.memoryCache.delete(key);
    } else if (this.memoryCache.size >= this.maxMemoryEntries) {
      // Proactively clear expired entries first before evicting valid entries
      this.pruneExpiredMemory();

      // If still at capacity, evict the oldest (first key in Map)
      if (this.memoryCache.size >= this.maxMemoryEntries) {
        const oldestKey = this.memoryCache.keys().next().value;
        if (oldestKey !== undefined) {
          this.memoryCache.delete(oldestKey);
        }
      }
    }
    this.memoryCache.set(key, entry);
  }

  /**
   * Proactively sweeps and removes expired entries from memory cache
   */
  pruneExpiredMemory(): void {
    const now = Date.now();
    for (const [key, entry] of this.memoryCache.entries()) {
      if (entry.ttlMs && now - entry.timestamp > entry.ttlMs) {
        this.memoryCache.delete(key);
      }
    }
  }

  /**
   * Prunes disk cache files to stay within maxDiskEntries
   */
  async pruneDiskCache(): Promise<void> {
    try {
      const files = await fs.readdir(this.cacheDir);
      const jsonFiles = files.filter((f) => f.endsWith('.json'));
      if (jsonFiles.length <= this.maxDiskEntries) return;

      const stats = await Promise.all(
        jsonFiles.map(async (f) => {
          const fullPath = path.join(this.cacheDir, f);
          try {
            const s = await fs.stat(fullPath);
            return { fullPath, mtimeMs: s.mtimeMs };
          } catch {
            return null;
          }
        })
      );

      const valid = stats.filter((s): s is { fullPath: string; mtimeMs: number } => s !== null);
      valid.sort((a, b) => a.mtimeMs - b.mtimeMs); // Oldest first

      const toRemoveCount = valid.length - this.maxDiskEntries;
      for (let i = 0; i < toRemoveCount; i++) {
        await fs.unlink(valid[i].fullPath).catch(() => {});
      }
    } catch {
      // Ignore disk pruning errors
    }
  }

  /**
   * Computes a quick fingerprint of a workspace based on git status/HEAD and file mtimes
   */
  async computeWorkspaceFingerprint(workspaceRoot: string): Promise<string> {
    const resolvedRoot = path.resolve(workspaceRoot);

    try {
      const gitPath = path.join(resolvedRoot, '.git');
      const hasGit = await fs.stat(gitPath).catch(() => null);

      if (hasGit) {
        // 1. Try Git CLI for accurate commit & working tree state
        try {
          const [headRes, statusRes] = await Promise.all([
            execAsync('git rev-parse HEAD', { cwd: resolvedRoot, windowsHide: true, timeout: 3000 }).catch(() => ({ stdout: '' })),
            execAsync('git status --porcelain', { cwd: resolvedRoot, windowsHide: true, timeout: 5000 }),
          ]);
          const headCommit = headRes.stdout.trim();
          const gitStatusRaw = statusRes.stdout;

          let branchRef = '';
          if (!headCommit) {
            try {
              const headContent = await fs.readFile(path.join(resolvedRoot, '.git', 'HEAD'), 'utf-8');
              branchRef = headContent.trim();
            } catch {}
          }

          const lines = gitStatusRaw.split(/\r?\n/).filter((l) => l.length >= 4);
          const linesToStat = lines.slice(0, 100);

          const fileStats = await Promise.all(
            linesToStat.map(async (line) => {
              const statusType = line.substring(0, 2);
              const rawPathPart = line.substring(3).trim();
              const targetPath = rawPathPart.includes(' -> ')
                ? rawPathPart.split(' -> ').pop()!.trim()
                : rawPathPart;
              const cleanPath = targetPath.replace(/^"|"$/g, '').replace(/\\"/g, '"');
              const fullPath = path.resolve(resolvedRoot, cleanPath);
              try {
                const stat = await fs.stat(fullPath);
                return `${statusType}:${cleanPath}:${stat.mtimeMs}:${stat.size}`;
              } catch {
                return `${statusType}:${cleanPath}:deleted`;
              }
            })
          );

          const payload = [
            headCommit || branchRef || 'no-head',
            lines.length.toString(),
            ...fileStats,
          ].join('|');

          return crypto.createHash('sha1').update(payload).digest('hex');
        } catch {
          // Git CLI failed, fall through to filesystem git parsing
          try {
            const gitHeadPath = path.join(resolvedRoot, '.git', 'HEAD');
            const gitHead = await fs.readFile(gitHeadPath, 'utf-8').catch(() => null);
            if (gitHead) {
              let commitRef = gitHead.trim();
              const match = commitRef.match(/ref:\s*refs\/heads\/([^\r\n]+)/);
              if (match) {
                const branchPath = path.join(resolvedRoot, '.git', 'refs', 'heads', match[1]);
                const branchCommit = await fs.readFile(branchPath, 'utf-8').catch(() => null);
                if (branchCommit) {
                  commitRef = branchCommit.trim();
                }
              }
              let indexStat = '';
              try {
                const s = await fs.stat(path.join(resolvedRoot, '.git', 'index'));
                indexStat = `${s.mtimeMs}:${s.size}`;
              } catch {}

              const dirFp = await this.computeDirectoryFingerprintFallback(resolvedRoot);
              return crypto.createHash('sha1').update(`${commitRef}|${indexStat}|${dirFp}`).digest('hex');
            }
          } catch {}
        }
      }

      // 2. Fallback for plain non-git directories
      return await this.computeDirectoryFingerprintFallback(resolvedRoot);
    } catch {
      return `ts_${Date.now()}`;
    }
  }

  private async computeDirectoryFingerprintFallback(dirPath: string, maxFiles = 100, maxDepth = 3): Promise<string> {
    const ignoredDirs = new Set(['node_modules', 'bin', 'obj', 'dist', '.git', '.vs', 'trash', '.deps', '.packages']);
    const stats: string[] = [];

    const walk = async (currentDir: string, depth: number) => {
      if (depth > maxDepth || stats.length >= maxFiles) return;
      try {
        const entries = await fs.readdir(currentDir, { withFileTypes: true });
        for (const entry of entries) {
          if (stats.length >= maxFiles) break;
          if (entry.isDirectory()) {
            if (!ignoredDirs.has(entry.name) && !entry.name.startsWith('.')) {
              await walk(path.join(currentDir, entry.name), depth + 1);
            }
          } else if (entry.isFile()) {
            try {
              const s = await fs.stat(path.join(currentDir, entry.name));
              stats.push(`${entry.name}:${s.mtimeMs}:${s.size}`);
            } catch {
              stats.push(entry.name);
            }
          }
        }
      } catch {}
    };

    await walk(dirPath, 0);
    return crypto.createHash('sha1').update(stats.join('|')).digest('hex');
  }

  async clear(): Promise<void> {
    this.memoryCache.clear();
    try {
      const files = await fs.readdir(this.cacheDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          await fs.unlink(path.join(this.cacheDir, file)).catch(() => {});
        }
      }
    } catch {
      // Ignore
    }
  }
}
