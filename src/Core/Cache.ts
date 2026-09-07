import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { getDefaultCacheLimits, WinCodeCacheLimits } from './Config.js';

const execAsync = promisify(exec);

export interface CacheEntry<T> {
  timestamp: number;
  ttlMs?: number;
  fingerprint?: string;
  data: T;
  byteSize?: number;
}

export interface CacheStats {
  namespace: string;
  memoryEntries: number;
  estimatedMemoryBytes: number;
  diskEntries: number;
  estimatedDiskBytes: number;
}

/**
 * Memory LRU + disk JSON cache with byte caps.
 * Namespace isolates workspaces; fingerprint memo avoids repeating git status
 * on consecutive MCP calls. Values larger than maxEntryBytes are not retained.
 */
export class CacheManager {
  private cacheDir: string;
  private memoryCache: Map<string, CacheEntry<unknown>> = new Map();
  private maxMemoryEntries: number;
  private maxDiskEntries: number;
  private maxMemoryBytes: number;
  private maxDiskBytes: number;
  private maxEntryBytes: number;
  private fingerprintMemoMs: number;
  private writeCount = 0;
  private memoryBytes = 0;
  private namespace = '';
  private writeChain: Promise<void> = Promise.resolve();
  private fpMemo = new Map<string, { value: string; expiresAt: number; cheap: string }>();
  private fpInflight = new Map<string, Promise<string>>();
  private watchGeneration = new Map<string, number>();

  constructor(
    cacheDir: string,
    maxMemoryEntries = 500,
    maxDiskEntries = 500,
    limits?: Partial<WinCodeCacheLimits>
  ) {
    this.cacheDir = cacheDir;
    const defaults = getDefaultCacheLimits();
    this.maxMemoryEntries = limits?.maxMemoryEntries ?? maxMemoryEntries;
    this.maxDiskEntries = limits?.maxDiskEntries ?? maxDiskEntries;
    this.maxMemoryBytes = limits?.maxMemoryBytes ?? defaults.maxMemoryBytes;
    this.maxDiskBytes = limits?.maxDiskBytes ?? defaults.maxDiskBytes;
    this.maxEntryBytes = limits?.maxEntryBytes ?? defaults.maxEntryBytes;
    this.fingerprintMemoMs = limits?.fingerprintMemoMs ?? defaults.fingerprintMemoMs;
  }

  get memoryEntryCount(): number {
    return this.memoryCache.size;
  }

  get estimatedMemoryBytes(): number {
    return this.memoryBytes;
  }

  get currentNamespace(): string {
    return this.namespace;
  }

  get directory(): string {
    return this.cacheDir;
  }

  get maxEntryByteLimit(): number {
    return this.maxEntryBytes;
  }

  /**
   * Isolates keys by workspace so project A symbols cannot be read as project B.
   * Clears the in-memory map so large snapshots from the previous workspace
   * become unreachable for GC. Disk files for the old prefix remain until prune.
   */
  setNamespace(workspaceRoot: string): void {
    const resolved = path.resolve(workspaceRoot);
    this.namespace = crypto.createHash('sha1').update(resolved).digest('hex').slice(0, 12);
    this.memoryCache.clear();
    this.memoryBytes = 0;
    this.fpMemo.clear();
    this.fpInflight.clear();
    this.watchGeneration.clear();
  }

  async initialize(): Promise<void> {
    try {
      await fs.mkdir(this.cacheDir, { recursive: true });
      await this.pruneDiskCache();
    } catch {
      // Ignore if directory already exists
    }
  }

  /**
   * Point this manager at a new directory after workspace_open.
   * Memory is always dropped; the previous disk tree is left for the OS/prune.
   */
  async rebind(newCacheDir: string): Promise<void> {
    this.memoryCache.clear();
    this.memoryBytes = 0;
    this.fpMemo.clear();
    this.fpInflight.clear();
    this.watchGeneration.clear();
    this.cacheDir = newCacheDir;
    await this.initialize();
  }

  private namespacedKey(key: string): string {
    return this.namespace ? `${this.namespace}::${key}` : key;
  }

