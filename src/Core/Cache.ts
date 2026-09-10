import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { getDefaultCacheLimits, WinCodeCacheLimits } from './Config.js';

import { WorkspaceFingerprint } from './WorkspaceFingerprint.js';
import { assertLinkFreePath } from './FileSystemBoundary.js';

const CACHE_FILE = /^wincode-v1_[A-Za-z0-9_-]{0,32}_[a-f0-9]{16}\.json$/;
const CACHE_TEMP = /^wincode-v1_[A-Za-z0-9_-]{0,32}_[a-f0-9]{16}\.json\.tmp\.\d+\.[a-f0-9]{8}$/;
const OVERFLOW_FILE = /^pack_\d+_[a-f0-9]{8}\.txt(?:\.tmp\.[a-f0-9]{8})?$/;
const CACHE_HEADER = '{"format":"wincode-cache-v1",';

export interface CacheEntry<T> {
  format?: 'wincode-cache-v1';
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
  private workspaceFingerprint: WorkspaceFingerprint;
  private writeCount = 0;
  private memoryBytes = 0;
  private namespace = '';
  private writeChain: Promise<void> = Promise.resolve();
  private diskIdentity: string | null = null;

  constructor(
    cacheDir: string,
    maxMemoryEntries = 500,
    maxDiskEntries = 500,
    limits?: Partial<WinCodeCacheLimits>
  ) {
    this.cacheDir = path.resolve(cacheDir);
    const defaults = getDefaultCacheLimits();
    this.maxMemoryEntries = limits?.maxMemoryEntries ?? maxMemoryEntries;
    this.maxDiskEntries = limits?.maxDiskEntries ?? maxDiskEntries;
    this.maxMemoryBytes = limits?.maxMemoryBytes ?? defaults.maxMemoryBytes;
    this.maxDiskBytes = limits?.maxDiskBytes ?? defaults.maxDiskBytes;
    this.maxEntryBytes = limits?.maxEntryBytes ?? defaults.maxEntryBytes;
    this.workspaceFingerprint = new WorkspaceFingerprint(limits?.fingerprintMemoMs ?? defaults.fingerprintMemoMs);
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
    this.workspaceFingerprint.reset();
  }

  async initialize(): Promise<void> {
    await this.assertDiskBoundary('', true);
    await this.pruneDiskCache();
  }

  private async assertDiskBoundary(child = '', create = false): Promise<void> {
    await assertLinkFreePath(this.cacheDir);
    if (create) await fs.mkdir(this.cacheDir, { recursive: true });
    await assertLinkFreePath(this.cacheDir);
    const stat = await fs.lstat(this.cacheDir, { bigint: true });
    if (!stat.isDirectory()) throw new Error('Cache root is not a directory.');
    const identity = `${stat.dev}:${stat.ino}`;
    if (this.diskIdentity !== null && this.diskIdentity !== identity) throw new Error('Cache root identity changed; reopen the workspace.');
    this.diskIdentity = identity;
    if (child) {
      const target = path.join(this.cacheDir, child);
      await assertLinkFreePath(target);
      if (create) await fs.mkdir(target, { recursive: true });
      await assertLinkFreePath(target);
    }
  }

