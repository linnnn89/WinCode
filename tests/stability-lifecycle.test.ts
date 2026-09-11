import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import { getDefaultConfig } from '../src/Core/Config.js';

import { ToolRouter } from '../src/Core/ToolRouter.js';
import { WinCodeMcpServer } from '../src/Gateway/McpServer.js';
import { ResourceManager } from '../src/Core/ResourceManager.js';

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
describe('stability-lifecycle', () => {
  const root = process.cwd();
  const testCacheDir = path.join(root, '.cache', `test_stability-lifecycle_${process.pid}`);
  const FIXTURE_DOTNET = path.resolve(root, 'tests/fixtures/dotnet-mini');
  before(async () => {
    await fs.mkdir(testCacheDir, { recursive: true });
  });
  after(async () => {
    await fs.rm(testCacheDir, { recursive: true, force: true }).catch(() => { });
  });
  describe('Lifecycle', () => {
    it('ResourceManager dispose is idempotent and safe to call twice', async () => {
      const resources = new ResourceManager();
      let closed = 0;
      resources.register('disposable', 'test', () => {
        closed++;
      });
      await resources.dispose();
      await resources.dispose();
      assert.strictEqual(closed, 1);
      assert.strictEqual(resources.isDisposed, true);
      assert.strictEqual(resources.childProcessCount(), 0);
    });

    it('server start → stop → stop does not throw', async () => {
      const config = getDefaultConfig(root);
      config.cacheDir = path.join(testCacheDir, 'server_stop');
      const router = new ToolRouter(config);
      const server = new WinCodeMcpServer(router);
      await router.initialize();
      await server.stop();
      await server.stop();
      assert.strictEqual(router.isShuttingDown, true);
      assert.strictEqual(router.resources.isDisposed, true);
    });

    it('independent fixed workspaces retain separate namespaces without leaking symbols', async () => {
      const config = getDefaultConfig(root);
      config.cacheDir = path.join(testCacheDir, 'ws_switch');
      const router = new ToolRouter(config);
      await router.initialize();

      const nsA = router.cache.currentNamespace;
      await router.cache.set('leak_probe', { workspace: 'A' });
      assert.ok(await router.cache.get('leak_probe'));

      await assert.rejects(router.openWorkspace(FIXTURE_DOTNET), (error: any) => error.errorCode === 'WORKSPACE_MISMATCH');
      const peerConfig = getDefaultConfig(FIXTURE_DOTNET);
      peerConfig.cacheDir = config.cacheDir;
      const peer = new ToolRouter(peerConfig);
      await peer.initialize();
      try {
        const opened = await peer.openWorkspace(FIXTURE_DOTNET);
        assert.strictEqual(opened.type, 'dotnet');
        const nsB = peer.cache.currentNamespace;
        assert.notStrictEqual(nsB, nsA);
        assert.strictEqual(peer.session.current?.workspaceRoot, FIXTURE_DOTNET);
        assert.strictEqual(await peer.cache.get('leak_probe'), null, 'memory/namespace must not leak project A keys');
        assert.deepStrictEqual(await router.cache.get('leak_probe'), { workspace: 'A' });

        const symbols = await peer.text.findSymbols('MemoryService', 'class');
        assert.ok(symbols.some((s) => s.name === 'MemoryService'));
        assert.ok(symbols.every((s) => s.file.replace(/\\/g, '/').includes('MiniDesk') || s.file.endsWith('MemoryService.cs') || s.file.includes('Core')));

        await router.openWorkspace(root);
        assert.strictEqual(path.resolve(router.config.workspaceRoot), path.resolve(root));
      } finally { await peer.dispose(); await router.dispose(); }
    });
  });
});