  private getCacheFilePath(key: string): string {
    const namespaced = this.namespacedKey(key);
    const hash = crypto.createHash('sha256').update(namespaced).digest('hex').substring(0, 16);
    const safeKey = namespaced.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 32);
    return path.join(this.cacheDir, `${safeKey}_${hash}.json`);
  }

  estimateBytes(data: unknown): number {
    if (typeof data === 'string') return data.length * 2;
    if (Buffer.isBuffer(data)) return data.length;
    try {
      return Buffer.byteLength(JSON.stringify(data), 'utf8');
    } catch {
      return 1024;
    }
  }

  /**
   * Retrieves data from memory or disk cache with LRU access refresh.
   * Disk files larger than maxEntryBytes are deleted instead of being loaded.
   */
  async get<T>(key: string, currentFingerprint?: string): Promise<T | null> {
    const now = Date.now();
    const memKey = this.namespacedKey(key);

    const memEntry = this.memoryCache.get(memKey);
    if (memEntry) {
      if (memEntry.ttlMs && now - memEntry.timestamp > memEntry.ttlMs) {
        this.deleteMemory(memKey);
      } else if (!currentFingerprint || memEntry.fingerprint === currentFingerprint) {
        this.memoryCache.delete(memKey);
        this.memoryCache.set(memKey, memEntry);
        return memEntry.data as T;
      }
    }

    const filePath = this.getCacheFilePath(key);
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > this.maxEntryBytes) {
        await fs.unlink(filePath).catch(() => {});
        return null;
      }

      const content = await fs.readFile(filePath, 'utf-8');
      const entry: CacheEntry<T> = JSON.parse(content);

      if (entry.ttlMs && now - entry.timestamp > entry.ttlMs) {
        await fs.unlink(filePath).catch(() => {});
        const p = (entry.data as any)?.overflowPath;
        if (typeof p === 'string') {
          await fs.unlink(path.resolve(p)).catch(() => {});
        }
        return null;
      }

      if (currentFingerprint && entry.fingerprint !== currentFingerprint) {
        return null;
      }

      this.setMemoryEntry(memKey, {
        ...entry,
        byteSize: entry.byteSize ?? this.estimateBytes(entry.data),
      });
      return entry.data;
    } catch {
      return null;
    }
  }

  /**
   * Saves data into memory and disk cache.
   * Oversized values are not retained in the heap and are not written to disk.
   */
  async set<T>(key: string, data: T, options?: { ttlMs?: number; fingerprint?: string }): Promise<void> {
    const byteSize = this.estimateBytes(data);
    const entry: CacheEntry<T> = {
      timestamp: Date.now(),
      ttlMs: options?.ttlMs,
      fingerprint: options?.fingerprint,
      data,
      byteSize,
    };

    const memKey = this.namespacedKey(key);
    if (byteSize <= this.maxEntryBytes) {
      this.setMemoryEntry(memKey, entry);
    }

    if (byteSize > this.maxEntryBytes) {
      return;
    }

    const targetFilePath = this.getCacheFilePath(key);
    await this.enqueueWrite(async () => {
      const filePath = targetFilePath;
      const tmpPath = `${filePath}.tmp.${Date.now()}.${crypto.randomUUID().slice(0, 8)}`;
      try {
        await fs.mkdir(this.cacheDir, { recursive: true });
        await fs.writeFile(tmpPath, JSON.stringify(entry), 'utf-8');
        await fs.rename(tmpPath, filePath);
        this.writeCount++;
        if (this.writeCount % 20 === 0) {
          await this.pruneDiskCache();
          this.pruneExpiredMemory();
        }
      } catch (err) {
        await fs.unlink(tmpPath).catch(() => {});
        console.warn(`[CacheManager] Failed to write cache to ${filePath}:`, err);
      }
    });
  }

  private enqueueWrite(fn: () => Promise<void>): Promise<void> {
    const run = this.writeChain.then(fn, fn);
    this.writeChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private deleteMemory(memKey: string): void {
    const existing = this.memoryCache.get(memKey);
    if (existing) {
      this.memoryBytes = Math.max(0, this.memoryBytes - (existing.byteSize ?? 0));
      this.memoryCache.delete(memKey);
    }
  }

  private setMemoryEntry(key: string, entry: CacheEntry<unknown>): void {
    const size = entry.byteSize ?? this.estimateBytes(entry.data);
    entry.byteSize = size;

    if (size > this.maxEntryBytes) {
      return;
    }

    if (this.memoryCache.has(key)) {
      this.deleteMemory(key);
    }

    this.pruneExpiredMemory();
    this.evictUntilFit(size);

    this.memoryCache.set(key, entry);
    this.memoryBytes += size;
  }

  private evictUntilFit(incomingBytes: number): void {
    while (
      this.memoryCache.size >= this.maxMemoryEntries ||
      this.memoryBytes + incomingBytes > this.maxMemoryBytes
    ) {
      const oldestKey = this.memoryCache.keys().next().value;
      if (oldestKey === undefined) break;
      this.deleteMemory(oldestKey);
    }
  }

  pruneExpiredMemory(): void {
    const now = Date.now();
    for (const [key, entry] of this.memoryCache.entries()) {
      if (entry.ttlMs && now - entry.timestamp > entry.ttlMs) {
        this.deleteMemory(key);
      }
    }
  }

  async pruneDiskCache(options?: { orphanGraceMs?: number }): Promise<void> {
    try {
      const files = await fs.readdir(this.cacheDir);
      const jsonFiles = files.filter((f) => f.endsWith('.json'));
      const now = Date.now();

      // 1. Clean up orphaned .tmp files older than 30s
      const tmpFiles = files.filter((f) => f.includes('.tmp.'));
      for (const tf of tmpFiles) {
        try {
          const s = await fs.stat(path.join(this.cacheDir, tf));
          if (now - s.mtimeMs > 30_000) {
            await fs.unlink(path.join(this.cacheDir, tf)).catch(() => {});
          }
        } catch {}
      }

      // 2. Read and parse JSON entries, inspect TTL & overflow references
      interface DiskEntryMeta {
        jsonPath: string;
        overflowPath: string | null;
        mtimeMs: number;
        timestamp: number;
        jsonSize: number;
        totalBytes: number;
      }

      const validEntries: DiskEntryMeta[] = [];

      for (const f of jsonFiles) {
        const jsonPath = path.join(this.cacheDir, f);
        try {
          const stat = await fs.stat(jsonPath);
          const content = await fs.readFile(jsonPath, 'utf-8');
          const entry: CacheEntry<any> = JSON.parse(content);

          const overflowPath =
            typeof entry?.data?.overflowPath === 'string'
              ? path.resolve(entry.data.overflowPath)
              : null;

          // Check TTL expiration
          if (entry.ttlMs && now - entry.timestamp > entry.ttlMs) {
            await fs.unlink(jsonPath).catch(() => {});
            if (overflowPath) {
              await fs.unlink(overflowPath).catch(() => {});
            }
            continue;
          }

          // Check oversized standalone JSON (exceeds maxEntryBytes)
          if (stat.size > this.maxEntryBytes) {
            await fs.unlink(jsonPath).catch(() => {});
            if (overflowPath) {
              await fs.unlink(overflowPath).catch(() => {});
            }
            continue;
          }

          // Account for overflow file size in entry disk footprint
          let overflowSize = 0;
          if (overflowPath) {
            try {
              const os = await fs.stat(overflowPath);
              overflowSize = os.size;
            } catch {
              // overflow file missing or inaccessible
            }
          }

          validEntries.push({
            jsonPath,
            overflowPath,
            mtimeMs: stat.mtimeMs,
            timestamp: entry.timestamp || stat.mtimeMs,
            jsonSize: stat.size,
            totalBytes: stat.size + overflowSize,
          });
        } catch {
          // Corrupted or unreadable JSON file
          await fs.unlink(jsonPath).catch(() => {});
        }
      }

      // 3. Sort entries by oldest first (mtimeMs) for LRU/FIFO eviction
      validEntries.sort((a, b) => a.mtimeMs - b.mtimeMs);

      let totalDiskBytes = validEntries.reduce((sum, e) => sum + e.totalBytes, 0);
      let survivingIndex = 0;

      while (
        survivingIndex < validEntries.length &&
        (validEntries.length - survivingIndex > this.maxDiskEntries || totalDiskBytes > this.maxDiskBytes)
      ) {
        const victim = validEntries[survivingIndex];
        await fs.unlink(victim.jsonPath).catch(() => {});
        if (victim.overflowPath) {
          await fs.unlink(victim.overflowPath).catch(() => {});
        }
        totalDiskBytes -= victim.totalBytes;
        survivingIndex++;
      }

      const surviving = validEntries.slice(survivingIndex);

      // 4. Collect all active referenced overflow files
      const referencedOverflow = new Set<string>();

      // (a) From surviving disk JSON entries
      for (const item of surviving) {
        if (item.overflowPath) {
          referencedOverflow.add(item.overflowPath);
        }
      }

      // (b) From memory cache (entries in memory whose JSON may still be in write queue or newly set)
      for (const memEntry of this.memoryCache.values()) {
        const p = (memEntry.data as any)?.overflowPath;
        if (typeof p === 'string') {
          referencedOverflow.add(path.resolve(p));
        }
      }

      // 5. Reconcile overflow directory: remove orphaned files not referenced and older than grace period
      const overflowDir = path.join(this.cacheDir, 'overflow');
      const orphanGraceMs = options?.orphanGraceMs ?? 120_000; // 2 minutes grace period
      try {
        const overflowFiles = await fs.readdir(overflowDir);
        for (const of of overflowFiles) {
          const fullPath = path.resolve(overflowDir, of);
          if (of.includes('.tmp.')) {
            const s = await fs.stat(fullPath).catch(() => null);
            if (s && now - s.mtimeMs > 30_000) {
              await fs.unlink(fullPath).catch(() => {});
            }
            continue;
          }

          if (referencedOverflow.has(fullPath)) {
            continue;
          }

          // Orphan candidate: check grace period
          const s = await fs.stat(fullPath).catch(() => null);
          if (s && (orphanGraceMs <= 0 || Date.now() - s.mtimeMs >= orphanGraceMs)) {
            await fs.unlink(fullPath).catch(() => {});
          }
        }
      } catch {}
    } catch {
      // Ignore disk pruning errors
    }
  }

  async getStats(): Promise<CacheStats> {
    let diskEntries = 0;
    let estimatedDiskBytes = 0;
    try {
      const files = await fs.readdir(this.cacheDir);
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        diskEntries++;
        try {
          const s = await fs.stat(path.join(this.cacheDir, f));
          estimatedDiskBytes += s.size;
        } catch {
          // skip
        }
      }
      const overflowDir = path.join(this.cacheDir, 'overflow');
      const overflowFiles = await fs.readdir(overflowDir).catch(() => []);
      for (const of of overflowFiles) {
        diskEntries++;
        try {
          const s = await fs.stat(path.join(overflowDir, of));
          estimatedDiskBytes += s.size;
        } catch {}
      }
    } catch {
      // unreadable cache dir
    }
    return {
      namespace: this.namespace,
      memoryEntries: this.memoryCache.size,
      estimatedMemoryBytes: this.memoryBytes,
      diskEntries,
      estimatedDiskBytes,
    };
  }

  /**
   * Workspace fingerprint with a few-second memo and single-flight.
   * Memo is skipped when the cheap probe (git HEAD/index mtime, watch
   * generation) changed — so uncommitted writes are not stuck for 2.5s.
   * Pass { fresh: true } after a known write to bypass memo entirely.
   */
  async computeWorkspaceFingerprint(
    workspaceRoot: string,
    options?: { fresh?: boolean }
  ): Promise<string> {
    const resolvedRoot = path.resolve(workspaceRoot);
    const cheap = await this.cheapChangeProbe(resolvedRoot);
    if (options?.fresh) {
      this.invalidateFingerprint(resolvedRoot);
    } else {
      const memo = this.fpMemo.get(resolvedRoot);
      if (memo && memo.expiresAt > Date.now() && memo.cheap === cheap) {
        return memo.value;
      }
      const inflight = this.fpInflight.get(resolvedRoot);
      if (inflight) return inflight;
    }

    const pending = this.computeWorkspaceFingerprintUncached(resolvedRoot)
      .then((value) => {
        this.fpMemo.set(resolvedRoot, {
          value,
          expiresAt: Date.now() + this.fingerprintMemoMs,
          cheap,
        });
        this.fpInflight.delete(resolvedRoot);
        return value;
      })
      .catch((err) => {
        this.fpInflight.delete(resolvedRoot);
        throw err;
      });

    this.fpInflight.set(resolvedRoot, pending);
    return pending;
  }

  /**
   * Called from WorkspaceWatch. Drops memo so the next MCP call rescans.
   */
  noteFilesystemChange(workspaceRoot: string): void {
    const resolved = path.resolve(workspaceRoot);
    this.watchGeneration.set(resolved, (this.watchGeneration.get(resolved) ?? 0) + 1);
    this.invalidateFingerprint(resolved);
  }

  invalidateFingerprint(workspaceRoot?: string): void {
    if (!workspaceRoot) {
      this.fpMemo.clear();
      this.fpInflight.clear();
      return;
    }
    const resolved = path.resolve(workspaceRoot);
    this.fpMemo.delete(resolved);
    this.fpInflight.delete(resolved);
  }

  private async cheapChangeProbe(resolvedRoot: string): Promise<string> {
    const gen = this.watchGeneration.get(resolvedRoot) ?? 0;
    const candidates = [
      path.join(resolvedRoot, '.git', 'HEAD'),
      path.join(resolvedRoot, '.git', 'index'),
      path.join(resolvedRoot, 'package.json'),
    ];
    const parts = [`watch:${gen}`];
    for (const file of candidates) {
      try {
        const s = await fs.stat(file);
        parts.push(`${path.basename(file)}:${s.mtimeMs}:${s.size}`);
      } catch {
        parts.push(`${path.basename(file)}:missing`);
      }
    }
    return parts.join('|');
  }

  private async computeWorkspaceFingerprintUncached(resolvedRoot: string): Promise<string> {
    try {
      const gitPath = path.join(resolvedRoot, '.git');
      const hasGit = await fs.stat(gitPath).catch(() => null);

      if (hasGit) {
        try {
          const [headRes, statusRes] = await Promise.all([
            execAsync('git rev-parse HEAD', { cwd: resolvedRoot, windowsHide: true, timeout: 3000 }).catch(
              () => ({ stdout: '' })
            ),
            execAsync('git status --porcelain=v1 -z', { cwd: resolvedRoot, windowsHide: true, timeout: 5000 }),
          ]);
          const headCommit = headRes.stdout.trim();
          const gitStatusRaw = statusRes.stdout;

          let branchRef = '';
          if (!headCommit) {
            try {
              const headContent = await fs.readFile(path.join(resolvedRoot, '.git', 'HEAD'), 'utf-8');
              branchRef = headContent.trim();
            } catch {
              // ignore
            }
          }

          const rawEntries = gitStatusRaw.split('\0');
          const parsedItems: { statusType: string; relPath: string; origPath?: string }[] = [];
          for (let i = 0; i < rawEntries.length; i++) {
            const entry = rawEntries[i];
            if (!entry || entry.length < 3) continue;
            const statusType = entry.substring(0, 2);
            const pathPart = entry.substring(3);
            if (statusType.includes('R') || statusType.includes('C')) {
              // In git status -z porcelain, R/C outputs: "XY NEW_PATH\0OLD_PATH\0"
              const origPath = rawEntries[++i] || '';
              parsedItems.push({ statusType, relPath: pathPart, origPath });
            } else {
              parsedItems.push({ statusType, relPath: pathPart });
            }
          }

          const itemsToStat = parsedItems.slice(0, 100);

          const fileStats = await Promise.all(
            itemsToStat.map(async ({ statusType, relPath, origPath }) => {
              const fullPath = path.resolve(resolvedRoot, relPath);
              const pathKey = origPath ? `${relPath}<-${origPath}` : relPath;
              try {
                const stat = await fs.stat(fullPath);
                return `${statusType}:${pathKey}:${stat.mtimeMs}:${stat.size}`;
              } catch {
                return `${statusType}:${pathKey}:deleted`;
              }
            })
          );

          const payload = [headCommit || branchRef || 'no-head', parsedItems.length.toString(), ...fileStats].join('|');
          return crypto.createHash('sha1').update(payload).digest('hex');
        } catch {
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
              } catch {
                // ignore
              }

              const dirFp = await this.computeDirectoryFingerprintFallback(resolvedRoot);
              return crypto.createHash('sha1').update(`${commitRef}|${indexStat}|${dirFp}`).digest('hex');
            }
          } catch {
            // fall through
          }
        }
      }

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
      } catch {
        // skip
      }
    };

    await walk(dirPath, 0);
    return crypto.createHash('sha1').update(stats.join('|')).digest('hex');
  }

  async clear(): Promise<void> {
    this.memoryCache.clear();
    this.memoryBytes = 0;
    this.fpMemo.clear();
    this.fpInflight.clear();
    this.watchGeneration.clear();
    try {
      const files = await fs.readdir(this.cacheDir);
      for (const file of files) {
        if (file.endsWith('.json') || file.includes('.tmp.')) {
          await fs.unlink(path.join(this.cacheDir, file)).catch(() => {});
        }
      }
      const overflowDir = path.join(this.cacheDir, 'overflow');
      const overflowFiles = await fs.readdir(overflowDir).catch(() => []);
      for (const of of overflowFiles) {
        await fs.unlink(path.join(overflowDir, of)).catch(() => {});
      }
    } catch {
      // Ignore
    }
  }
}
