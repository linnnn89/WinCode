import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { CacheManager } from '../src/Core/Cache.js';

import { getDefaultConfig } from '../src/Core/Config.js';

import { RepomixAdapter } from '../src/Adapters/RepomixAdapter.js';
import { ToolRouter } from '../src/Core/ToolRouter.js';

import { killProcessTree } from '../src/Core/ResourceManager.js';

import { WorkspaceWatch } from '../src/Core/WorkspaceWatch.js';

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
describe('watch-invalidation', () => {
  const root = process.cwd();
  const testCacheDir = path.join(root, '.cache', `test_watch-invalidation_${process.pid}`);

  before(async () => {
    await fs.mkdir(testCacheDir, { recursive: true });
  });
  after(async () => {
    await fs.rm(testCacheDir, { recursive: true, force: true }).catch(() => { });
  });
  describe('v0.5.1 risk fixes', () => {
    it('Windows process-tree kill reaps the cmd wrapper pid', { skip: process.platform !== 'win32' }, async () => {
      const proc = spawn('cmd', ['/c', 'ping', '-t', '127.0.0.1'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      assert.ok(proc.pid);
      await new Promise((r) => setTimeout(r, 250));
      assert.strictEqual(await pidAlive(proc.pid!), true);
      await killProcessTree(proc);
      await new Promise((r) => setTimeout(r, 400));
      assert.strictEqual(await pidAlive(proc.pid!), false);
    });

    it('WorkspaceWatch notifies after a file write in an empty directory', async () => {
      const dir = path.join(testCacheDir, 'watch_unit');
      await fs.mkdir(dir, { recursive: true });
      const watch = new WorkspaceWatch();
      let fired = 0;
      watch.start(dir, () => {
        fired++;
      }, 40);
      await fs.writeFile(path.join(dir, 'a.txt'), '1');
      await new Promise((r) => setTimeout(r, 350));
      watch.stop();
      assert.ok(fired >= 1, `expected watch callback, fired=${fired}`);
    });

    it('filesystem watch invalidates fingerprint memo after a write', async () => {
      const config = getDefaultConfig(root);
      config.cacheDir = path.join(testCacheDir, 'watch');
      const router = new ToolRouter(config);
      await router.initialize();
      const before = await router.cache.computeWorkspaceFingerprint(root);
      const probe = path.join(root, 'v051_watch_probe.txt');
      await fs.writeFile(probe, `watch-${Date.now()}`);
      try {
        await new Promise((r) => setTimeout(r, 500));
        const after = await router.cache.computeWorkspaceFingerprint(root);
        assert.notStrictEqual(after, before, 'watch or cheap probe must drop memo after a working-tree write');
      } finally {
        await fs.unlink(probe).catch(() => { });
        await router.dispose();
      }
    });

    it('same-path workspace_open refreshes the session fingerprint after a write', async () => {
      const config = getDefaultConfig(root);
      config.cacheDir = path.join(testCacheDir, 'same_path');
      const router = new ToolRouter(config);
      await router.initialize();
      const before = router.session.current!.fingerprint;
      const probe = path.join(root, 'v051_same_path_probe.txt');
      await fs.writeFile(probe, `dirty-${Date.now()}`);
      try {
        await router.openWorkspace(root);
        assert.notStrictEqual(router.session.current!.fingerprint, before);
      } finally {
        await fs.unlink(probe).catch(() => { });
        await router.dispose();
      }
    });

    it('oversized pack results spill to disk instead of staying in the heap cache', async () => {
      const cache = new CacheManager(path.join(testCacheDir, 'spill'), 20, 20, {
        maxEntryBytes: 800,
      });
      const config = getDefaultConfig(root);
      config.cacheDir = path.join(testCacheDir, 'spill');
      const adapter = new RepomixAdapter(config, cache);
      const bigRel = path.relative(root, path.join(testCacheDir, 'spill_src.txt')).replace(/\\/g, '/');
      await fs.writeFile(path.join(testCacheDir, 'spill_src.txt'), 'Q'.repeat(20_000));
      const packed = await adapter.packWorkspace({ candidateFiles: [bigRel], maxFiles: 1 });
      assert.strictEqual(packed.contentOmitted, true);
      assert.ok(packed.overflowPath);
      const spilled = await fs.readFile(packed.overflowPath!, 'utf-8');
      assert.ok(spilled.length >= 20_000);
      assert.ok(packed.content.includes('omitted from heap'));
      assert.ok(cache.estimatedMemoryBytes < 20_000 * 2);
    });
  });
});
