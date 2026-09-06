import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export interface CacheEntry<T> {
  timestamp: number;
  ttlMs?: number;
  fingerprint?: string;
  data: T;
}

export class CacheManager {
  private cacheDir: string;
  private memoryCache: Map<string, CacheEntry<unknown>> = new Map();

  constructor(cacheDir: string) {
    this.cacheDir = cacheDir;
  }

  async initialize(): Promise<void> {
    try {
      await fs.mkdir(this.cacheDir, { recursive: true });
    } catch {
      // Ignore if directory already exists
    }
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
   * Retrieves data from memory or disk cache
   */
  async get<T>(key: string, currentFingerprint?: string): Promise<T | null> {
    const now = Date.now();

    // Check memory cache first
    const memEntry = this.memoryCache.get(key);
    if (memEntry) {
      if (memEntry.ttlMs && now - memEntry.timestamp > memEntry.ttlMs) {
        this.memoryCache.delete(key);
      } else if (!currentFingerprint || memEntry.fingerprint === currentFingerprint) {
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

      // Populate memory cache
      this.memoryCache.set(key, entry);
      return entry.data;
    } catch {
      return null;
    }
  }

  /**
   * Saves data into memory and disk cache
   */
  async set<T>(key: string, data: T, options?: { ttlMs?: number; fingerprint?: string }): Promise<void> {
    const entry: CacheEntry<T> = {
      timestamp: Date.now(),
      ttlMs: options?.ttlMs,
      fingerprint: options?.fingerprint,
      data,
    };

    this.memoryCache.set(key, entry);

    const filePath = this.getCacheFilePath(key);
    try {
      await fs.mkdir(this.cacheDir, { recursive: true });
      await fs.writeFile(filePath, JSON.stringify(entry, null, 2), 'utf-8');
    } catch (err) {
      console.warn(`[CacheManager] Failed to write cache to ${filePath}:`, err);
    }
  }

  /**
   * Computes a quick fingerprint of a workspace based on git HEAD or critical file mtimes
   */
  async computeWorkspaceFingerprint(workspaceRoot: string): Promise<string> {
    try {
      const gitHeadPath = path.join(workspaceRoot, '.git', 'HEAD');
      const gitHead = await fs.readFile(gitHeadPath, 'utf-8').catch(() => null);
      if (gitHead) {
        return crypto.createHash('sha1').update(gitHead.trim()).digest('hex');
      }

      // If not a git repo, hash directory stat sample
      const entries = await fs.readdir(workspaceRoot, { withFileTypes: true });
      const stats = await Promise.all(
        entries.slice(0, 20).map(async (e) => {
          try {
            const s = await fs.stat(path.join(workspaceRoot, e.name));
            return `${e.name}:${s.mtimeMs}`;
          } catch {
            return e.name;
          }
        })
      );
      return crypto.createHash('sha1').update(stats.join('|')).digest('hex');
    } catch {
      return `ts_${Date.now()}`;
    }
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
