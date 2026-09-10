import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { CacheManager } from '../src/Core/Cache.js';

import { getDefaultConfig } from '../src/Core/Config.js';

import { ToolRouter } from '../src/Core/ToolRouter.js';
import { WinCodeMcpServer } from '../src/Gateway/McpServer.js';

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
describe('resource-cleanup', () => {
  const root = process.cwd();
  const testCacheDir = path.join(root, '.cache', `test_resource-cleanup_${process.pid}`);
  const FIXTURE_DOTNET = path.resolve(root, 'tests/fixtures/dotnet-mini');
  before(async () => {
    await fs.mkdir(testCacheDir, { recursive: true });
  });
  after(async () => {
    await fs.rm(testCacheDir, { recursive: true, force: true }).catch(() => { });
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

    it('ToolRouter: slow in-flight queries drain before same-root resource recovery', async () => {
      const config = getDefaultConfig(root);
      config.cacheDir = path.join(testCacheDir, 'drain_switch');
      const router = new ToolRouter(config);
      await router.initialize();
      await (router as any).watch.stop();

      let queryFinished = false;
      await router.acquireRequestSlot();
      const slowOp = (async () => {
        await new Promise((r) => setTimeout(r, 60));
        queryFinished = true;
        router.endRequest();
      })();

      const switchOp = router.openWorkspace(root);
      await switchOp;
      assert.strictEqual(queryFinished, true, 'openWorkspace must wait for in-flight requests to drain');
      assert.strictEqual(router.session.current?.workspaceRoot, root);
      await slowOp;

      await router.openWorkspace(root);
      await router.dispose();
    });

    it('ToolRouter & McpServer: same-root recovery rejects when in-flight queries do not drain', async () => {
      const config = getDefaultConfig(root);
      config.cacheDir = path.join(testCacheDir, 'drain_timeout');
      config.timeouts.shutdownMs = 60; // short drain timeout
      const router = new ToolRouter(config);
      await router.initialize();
      await (router as any).watch.stop();

      // Hold an in-flight slot that will NOT end in time
      await router.acquireRequestSlot();
      try {
        await assert.rejects(
          async () => {
            await router.openWorkspace(root);
          },
          (error: any) => {
            assert.strictEqual(error.name, 'WorkspaceRecoveryRequiredError');
            assert.strictEqual(error.recovery.phase, 'drain');
            assert.match(error.recovery.message, /Workspace recovery rejected: in-flight queries failed to drain/);
            assert.strictEqual(error.recovery.recoveryAction, 'workspace_open');
            return true;
          }
        );
        // Ensure workspace was NOT changed and remains root
        assert.strictEqual(router.config.workspaceRoot, root);
        assert.strictEqual(router.inFlightRequests, 1, 'timeout must not release another request');
        await assert.rejects(router.acquireRequestSlot(), { name: 'WorkspaceRecoveryRequiredError' });
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
      await (router as any).watch.stop();

      const t0 = Date.now();
      await router.openWorkspace(root);
      const elapsed = Date.now() - t0;
      assert.strictEqual(router.inFlightRequests, 0, 'Recovery must not leave in-flight request dangling');
      assert.ok(elapsed < 4000, `Recovery must not wait out drain timeout, took ${elapsed}ms`);

      await router.openWorkspace(root);
      await server.stop();
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
      const freshOrphan = await cache.writeOverflow('X'.repeat(200));
      await cache.pruneDiskCache({ orphanGraceMs: 60_000 });
      assert.strictEqual(await fs.stat(freshOrphan).then(() => true).catch(() => false), true, 'Fresh orphan within grace period must be kept');

      // 2. Expired orphan beyond grace period: SHOULD be deleted
      await cache.pruneDiskCache({ orphanGraceMs: 0 });
      assert.strictEqual(await fs.stat(freshOrphan).then(() => true).catch(() => false), false, 'Expired orphan must be reaped');

      // 3. Overflow size counted in totalDiskBytes: large overflow causes eviction of oldest entry
      const oldOverflow = await cache.writeOverflow('A'.repeat(8_000));
      await cache.set('item_old', { overflowPath: oldOverflow, tag: 'old' });

      await new Promise((r) => setTimeout(r, 30));

      const newOverflow = await cache.writeOverflow('B'.repeat(8_000));
      await cache.set('item_new', { overflowPath: newOverflow, tag: 'new' });

      // Total overflow is 16,000 bytes > maxDiskBytes (15,000). Prune must evict item_old and its owned attachment.
      await cache.pruneDiskCache();

      const oldOverflowExists = await fs.stat(oldOverflow).then(() => true).catch(() => false);
      assert.strictEqual(oldOverflowExists, false, 'Old overflow must be deleted when item_old is evicted by capacity');

      const newOverflowExists = await fs.stat(newOverflow).then(() => true).catch(() => false);
      assert.strictEqual(newOverflowExists, true, 'New overflow must be retained within capacity');

      // 4. Memory-cached overflow file is protected even if not in disk JSON
      const memOverflow = await cache.writeOverflow('C'.repeat(500));
      (cache as any).memoryCache.set('mem_only', {
        timestamp: Date.now(),
        data: { overflowPath: memOverflow },
        byteSize: 100,
      });
      await cache.pruneDiskCache({ orphanGraceMs: 0 });
      assert.strictEqual(await fs.stat(memOverflow).then(() => true).catch(() => false), true, 'Memory-referenced overflow must not be deleted as orphan');
    });

    it('ImpactAnalyzer: distinguishes relative paths from bare basenames and preserves ambiguity', async () => {
      const mockQueries = {
        findSymbolsDetailed: async (query: string) => {
          return {
            query,
            totalFound: 2,
            symbols: [
              { name: 'Save', kind: 'class', file: 'src/A/Save.cs', line: 10 },
              { name: 'Save', kind: 'class', file: 'src/B/Save.cs', line: 20 },
            ],
            source: 'roslyn',
            queryComplete: true,
            uniqueTypeMatch: false,
            typeMatchCount: 2,
          };
        },
        findReferencesDetailed: async () => ({
          symbolName: 'Save',
          totalReferences: 0,
          references: [],
          source: 'roslyn',
          queryComplete: true,
        }),
      } as any;

      const { ImpactAnalyzer } = await import('../src/CompositeTools/ImpactAnalyzer.js');
      const analyzer = new ImpactAnalyzer(mockQueries);

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
        await fs.unlink(probeChinese).catch(() => { });
      }
    });
  });
});
