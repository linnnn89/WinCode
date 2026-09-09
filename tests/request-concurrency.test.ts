import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import { getDefaultConfig, WINCODE_VERSION } from '../src/Core/Config.js';

import { ToolRouter } from '../src/Core/ToolRouter.js';

import { Mutex } from '../src/Core/ResourceManager.js';
import { SessionManager } from '../src/Core/SessionManager.js';

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
describe('request-concurrency', () => {
  const root = process.cwd();
  const testCacheDir = path.join(root, '.cache', `test_request-concurrency_${process.pid}`);

  before(async () => {
    await fs.mkdir(testCacheDir, { recursive: true });
  });
  after(async () => {
    await fs.rm(testCacheDir, { recursive: true, force: true }).catch(() => { });
  });
  describe('Concurrency and session', () => {
    it('Mutex serializes overlapping workspace switches', async () => {
      const mutex = new Mutex();
      const order: number[] = [];
      await Promise.all([
        mutex.runExclusive(async () => {
          order.push(1);
          await new Promise((r) => setTimeout(r, 30));
          order.push(2);
        }),
        mutex.runExclusive(async () => {
          order.push(3);
          order.push(4);
        }),
      ]);
      assert.deepStrictEqual(order, [1, 2, 3, 4]);
    });

    it('SessionManager records workspace + cache namespace + activity', () => {
      const sessions = new SessionManager();
      const first = sessions.open(root, 'ns1');
      assert.strictEqual(first.workspaceRoot, root);
      assert.strictEqual(first.cacheNamespace, 'ns1');
      assert.ok(first.createdAt <= first.lastActivity);
      sessions.touch();
      assert.ok(sessions.current && sessions.current.lastActivity >= first.createdAt);
      sessions.close();
      assert.strictEqual(sessions.current, null);
    });

    it('runtime health exposes uptime, cache, workspace, and layered Local text fields', async () => {
      const config = getDefaultConfig(root);
      config.cacheDir = path.join(testCacheDir, 'health');
      const router = new ToolRouter(config);
      await router.initialize();
      const health = await router.getRuntimeHealth();
      assert.strictEqual(health.version, WINCODE_VERSION);
      assert.strictEqual(health.status, 'online');
      assert.ok(health.uptimeMs >= 0);
      assert.strictEqual(health.activeWorkspace, path.resolve(root));
      assert.strictEqual(health.text.available, true);
      assert.strictEqual(health.codeProvider, 'local-text');
      assert.strictEqual(typeof health.cache.memoryEntries, 'number');
      assert.strictEqual(typeof health.cache.estimatedMemoryBytes, 'number');
      assert.strictEqual(typeof health.managedChildProcesses, 'number');
      assert.ok(health.nodeMemory.heapUsed > 0);
      assert.strictEqual(health.text.semanticConfigured, false);
      await router.dispose();
    });
  });
});
