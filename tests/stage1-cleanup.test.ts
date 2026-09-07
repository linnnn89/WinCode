import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CacheManager } from '../src/Core/Cache.js';
import { ToolRouter } from '../src/Core/ToolRouter.js';
import { getDefaultConfig } from '../src/Core/Config.js';

async function isolated(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-cleanup-'));
  try { await run(root); } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('wincode-cleanup-'));
    await fs.rm(root, { recursive: true, force: true });
  }
}

it('capacity eviction invalidates the memory snapshot as well as its file', async () => isolated(async root => {
  const cache = new CacheManager(root, 50, 50, { maxDiskBytes: 1000 });
  await cache.initialize();
  await fs.mkdir(path.join(root, 'overflow'));
  const snapshot = path.join(root, 'overflow', 'pack.txt');
  await fs.writeFile(snapshot, 'x'.repeat(2000));
  await cache.set('pack', { overflowPath: snapshot });
  await cache.pruneDiskCache();
  assert.equal(await cache.get('pack'), null);
  assert.equal(cache.memoryEntryCount, 0);
  await assert.rejects(fs.stat(snapshot), { code: 'ENOENT' });
}));

it('capacity and TTL cleanup preserve paths outside overflow', async () => isolated(async root => {
  const asset = path.join(root, 'asset.txt');
  await fs.writeFile(asset, 'preserve');
  for (const mode of ['capacity', 'ttl']) {
    const dir = path.join(root, mode);
    const cache = new CacheManager(dir, 50, 50, { maxDiskBytes: mode === 'capacity' ? 1 : 10000 });
    await cache.initialize();
    await cache.set('pack', { overflowPath: asset }, mode === 'ttl' ? { ttlMs: 1 } : undefined);
    if (mode === 'ttl') {
      await new Promise(resolve => setTimeout(resolve, 10));
      // Fresh reader exercises disk get's expiration path.
      assert.equal(await new CacheManager(dir).get('pack'), null);
    } else await cache.pruneDiskCache();
    assert.equal(await fs.readFile(asset, 'utf8'), 'preserve');
  }
}));

it('cleanup does not follow an overflow directory junction', async () => isolated(async root => {
  const dir = path.join(root, 'cache');
  const outside = path.join(root, 'assets');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'asset.txt'), 'preserve');
  const cache = new CacheManager(dir, 50, 50, { maxDiskBytes: 1 });
  await cache.initialize();
  const link = path.join(dir, 'overflow');
  await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    await cache.set('pack', { overflowPath: path.join(link, 'asset.txt') });
    await cache.pruneDiskCache({ orphanGraceMs: 0 });
    assert.equal(await fs.readFile(path.join(outside, 'asset.txt'), 'utf8'), 'preserve');
  } finally { await fs.unlink(link); }
}));

it('shutdown waits for the active switch and rejects its queued queries', async () => isolated(async root => {
  const router = new ToolRouter(getDefaultConfig(root));
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const events: string[] = [];
  router.workspace.openWorkspace = async () => { entered(); await blocked; return {} as any; };
  router.cache.computeWorkspaceFingerprint = async () => 'fixture';
  (router as any).bindWatch = () => {};
  router.repomix.dispose = async () => { events.push('dispose'); };
  router.repomix.initialize = async () => { events.push('initialize'); };
  router.serena.resetConnection = async () => {};
  router.serena.initialize = async () => {};
  const switching = router.openWorkspace(root);
  await started;
  const rejected = assert.rejects(router.acquireRequestSlot(), /shutting down/);
  const shutdown = router.dispose();
  assert.deepEqual(events, []);
  release();
  await Promise.all([switching, shutdown, rejected]);
  assert.deepEqual(events, ['dispose', 'initialize', 'dispose']);
  assert.equal(router.inFlightRequests, 0);
  assert.equal(router.resources.isDisposed, true);
  await assert.rejects(router.acquireRequestSlot(), /shutting down/);
}));