  private async unlinkOwned(file: string): Promise<void> {
    const parent = path.dirname(file);
    const overflow = parent === path.join(this.cacheDir, 'overflow');
    if (parent !== this.cacheDir && !overflow) return;
    if (!(overflow ? OVERFLOW_FILE.test(path.basename(file)) : CACHE_FILE.test(path.basename(file)) || CACHE_TEMP.test(path.basename(file)))) return;
    await this.assertDiskBoundary(overflow ? 'overflow' : '');
    const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat?.isFile() && !stat.isSymbolicLink() && (overflow || await this.hasCacheHeader(file))) await fs.unlink(file);
  }

  private async hasCacheHeader(file: string): Promise<boolean> {
    const handle = await fs.open(file, 'r');
    try {
      const header = Buffer.alloc(CACHE_HEADER.length);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      return bytesRead === header.length && header.toString('utf8') === CACHE_HEADER;
    } finally { await handle.close(); }
  }

  private async assertReplaceable(file: string): Promise<void> {
    await assertLinkFreePath(file);
    const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat && (!stat.isFile() || !await this.hasCacheHeader(file))) throw new Error('Cache destination contains an unowned file.');
  }

  async writeOverflow(content: string): Promise<string> {
    await this.assertDiskBoundary('overflow', true);
    const unique = crypto.randomUUID().slice(0, 8);
    const target = path.join(this.cacheDir, 'overflow', `pack_${Date.now()}_${unique}.txt`);
    const temp = `${target}.tmp.${unique}`;
    try {
      await fs.writeFile(temp, content, { encoding: 'utf8', flag: 'wx' });
      await this.assertDiskBoundary('overflow');
      await fs.rename(temp, target);
      return target;
    } catch (error) { await this.unlinkOwned(temp).catch(() => {}); throw error; }
  }

  /**
   * Point this manager at a new directory after workspace_open.
   * Memory is always dropped; the previous disk tree is left for the OS/prune.
   */
  async rebind(newCacheDir: string): Promise<void> {
    await assertLinkFreePath(newCacheDir);
    await this.flush();
    this.memoryCache.clear();
    this.memoryBytes = 0;
    this.workspaceFingerprint.reset();
    this.cacheDir = path.resolve(newCacheDir);
    this.diskIdentity = null;
    await this.initialize();
  }

  private namespacedKey(key: string): string {
    return this.namespace ? `${this.namespace}::${key}` : key;
  }

  private getCacheFilePath(key: string): string {
    const namespaced = this.namespacedKey(key);
    const hash = crypto.createHash('sha256').update(namespaced).digest('hex').substring(0, 16);
    const safeKey = namespaced.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 32);
    return path.join(this.cacheDir, `wincode-v1_${safeKey}_${hash}.json`);
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

  /** Content-addressed parsing reuse within the existing memory budget; never persists source-derived AST hints. */
  memoizeContent<T>(key: string, fingerprint: string, create: () => T): T {
    const memKey = this.namespacedKey(key);
    const entry = this.memoryCache.get(memKey);
    if (entry?.fingerprint === fingerprint) {
      this.memoryCache.delete(memKey);
      this.memoryCache.set(memKey, entry);
      return entry.data as T;
    }
    const data = create();
    const byteSize = this.estimateBytes(data);
    if (byteSize <= this.maxEntryBytes) this.setMemoryEntry(memKey, { data, fingerprint, byteSize, timestamp: Date.now() });
    else this.deleteMemory(memKey);
    return data;
  }

  private async backingFileExists(data: unknown): Promise<boolean> {
    const file = (data as { overflowPath?: unknown } | null)?.overflowPath;
    if (file === undefined) return true;
    if (typeof file !== 'string') return false;
    const relative = path.relative(path.join(this.cacheDir, 'overflow'), file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
    if (!OVERFLOW_FILE.test(path.basename(file))) return false;
    try {
      await this.assertDiskBoundary('overflow');
      const stat = await fs.lstat(file);
      return stat.isFile() && !stat.isSymbolicLink();
    } catch { return false; }
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
        if (!await this.backingFileExists(memEntry.data)) {
          this.deleteMemory(memKey);
          return null;
        }
        this.memoryCache.delete(memKey);
        this.memoryCache.set(memKey, memEntry);
        return memEntry.data as T;
      }
    }

    const filePath = this.getCacheFilePath(key);
    try {
      await this.assertDiskBoundary();
      const stat = await fs.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) return null;
      if (stat.size > this.maxEntryBytes) {
        await this.unlinkOwned(filePath);
        return null;
      }

      const content = await fs.readFile(filePath, 'utf-8');
      const entry: CacheEntry<T> = JSON.parse(content);
      if (entry.format !== 'wincode-cache-v1' || !Number.isFinite(entry.timestamp) || !Object.hasOwn(entry, 'data')) return null;

      if (entry.ttlMs && now - entry.timestamp > entry.ttlMs) {
        await this.unlinkOwned(filePath);
        const p = (entry.data as any)?.overflowPath;
        if (typeof p === 'string') {
          await this.removeOverflow(p);
        }
        return null;
      }

      if (currentFingerprint && entry.fingerprint !== currentFingerprint) {
        return null;
      }

      if (!await this.backingFileExists(entry.data)) return null;

      this.setMemoryEntry(memKey, {
        ...entry,
        // Disk metadata is not authoritative for heap accounting.
        byteSize: this.estimateBytes(entry.data),
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
      format: 'wincode-cache-v1',
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
      // A rejected replacement must invalidate the old value, not silently resurrect it.
      this.deleteMemory(memKey);
      const stalePath = this.getCacheFilePath(key);
      await this.enqueueWrite(() => this.unlinkOwned(stalePath).catch(() => {}));
      return;
    }

    const targetFilePath = this.getCacheFilePath(key);
    await this.enqueueWrite(async () => {
      const filePath = targetFilePath;
      const tmpPath = `${filePath}.tmp.${Date.now()}.${crypto.randomUUID().slice(0, 8)}`;
      try {
        await this.assertDiskBoundary('', true);
        await this.assertReplaceable(filePath);
        await fs.writeFile(tmpPath, JSON.stringify(entry), { encoding: 'utf8', flag: 'wx' });
        await this.assertDiskBoundary();
        await this.assertReplaceable(filePath);
        await fs.rename(tmpPath, filePath);
        this.writeCount++;
        if (this.writeCount % 20 === 0) {
          await this.pruneDiskCacheOnce();
          this.pruneExpiredMemory();
        }
      } catch (err) {
        await this.unlinkOwned(tmpPath).catch(() => {});
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

  /** Drain accepted writes before the gateway releases its remaining resources. */
  async flush(): Promise<void> {
    await this.writeChain;
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

    // Invalidate a previous value even when the replacement is disk-only.
    if (this.memoryCache.has(key)) this.deleteMemory(key);

    if (!Number.isFinite(size) || size < 0 || size > this.maxEntryBytes ||
      size > this.maxMemoryBytes || this.maxMemoryEntries <= 0) {
      return;
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

  private async removeOverflow(file: string): Promise<void> {
    const target = path.resolve(file);
    const overflowDir = path.resolve(this.cacheDir, 'overflow');
    if (path.dirname(target) !== overflowDir || !OVERFLOW_FILE.test(path.basename(target))) return;

    // Invalidate readers before deleting their backing snapshot.
    for (const [key, entry] of this.memoryCache) {
      const ref = (entry.data as { overflowPath?: unknown } | null)?.overflowPath;
      if (typeof ref === 'string' && path.resolve(ref) === target) this.deleteMemory(key);
    }
    try {
      await this.assertDiskBoundary('overflow');
      const dirStat = await fs.lstat(overflowDir);
      if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return;
      const realCache = await fs.realpath(this.cacheDir);
      const realOverflow = await fs.realpath(overflowDir);
      if (path.relative(realCache, realOverflow) !== 'overflow') return;
      const stat = await fs.lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink()) return;
      await this.unlinkOwned(target);
    } catch {
      // Missing or inaccessible snapshots are safe to leave for a later prune.
    }
  }

  async pruneDiskCache(options?: { orphanGraceMs?: number }): Promise<void> {
    // Disk maintenance shares the writer queue so it cannot remove a replacement mid-write.
    await this.enqueueWrite(() => this.pruneDiskCacheOnce(options));
  }

  private async pruneDiskCacheOnce(options?: { orphanGraceMs?: number }): Promise<void> {
    await this.assertDiskBoundary();
    try {
      const files = await fs.readdir(this.cacheDir);
      const jsonFiles = files.filter((f) => CACHE_FILE.test(f));
      const now = Date.now();

      // 1. Clean up orphaned .tmp files older than 30s
      const tmpFiles = files.filter((f) => CACHE_TEMP.test(f));
      for (const tf of tmpFiles) {
        try {
          const s = await fs.stat(path.join(this.cacheDir, tf));
          if (now - s.mtimeMs > 30_000) {
            await this.unlinkOwned(path.join(this.cacheDir, tf));
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
          await this.assertDiskBoundary();
          const stat = await fs.lstat(jsonPath);
          if (!stat.isFile() || stat.isSymbolicLink()) continue;
          // Reject oversized JSON before parsing; overflow orphans are reconciled below.
          if (stat.size > this.maxEntryBytes) {
            await this.unlinkOwned(jsonPath);
            continue;
          }
          const content = await fs.readFile(jsonPath, 'utf-8');
          const entry: CacheEntry<any> = JSON.parse(content);
          if (entry.format !== 'wincode-cache-v1' || !Number.isFinite(entry.timestamp) || !Object.hasOwn(entry, 'data')) continue;

          const overflowPath =
            typeof entry?.data?.overflowPath === 'string'
              ? path.resolve(entry.data.overflowPath)
              : null;

          // Check TTL expiration
          if (entry.ttlMs && now - entry.timestamp > entry.ttlMs) {
            await this.unlinkOwned(jsonPath);
            if (overflowPath) {
              await this.removeOverflow(overflowPath);
            }
            continue;
          }

          // Account for overflow file size in entry disk footprint
          let overflowSize = 0;
          if (overflowPath && await this.backingFileExists(entry.data)) {
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
          // Unreadable or unrecognizable files have no proven ownership; preserve them.
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
        await this.unlinkOwned(victim.jsonPath);
        if (victim.overflowPath) {
          await this.removeOverflow(victim.overflowPath);
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
        await this.assertDiskBoundary('overflow');
        const overflowFiles = await fs.readdir(overflowDir);
        for (const of of overflowFiles) {
          if (!OVERFLOW_FILE.test(of)) continue;
          const fullPath = path.resolve(overflowDir, of);
          if (of.includes('.tmp.')) {
            const s = await fs.stat(fullPath).catch(() => null);
            if (s && now - s.mtimeMs > 30_000) {
              await this.removeOverflow(fullPath);
            }
            continue;
          }

          if (referencedOverflow.has(fullPath)) {
            continue;
          }

          // Orphan candidate: check grace period
          const s = await fs.stat(fullPath).catch(() => null);
          if (s && (orphanGraceMs <= 0 || Date.now() - s.mtimeMs >= orphanGraceMs)) {
            await this.removeOverflow(fullPath);
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
      await this.assertDiskBoundary();
      const files = await fs.readdir(this.cacheDir);
      for (const f of files) {
        if (!CACHE_FILE.test(f)) continue;
        diskEntries++;
        try {
          const s = await fs.stat(path.join(this.cacheDir, f));
          estimatedDiskBytes += s.size;
        } catch {
          // skip
        }
      }
      const overflowDir = path.join(this.cacheDir, 'overflow');
      await this.assertDiskBoundary('overflow');
      const overflowFiles = await fs.readdir(overflowDir).catch(() => []);
      for (const of of overflowFiles) {
        if (!OVERFLOW_FILE.test(of)) continue;
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

  /** 保留 CacheManager 的既有入口，由独立组件管理指纹观察。 */
  computeWorkspaceFingerprint(root: string, options?: { fresh?: boolean }): Promise<string> {
    return this.workspaceFingerprint.computeWorkspaceFingerprint(root, options);
  }
  noteFilesystemChange(root: string): void { this.workspaceFingerprint.noteFilesystemChange(root); }
  invalidateFingerprint(root?: string): void { this.workspaceFingerprint.invalidateFingerprint(root); }

  async clear(): Promise<void> {
    this.memoryCache.clear();
    this.memoryBytes = 0;
    this.workspaceFingerprint.reset();
    await this.enqueueWrite(() => this.clearDisk());
  }

  private async clearDisk(): Promise<void> {
    await this.assertDiskBoundary();
    try {
      const files = await fs.readdir(this.cacheDir);
      for (const file of files) {
        if (CACHE_FILE.test(file) || CACHE_TEMP.test(file)) {
          await this.unlinkOwned(path.join(this.cacheDir, file));
        }
      }
      const overflowDir = path.join(this.cacheDir, 'overflow');
      await this.assertDiskBoundary('overflow');
      const overflowFiles = await fs.readdir(overflowDir).catch(() => []);
      for (const of of overflowFiles) {
        await this.removeOverflow(path.join(overflowDir, of));
      }
    } catch {
      // Ignore
    }
  }
}
