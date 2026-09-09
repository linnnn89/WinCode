import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { CacheManager } from '../src/Core/Cache.js';

const execAsync = promisify(exec);

async function pidAlive(pid: number): Promise<boolean> {
  try {
    const { stdout } = await execAsync(`tasklist /FI "PID eq ${pid}" /NH`, { windowsHide: true });
    return stdout.includes(String(pid));
  } catch {
    return false;
  }
}

// 每个功能套件拥有独立缓存；并行文件不能删除彼此正在使用的缓存。
describe('cache-budgets', () => {
  const root = process.cwd();
  const testCacheDir = path.join(root, '.cache', `test_cache-budgets_${process.pid}`);

  before(async () => {
    await fs.mkdir(testCacheDir, { recursive: true });
  });
  after(async () => {
    await fs.rm(testCacheDir, { recursive: true, force: true }).catch(() => { });
  });
  describe('Cache', () => {
    it('TTL still expires entries', async () => {
      const cache = new CacheManager(path.join(testCacheDir, 'ttl'));
      await cache.initialize();
      await cache.set('t', { n: 1 }, { ttlMs: 40 });
      assert.ok(await cache.get('t'));
      await new Promise((r) => setTimeout(r, 60));
      assert.strictEqual(await cache.get('t'), null);
    });

    it('byte limit and maxEntryBytes keep large snapshots out of the heap cache', async () => {
      const cache = new CacheManager(path.join(testCacheDir, 'bytes'), 20, 20, {
        maxMemoryBytes: 4_000,
        maxEntryBytes: 1_000,
        maxDiskBytes: 10_000,
      });
      await cache.initialize();

      const huge = 'H'.repeat(8_000);
      await cache.set('large_snapshot', huge);
      assert.strictEqual(cache.memoryEntryCount, 0, 'oversized entry must not live in memory');
      assert.ok(cache.estimatedMemoryBytes < 1_000);
      assert.strictEqual(await cache.get('large_snapshot'), null, 'oversized entry is not disk-cached either');

      await cache.set('small', { ok: true });
      assert.ok(cache.memoryEntryCount >= 1);
      assert.deepStrictEqual(await cache.get('small'), { ok: true });
    });

    it('entry eviction by memory bytes removes LRU items', async () => {
      const cache = new CacheManager(path.join(testCacheDir, 'evict'), 50, 50, {
        maxMemoryBytes: 600,
        maxEntryBytes: 400,
      });
      await cache.initialize();
      await cache.set('a', 'A'.repeat(80));
      await cache.set('b', 'B'.repeat(80));
      await cache.set('c', 'C'.repeat(80));
      assert.ok(cache.estimatedMemoryBytes <= 600);
      assert.ok(cache.memoryEntryCount <= 3);
    });

    it('workspace cache isolation + clear drops memory accounting', async () => {
      const cache = new CacheManager(path.join(testCacheDir, 'ns'));
      await cache.initialize();
      cache.setNamespace(path.join(root, 'projA'));
      await cache.set('symbol', { name: 'A' });
      cache.setNamespace(path.join(root, 'projB'));
      assert.strictEqual(cache.memoryEntryCount, 0);
      assert.strictEqual(await cache.get('symbol'), null);
      cache.setNamespace(path.join(root, 'projA'));
      assert.deepStrictEqual(await cache.get('symbol'), { name: 'A' });

      await cache.clear();
      assert.strictEqual(cache.memoryEntryCount, 0);
      assert.strictEqual(cache.estimatedMemoryBytes, 0);
      assert.strictEqual(await cache.get('symbol'), null);
    });

    it('fingerprint memoization reuses a scan within the memo window', async () => {
      const cache = new CacheManager(testCacheDir, 50, 50, { fingerprintMemoMs: 2_000 });
      const a = await cache.computeWorkspaceFingerprint(root);
      const t0 = Date.now();
      const b = await cache.computeWorkspaceFingerprint(root);
      const elapsed = Date.now() - t0;
      assert.strictEqual(a, b);
      assert.ok(elapsed < 200, `memoized fingerprint should be cheap, took ${elapsed}ms`);
    });
  });
});
