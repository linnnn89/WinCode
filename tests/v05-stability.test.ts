import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CacheManager } from '../src/Core/Cache.js';
import { WorkspaceManager } from '../src/Core/Workspace.js';
import { getDefaultConfig, WINCODE_VERSION } from '../src/Core/Config.js';
import { SerenaAdapter } from '../src/Adapters/SerenaAdapter.js';
import { ToolRouter } from '../src/Core/ToolRouter.js';
import { WinCodeMcpServer } from '../src/Gateway/McpServer.js';
import { Mutex, ResourceManager, TimeoutError, withTimeout } from '../src/Core/ResourceManager.js';
import { SessionManager } from '../src/Core/SessionManager.js';

describe('WinCode v0.5 stability', () => {
  const root = process.cwd();
  const testCacheDir = path.join(root, '.cache', 'test_cache_v05');
  const FIXTURE_DOTNET = path.resolve(root, 'tests/fixtures/dotnet-mini');

  before(async () => {
    await fs.mkdir(testCacheDir, { recursive: true });
  });

  after(async () => {
    await fs.rm(testCacheDir, { recursive: true, force: true }).catch(() => {});
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

    it('Serena crash (thrown callTool) resets the connection and still returns local fallback', async () => {
      const config = getDefaultConfig(root);
      config.cacheDir = testCacheDir;
      const adapter = new SerenaAdapter(config, new CacheManager(testCacheDir));
      (adapter as any).isConnectedToSerena = true;
      (adapter as any).serenaTools = new Set(['find_symbol']);
      (adapter as any).serenaClient = {
        callTool: async () => {
          throw new Error('simulated serena crash');
        },
        close: async () => {},
      };
      (adapter as any).serenaTransport = { close: async () => {} };

      const result = await adapter.findSymbolsDetailed('ToolRouter');
      assert.strictEqual(result.source, 'serena-adapter-fallback');
      assert.strictEqual(result.queryComplete, false);
      assert.ok(result.symbols.length > 0);
      assert.strictEqual((adapter as any).isConnectedToSerena, false);
      assert.strictEqual((adapter as any).serenaClient, null);
      assert.ok(adapter.lastError);
      assert.strictEqual(adapter.lastError?.recoverable, true);
    });

    it('workspace A → workspace B switches session namespace and does not leak symbols', async () => {
      const config = getDefaultConfig(root);
      config.cacheDir = path.join(testCacheDir, 'ws_switch');
      const router = new ToolRouter(config);
      await router.initialize();

      const nsA = router.cache.currentNamespace;
      await router.cache.set('leak_probe', { workspace: 'A' });
      assert.ok(await router.cache.get('leak_probe'));

      const opened = await router.openWorkspace(FIXTURE_DOTNET);
      assert.strictEqual(opened.type, 'dotnet');
      const nsB = router.cache.currentNamespace;
      assert.notStrictEqual(nsB, nsA);
      assert.strictEqual(router.session.current?.workspaceRoot, FIXTURE_DOTNET);
      assert.strictEqual(await router.cache.get('leak_probe'), null, 'memory/namespace must not leak project A keys');

      const symbols = await router.serena.findSymbols('MemoryService', 'class');
      assert.ok(symbols.some((s) => s.name === 'MemoryService'));
      assert.ok(symbols.every((s) => s.file.replace(/\\/g, '/').includes('MiniDesk') || s.file.endsWith('MemoryService.cs') || s.file.includes('Core')));

      await router.openWorkspace(root);
      assert.strictEqual(path.resolve(router.config.workspaceRoot), path.resolve(root));
      await router.dispose();
    });
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

  describe('Failure', () => {
    it('Serena MCP timeout becomes a structured incomplete query and does not crash', async () => {
      const config = getDefaultConfig(root);
      config.cacheDir = testCacheDir;
      config.timeouts.serenaCallMs = 40;
      const adapter = new SerenaAdapter(config, new CacheManager(testCacheDir));
      (adapter as any).isConnectedToSerena = true;
      (adapter as any).serenaTools = new Set(['find_symbol']);
      (adapter as any).serenaClient = {
        callTool: () => new Promise(() => {}),
        close: async () => {},
      };
      (adapter as any).serenaTransport = { close: async () => {} };

      const result = await adapter.findSymbolsDetailed('ToolRouter');
      assert.strictEqual(result.queryComplete, false);
      assert.ok(result.queryError && /timed out/i.test(result.queryError));
      assert.strictEqual(result.source, 'serena-adapter-fallback');
      assert.ok(result.symbols.length > 0);
      assert.strictEqual(adapter.lastError?.reason, 'timeout');
      assert.strictEqual(adapter.lastError?.recoverable, true);
    });

    it('Repomix health timeout is a fallback, not a throw', async () => {
      const config = getDefaultConfig(root);
      config.cacheDir = testCacheDir;
      const { RepomixAdapter } = await import('../src/Adapters/RepomixAdapter.js');
      const adapter = new RepomixAdapter(config, new CacheManager(testCacheDir));
      const health = await adapter.checkHealth(30);
      assert.strictEqual(health.available, true);
      assert.ok(health.source === 'fallback' || health.source === 'installed');
    });

    it('git-less workspace is reported, not thrown', async () => {
      const tmp = path.join(testCacheDir, 'nongit_ws');
      await fs.mkdir(tmp, { recursive: true });
      await fs.writeFile(path.join(tmp, 'readme.txt'), 'x');
      const ws = new WorkspaceManager(getDefaultConfig(tmp));
      const git = await ws.getGitStatus();
      assert.strictEqual(git.isGit, false);
    });

    it('malformed workspace path fails with a structured error', async () => {
      const ws = new WorkspaceManager(getDefaultConfig(root));
      const filePath = path.join(testCacheDir, 'not_a_dir.txt');
      await fs.writeFile(filePath, 'nope');
      await assert.rejects(() => ws.openWorkspace(filePath), /Invalid workspace path/);
      await assert.rejects(() => ws.openWorkspace(path.join(testCacheDir, 'missing_dir_zzz')), /Invalid workspace path/);
    });

    it('withTimeout converts hangs into TimeoutError without rejecting later', async () => {
      await assert.rejects(
        () => withTimeout(new Promise(() => {}), 30, 'probe'),
        (err: unknown) => err instanceof TimeoutError && err.provider === 'probe'
      );
    });

    it('shutdown during an active request drains then completes; second stop is a no-op', async () => {
      const config = getDefaultConfig(root);
      config.cacheDir = path.join(testCacheDir, 'drain');
      config.timeouts.shutdownMs = 2_000;
      const router = new ToolRouter(config);
      await router.initialize();
      router.beginRequest();
      const stop = router.dispose();
      assert.strictEqual(router.isShuttingDown, true);
      await new Promise((r) => setTimeout(r, 40));
      router.endRequest();
      await stop;
      await router.dispose();
      assert.strictEqual(router.inFlightRequests, 0);
    });
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

    it('two concurrent Serena connects share one in-flight promise', async () => {
      const config = getDefaultConfig(root);
      config.adapters.serena.customCommand = 'non_existent_serena_cmd_v05';
      const adapter = new SerenaAdapter(config, new CacheManager(testCacheDir));
      await adapter.initialize();
      const [a, b] = await Promise.all([adapter.ensureConnected(), adapter.ensureConnected()]);
      assert.strictEqual(a, false);
      assert.strictEqual(b, false);
      assert.strictEqual((adapter as any).serenaClient, null);
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

    it('runtime health exposes uptime, cache, workspace, and layered Serena fields', async () => {
      const config = getDefaultConfig(root);
      config.cacheDir = path.join(testCacheDir, 'health');
      const router = new ToolRouter(config);
      await router.initialize();
      const health = await router.getRuntimeHealth();
      assert.strictEqual(health.version, WINCODE_VERSION);
      assert.strictEqual(health.status, 'online');
      assert.ok(health.uptimeMs >= 0);
      assert.strictEqual(health.activeWorkspace, path.resolve(root));
      assert.strictEqual(typeof health.serena.commandFound, 'boolean');
      assert.strictEqual(typeof health.serena.handshakeOk, 'boolean');
      assert.strictEqual(typeof health.cache.memoryEntries, 'number');
      assert.strictEqual(typeof health.cache.estimatedMemoryBytes, 'number');
      assert.strictEqual(typeof health.managedChildProcesses, 'number');
      assert.ok(health.nodeMemory.heapUsed > 0);
      if (health.serena.projectActive !== true) {
        assert.strictEqual(health.serena.semanticQueryUsable, false);
        assert.strictEqual(health.serena.mode, 'degraded');
      }
      await router.dispose();
    });
  });

  describe('v0.4 regression guards', () => {
    it('source still does not imply connected; 0 refs stay UNKNOWN', async () => {
      const config = getDefaultConfig(FIXTURE_DOTNET);
      config.cacheDir = path.join(testCacheDir, 'reg');
      const router = new ToolRouter(config);
      const health = await router.serena.checkHealth();
      assert.strictEqual(health.available, true);
      if (!health.upstream?.handshakeOk) {
        assert.notStrictEqual(health.source, 'installed');
      }
      const unused = await router.impact.analyzeImpact('UnusedHelper');
      assert.strictEqual(unused.riskLevel, 'UNKNOWN');
      assert.strictEqual(unused.confidence, 'UNCERTAIN');
      await router.dispose();
    });
  });
});
