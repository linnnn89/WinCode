import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { CacheManager } from '../src/Core/Cache.js';

import { getDefaultConfig } from '../src/Core/Config.js';

// 每个功能套件拥有独立缓存；并行文件不能删除彼此正在使用的缓存。
describe('core-cache', () => {
  const root = process.cwd();
  const testCacheDir = path.join(root, '.cache', `test_core-cache_${process.pid}`);
  const config = getDefaultConfig(root);
  config.cacheDir = testCacheDir;

  before(async () => {
    await fs.mkdir(testCacheDir, { recursive: true });
  });
  after(async () => {
    await fs.rm(testCacheDir, { recursive: true, force: true }).catch(() => { });
  });
  describe('1. Core: CacheManager', () => {
    it('should store and retrieve data from memory and disk', async () => {
      const cache = new CacheManager(testCacheDir);
      await cache.initialize();

      await cache.set('user_profile', { name: 'Coder', level: 10 });
      const retrieved = await cache.get<{ name: string; level: number }>('user_profile');

      assert.ok(retrieved);
      assert.strictEqual(retrieved.name, 'Coder');
      assert.strictEqual(retrieved.level, 10);
    });

    it('should respect TTL expiration', async (t) => {
      // Use a controlled clock: parallel fixture I/O must not consume the TTL before the first assertion.
      let now = Date.now();
      t.mock.method(Date, 'now', () => now);
      const cache = new CacheManager(testCacheDir);
      await cache.initialize();

      await cache.set('transient_token', { token: 'xyz123' }, { ttlMs: 50 });
      const beforeExp = await cache.get('transient_token');
      assert.ok(beforeExp);

      // Advance the clock without depending on scheduler load.
      now += 70;
      const afterExp = await cache.get('transient_token');
      assert.strictEqual(afterExp, null, 'Cache item should be null after TTL expired');
    });

    it('should invalidate cache when workspace fingerprint changes', async () => {
      const cache = new CacheManager(testCacheDir);
      await cache.initialize();

      await cache.set('versioned_data', { data: 'old' }, { fingerprint: 'fp_v1' });

      // Retrieve with matching fingerprint -> hit
      const hit = await cache.get('versioned_data', 'fp_v1');
      assert.ok(hit);

      // Retrieve with altered fingerprint -> miss
      const miss = await cache.get('versioned_data', 'fp_v2');
      assert.strictEqual(miss, null, 'Cache item must miss when fingerprint changes');
    });

    it('should compute sensitive workspace fingerprint that changes upon file edits and additions', async () => {
      const cache = new CacheManager(testCacheDir);
      await cache.initialize();

      const fpOriginal = await cache.computeWorkspaceFingerprint(root, { fresh: true });
      assert.ok(fpOriginal && typeof fpOriginal === 'string');

      // Create a temporary file in root to simulate workspace change
      const probeFile = path.join(root, 'tdd_probe_temp_file.txt');
      await fs.writeFile(probeFile, 'probe content v1');

      try {
        const fpAfterCreate = await cache.computeWorkspaceFingerprint(root, { fresh: true });
        assert.notStrictEqual(fpAfterCreate, fpOriginal, 'Fingerprint must change when an untracked file is added');

        await new Promise((r) => setTimeout(r, 40));
        await fs.writeFile(probeFile, 'probe content v2 modified');
        const fpAfterModify = await cache.computeWorkspaceFingerprint(root, { fresh: true });
        assert.notStrictEqual(fpAfterModify, fpAfterCreate, 'Fingerprint must change when an existing dirty file is modified');
      } finally {
        await fs.unlink(probeFile).catch(() => { });
      }

      const fpRestored = await cache.computeWorkspaceFingerprint(root, { fresh: true });
      assert.strictEqual(fpRestored, fpOriginal, 'Fingerprint should restore when modifications are reverted');
    });

    it('should detect file edits in non-git directories as well', async () => {
      const cache = new CacheManager(testCacheDir);
      const tempNonGit = path.join(testCacheDir, 'nongit_probe');
      await fs.mkdir(path.join(tempNonGit, 'src'), { recursive: true });
      const testFile = path.join(tempNonGit, 'src', 'code.ts');
      await fs.writeFile(testFile, 'export const a = 1;');

      const fp1 = await cache.computeWorkspaceFingerprint(tempNonGit, { fresh: true });
      await new Promise((r) => setTimeout(r, 40));
      await fs.writeFile(testFile, 'export const a = 2;');
      const fp2 = await cache.computeWorkspaceFingerprint(tempNonGit, { fresh: true });

      assert.notStrictEqual(fp1, fp2, 'Non-git workspace fingerprint must reflect subfolder file changes');
    });

    it('P2 Fix: CacheManager should enforce memory capacity limit and LRU eviction', async () => {
      const smallCacheDir = path.join(testCacheDir, 'lru_test_cache');
      const smallCache = new CacheManager(smallCacheDir, 3, 3);
      await smallCache.initialize();

      await smallCache.set('k1', 'val1');
      await smallCache.set('k2', 'val2');
      await smallCache.set('k3', 'val3');
      assert.strictEqual(smallCache.memoryEntryCount, 3);

      // Access k1 to make it most recently used (LRU order: k2, k3, k1)
      const hit = await smallCache.get('k1');
      assert.strictEqual(hit, 'val1');

      // Adding k4 should evict k2 (oldest)
      await smallCache.set('k4', 'val4');
      assert.ok(smallCache.memoryEntryCount <= 3);

      // k1, k3, k4 should be accessible
      assert.strictEqual(await smallCache.get('k1'), 'val1');
      assert.strictEqual(await smallCache.get('k4'), 'val4');
    });
  });
});
