import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { CacheManager } from '../src/Core/Cache.js';
import { WorkspaceManager } from '../src/Core/Workspace.js';
import { getDefaultConfig, WINCODE_VERSION } from '../src/Core/Config.js';
import { SerenaAdapter } from '../src/Adapters/SerenaAdapter.js';
import { RepomixAdapter } from '../src/Adapters/RepomixAdapter.js';
import { ToolRouter } from '../src/Core/ToolRouter.js';
import { WinCodeMcpServer } from '../src/Gateway/McpServer.js';
import { Mutex, ResourceManager, TimeoutError, withTimeout, killProcessTree } from '../src/Core/ResourceManager.js';
import { SessionManager } from '../src/Core/SessionManager.js';
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
    it('awaited deadlines settle without unrelated active handles and settled operations release their timer', async () => {
      const moduleUrl = pathToFileURL(path.join(root, 'src/Core/ResourceManager.ts')).href;
      const run = promisify(execFile);
      const cases = [
        `try { await withTimeout(new Promise(() => {}), 40, 'isolated'); throw Error('Unexpected completion'); }
         catch (error) { if (!(error instanceof TimeoutError)) throw error; console.log('deadline observed'); }`,
        `console.log(await withTimeout(Promise.resolve('settled'), 30000, 'isolated'));`,
      ];
      for (const [index, body] of cases.entries()) {
        const result = await run(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval',
          `import { withTimeout, TimeoutError } from ${JSON.stringify(moduleUrl)}; ${body}`],
        { cwd: root, windowsHide: true, timeout: 10000 });
        assert.match(result.stdout, index === 0 ? /deadline observed/ : /settled/);
      }
    });

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
        await fs.unlink(probe).catch(() => {});
        await router.dispose();
      }
    });

    it('same-path workspace_open with a dirty tree marks Serena project stale', async () => {
      const config = getDefaultConfig(root);
      config.cacheDir = path.join(testCacheDir, 'same_path');
      const router = new ToolRouter(config);
      await router.initialize();
      (router.serena as any).projectActive = true;
      const probe = path.join(root, 'v051_same_path_probe.txt');
      await fs.writeFile(probe, `dirty-${Date.now()}`);
      try {
        await router.openWorkspace(root);
        assert.strictEqual(router.serena.getUpstreamStatus().projectActive, null);
      } finally {
        await fs.unlink(probe).catch(() => {});
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

    it('mock Serena stdio handshake is source=serena-mcp, not command-found', async () => {
      const config = getDefaultConfig(root);
      config.cacheDir = path.join(testCacheDir, 'mock_serena');
      config.adapters.serena.customCommand = process.execPath;
      config.adapters.serena.customArgs = [path.resolve(root, 'tests/fixtures/mock-serena-mcp.mjs')];
      config.timeouts.serenaConnectMs = 8_000;
      config.timeouts.serenaCallMs = 5_000;
      const adapter = new SerenaAdapter(config, new CacheManager(config.cacheDir));
      await adapter.initialize();
      try {
        const connected = await adapter.ensureConnected();
        assert.strictEqual(connected, true);
        const status = adapter.getUpstreamStatus();
        assert.strictEqual(status.commandFound, true);
        assert.strictEqual(status.handshakeOk, true);
        const symbols = await adapter.findSymbolsDetailed('MockService');
        assert.strictEqual(symbols.source, 'serena-mcp');
        assert.strictEqual(symbols.queryComplete, true);
        assert.ok(symbols.symbols.some((s) => s.name === 'MockService'));
        assert.strictEqual(adapter.getUpstreamStatus().projectActive, true);
        assert.strictEqual(adapter.getUpstreamStatus().semanticQueryUsable, true);
        assert.strictEqual(adapter.getUpstreamStatus().mode, 'connected');
      } finally {
        await adapter.dispose();
      }
    });
  });

  describe('Stage 1 critical robustness fixes', () => {
    it('CacheManager: targetFilePath is locked before enqueueWrite, avoiding namespace drift', async () => {
      const cache = new CacheManager(path.join(testCacheDir, 'ns_drift'));
      await cache.initialize();
      cache.setNamespace(path.join(root, 'projectA'));
      // Schedule a write
      const p = cache.set('drift_key', { project: 'A' });
      // Immediately switch namespace before the write chain completes
      cache.setNamespace(path.join(root, 'projectB'));
      await p;
      // Retrieve from projectA namespace
      cache.setNamespace(path.join(root, 'projectA'));
      const hitA = await cache.get<{ project: string }>('drift_key');
      assert.strictEqual(hitA?.project, 'A', 'Data must be found under projectA');
      // Ensure it did not drift to projectB
      cache.setNamespace(path.join(root, 'projectB'));
      const hitB = await cache.get('drift_key');
      assert.strictEqual(hitB, null, 'Data must NOT have drifted into projectB');
    });

    it('ToolRouter: slow in-flight queries drain before openWorkspace and new queries queue', async () => {
      const config = getDefaultConfig(root);
      config.cacheDir = path.join(testCacheDir, 'drain_switch');
      const router = new ToolRouter(config);
      await router.initialize();

      let queryFinished = false;
      await router.acquireRequestSlot();
      const slowOp = (async () => {
        await new Promise((r) => setTimeout(r, 60));
        queryFinished = true;
        router.endRequest();
      })();

      const switchOp = router.openWorkspace(FIXTURE_DOTNET);
      await switchOp;
      assert.strictEqual(queryFinished, true, 'openWorkspace must wait for in-flight requests to drain');
      assert.strictEqual(router.session.current?.workspaceRoot, FIXTURE_DOTNET);

      await router.openWorkspace(root);
      await router.dispose();
    });

    it('ToolRouter & McpServer: openWorkspace rejects switch and preserves workspace if in-flight queries do not drain', async () => {
      const config = getDefaultConfig(root);
      config.cacheDir = path.join(testCacheDir, 'drain_timeout');
      config.timeouts.shutdownMs = 60; // short drain timeout
      const router = new ToolRouter(config);
      await router.initialize();

      // Hold an in-flight slot that will NOT end in time
      await router.acquireRequestSlot();
      try {
        await assert.rejects(
          async () => {
            await router.openWorkspace(FIXTURE_DOTNET);
          },
          /Workspace switch rejected: in-flight queries failed to drain/
        );
        // Ensure workspace was NOT changed and remains root
        assert.strictEqual(router.config.workspaceRoot, root);
      } finally {
        router.endRequest();
        await router.dispose();
      }
    });

    it('McpServer: workspace_open does not increment in-flight and completes promptly without self-wait', async () => {
      const config = getDefaultConfig(root);
      config.cacheDir = path.join(testCacheDir, 'server_ws_open');
      const router = new ToolRouter(config);
      const server = new WinCodeMcpServer(router);
      await router.initialize();

      const t0 = Date.now();
      await router.openWorkspace(FIXTURE_DOTNET);
      const elapsed = Date.now() - t0;
      assert.strictEqual(router.inFlightRequests, 0, 'Switch op must not leave in-flight request dangling');
      assert.ok(elapsed < 4000, `Switch must not wait out drain timeout, took ${elapsed}ms`);

      await router.openWorkspace(root);
      await server.stop();
    });

    it('SerenaAdapter: timeout before handshake reaps the process tree before closing transport', async () => {
      const config = getDefaultConfig(root);
      config.cacheDir = path.join(testCacheDir, 'hang_cleanup');
      config.adapters.serena.customCommand = process.execPath;
      config.adapters.serena.customArgs = [path.resolve(root, 'tests/fixtures/mock-serena-mcp.mjs'), '--hang-init'];
      config.timeouts.serenaConnectMs = 150;
      const adapter = new SerenaAdapter(config, new CacheManager(config.cacheDir));
      await adapter.initialize();
      try {
        const connected = await adapter.ensureConnected();
        assert.strictEqual(connected, false);
        assert.strictEqual((adapter as any).isConnectedToSerena, false);
        assert.strictEqual((adapter as any).serenaPid, null);

        const killedPid = adapter.getLastHandshakeFailedPid();
        if (killedPid && process.platform === 'win32') {
          await new Promise((r) => setTimeout(r, 400));
          assert.strictEqual(await pidAlive(killedPid), false, 'Handshake-failed child process must be reaped');
        }
      } finally {
        await adapter.dispose();
      }
    });

    it('CacheManager: pruneDiskCache counts overflow size, enforces maxDiskBytes, respects grace period & memory protection', async () => {
      const cache = new CacheManager(path.join(testCacheDir, 'overflow_deep'), 50, 50, {
        maxDiskBytes: 15_000,
        maxEntryBytes: 10_000,
      });
      await cache.initialize();
      const overflowDir = path.join(testCacheDir, 'overflow_deep', 'overflow');
      await fs.mkdir(overflowDir, { recursive: true });

      // 1. Fresh orphan within grace period: must NOT be deleted
      const freshOrphan = path.resolve(overflowDir, 'fresh_orphan.txt');
      await fs.writeFile(freshOrphan, 'X'.repeat(200));
      await cache.pruneDiskCache({ orphanGraceMs: 60_000 });
      assert.strictEqual(await fs.stat(freshOrphan).then(() => true).catch(() => false), true, 'Fresh orphan within grace period must be kept');

      // 2. Expired orphan beyond grace period: SHOULD be deleted
      await cache.pruneDiskCache({ orphanGraceMs: 0 });
      assert.strictEqual(await fs.stat(freshOrphan).then(() => true).catch(() => false), false, 'Expired orphan must be reaped');

      // 3. Overflow size counted in totalDiskBytes: large overflow causes eviction of oldest entry
      const oldOverflow = path.resolve(overflowDir, 'old_overflow.txt');
      await fs.writeFile(oldOverflow, 'A'.repeat(8_000));
      await cache.set('item_old', { overflowPath: oldOverflow, tag: 'old' });

      await new Promise((r) => setTimeout(r, 30));

      const newOverflow = path.resolve(overflowDir, 'new_overflow.txt');
      await fs.writeFile(newOverflow, 'B'.repeat(8_000));
      await cache.set('item_new', { overflowPath: newOverflow, tag: 'new' });

      // Total overflow is 16,000 bytes > maxDiskBytes (15,000). Prune must evict item_old and delete old_overflow.txt!
      await cache.pruneDiskCache();

      const oldOverflowExists = await fs.stat(oldOverflow).then(() => true).catch(() => false);
      assert.strictEqual(oldOverflowExists, false, 'Old overflow must be deleted when item_old is evicted by capacity');

      const newOverflowExists = await fs.stat(newOverflow).then(() => true).catch(() => false);
      assert.strictEqual(newOverflowExists, true, 'New overflow must be retained within capacity');

      // 4. Memory-cached overflow file is protected even if not in disk JSON
      const memOverflow = path.resolve(overflowDir, 'mem_overflow.txt');
      await fs.writeFile(memOverflow, 'C'.repeat(500));
      (cache as any).memoryCache.set('mem_only', {
        timestamp: Date.now(),
        data: { overflowPath: memOverflow },
        byteSize: 100,
      });
      await cache.pruneDiskCache({ orphanGraceMs: 0 });
      assert.strictEqual(await fs.stat(memOverflow).then(() => true).catch(() => false), true, 'Memory-referenced overflow must not be deleted as orphan');
    });

    it('ImpactAnalyzer: distinguishes relative paths from bare basenames and preserves ambiguity', async () => {
      const mockSerena = {
        findSymbolsDetailed: async (query: string) => {
          return {
            query,
            totalFound: 2,
            symbols: [
              { name: 'Save', kind: 'class', file: 'src/A/Save.cs', line: 10 },
              { name: 'Save', kind: 'class', file: 'src/B/Save.cs', line: 20 },
            ],
            source: 'serena-mcp',
            queryComplete: true,
            uniqueTypeMatch: false,
            typeMatchCount: 2,
          };
        },
        findReferencesDetailed: async () => ({
          symbolName: 'Save',
          totalReferences: 0,
          references: [],
          source: 'serena-mcp',
          queryComplete: true,
        }),
      } as any;

      const { ImpactAnalyzer } = await import('../src/CompositeTools/ImpactAnalyzer.js');
      const analyzer = new ImpactAnalyzer(mockSerena);

      // 1. Precise path with directory component resolves uniquely to that file
      const reportA = await analyzer.analyzeImpact('src/A/Save.cs');
      assert.strictEqual(reportA.uniqueResolution, true, 'Specific path src/A/Save.cs must resolve uniquely');
      assert.strictEqual(reportA.targetFile, 'Save.cs');

      const reportB = await analyzer.analyzeImpact('src/B/Save.cs');
      assert.strictEqual(reportB.uniqueResolution, true, 'Specific path src/B/Save.cs must resolve uniquely');

      // 2. Pure filename without directory matches both files and preserves ambiguity (uniqueResolution=false)
      const reportAmbiguous = await analyzer.analyzeImpact('Save.cs');
      assert.strictEqual(reportAmbiguous.uniqueResolution, false, 'Ambiguous filename Save.cs must have uniqueResolution=false');
      assert.ok(reportAmbiguous.limitations.some((l) => l.includes('未能唯一解析')));
    });

    it('ImpactAnalyzer: unresolved explicitFileHint strictly returns uniqueResolution=false and UNKNOWN', async () => {
      const config = getDefaultConfig(FIXTURE_DOTNET);
      config.cacheDir = path.join(testCacheDir, 'impact_unique');
      const router = new ToolRouter(config);
      await router.initialize();

      const report = await router.impact.analyzeImpact('TotallyNonExistentHelper.cs');
      assert.strictEqual(report.uniqueResolution, false, 'Unresolved file target must have uniqueResolution=false');
      assert.strictEqual(report.riskLevel, 'UNKNOWN');
      assert.strictEqual(report.confidence, 'UNCERTAIN');
      assert.strictEqual(report.analysisCompleteness, 'unindexed');

      await router.dispose();
    });

    it('CacheManager: computeWorkspaceFingerprint handles non-ASCII and detects in-place content modifications', async () => {
      const cache = new CacheManager(testCacheDir);
      const fp0 = await cache.computeWorkspaceFingerprint(root, { fresh: true });
      assert.ok(fp0 && typeof fp0 === 'string' && fp0.length > 0);

      const probeChinese = path.join(root, '初步构思_probe.txt');
      await fs.writeFile(probeChinese, '初始内容');
      try {
        const fp1 = await cache.computeWorkspaceFingerprint(root, { fresh: true });
        assert.notStrictEqual(fp1, fp0, 'Adding Chinese named file must change fingerprint');

        // Modify in-place: content and mtime change, no add/delete
        await new Promise((r) => setTimeout(r, 100));
        await fs.writeFile(probeChinese, '修改后的中文内容（长度与mtime均改变）');

        const fp2 = await cache.computeWorkspaceFingerprint(root, { fresh: true });
        assert.notStrictEqual(fp2, fp1, 'Modifying content of Chinese named file must change fingerprint');
      } finally {
        await fs.unlink(probeChinese).catch(() => {});
      }
    });
  });
});
