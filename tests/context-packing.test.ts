import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { CacheManager } from '../src/Core/Cache.js';
import { WorkspaceManager } from '../src/Core/Workspace.js';
import { getDefaultConfig } from '../src/Core/Config.js';
import { LocalTextAdapter } from '../src/Adapters/LocalTextAdapter.js';
import { RepomixAdapter } from '../src/Adapters/RepomixAdapter.js';
import { ContextManager } from '../src/Core/Context.js';

// 每个功能套件拥有独立缓存；并行文件不能删除彼此正在使用的缓存。
describe('context-packing', () => {
  const root = process.cwd();
  const testCacheDir = path.join(root, '.cache', `test_context-packing_${process.pid}`);
  const config = getDefaultConfig(root);
  config.cacheDir = testCacheDir;

  before(async () => {
    await fs.mkdir(testCacheDir, { recursive: true });
  });
  after(async () => {
    await fs.rm(testCacheDir, { recursive: true, force: true }).catch(() => { });
  });
  describe('4. Adapters: RepomixAdapter & ContextManager', () => {
    const cache = new CacheManager(testCacheDir);
    const ws = new WorkspaceManager(config);
    const repomix = new RepomixAdapter(config, cache);
    const text = new LocalTextAdapter(config, cache);
    const context = new ContextManager(config, ws, repomix, text);

    it('should pack workspace without including ignored paths', async () => {
      const pack = await repomix.packWorkspace({ maxFiles: 20 });
      assert.ok(pack.fileCount > 0);
      assert.ok(pack.content.length > 0);

      // Verify file headers: no files from node_modules, dist, or trash were packed
      const packedFileHeaders = pack.content
        .split('\n')
        .filter((line) => line.startsWith('File: '))
        .map((line) => line.replace('File: ', '').trim());

      assert.ok(packedFileHeaders.length > 0, 'Should have packed file headers');
      for (const header of packedFileHeaders) {
        assert.ok(!header.startsWith('node_modules'), `Must not pack node_modules: ${header}`);
        assert.ok(!header.startsWith('dist'), `Must not pack dist: ${header}`);
        assert.ok(!header.startsWith('trash'), `Must not pack trash: ${header}`);
        assert.ok(!header.includes('package-lock.json'), `Must not pack package-lock.json: ${header}`);
      }
    });

    it('Phase 3: should format architecture analysis context with Repomix snapshot and guidance', async () => {
      const prep = await context.prepareContext({ task: '分析这个项目架构' });
      assert.strictEqual(prep.task, '分析这个项目架构');
      assert.ok(prep.project.name);
      assert.ok(prep.guidance.length > 0);
      assert.ok(prep.executiveSummary.includes('Target Task'));
      assert.ok(prep.formattedContent.includes('Evidence'));
    });

    it('Resilience: checkHealth should respect timeout, terminate hung process tree, and gracefully fallback', async () => {
      const cli = path.join(testCacheDir, 'hung-health.cjs');
      await fs.writeFile(cli, 'setInterval(() => {}, 1000);');
      const isolatedConfig = structuredClone(config);
      isolatedConfig.adapters.repomix.customCliPath = cli;
      const slowRepomix = new RepomixAdapter(isolatedConfig, cache);
      const startTime = Date.now();

      // Test with a tiny timeout (50ms) to ensure timeout handling kicks in without hanging
      const health = await slowRepomix.checkHealth(50);
      const elapsed = Date.now() - startTime;

      assert.ok(health.available, 'Should be marked available');
      assert.strictEqual(health.source, 'fallback');
      assert.strictEqual(slowRepomix.lastError?.reason, 'timeout');
      assert.ok(elapsed < 2000, `Health check must not block, took ${elapsed}ms`);
      assert.strictEqual(slowRepomix.activeProcessCount, 0, 'Active process count must be 0 after completion or timeout');
    });

    it('Process Management & Dispose: should terminate all active child process trees on dispose()', async () => {
      const cli = path.join(testCacheDir, 'dispose-health.cjs');
      await fs.writeFile(cli, 'setInterval(() => {}, 1000);');
      const isolatedConfig = structuredClone(config);
      isolatedConfig.adapters.repomix.customCliPath = cli;
      const managedRepomix = new RepomixAdapter(isolatedConfig, cache);

      // Start a long-running child process simulated via checkHealth with large timeout
      const healthPromise = managedRepomix.checkHealth(15000);

      // Give it a few ms to spawn the child process
      for (let attempts = 0; attempts < 100 && managedRepomix.activeProcessCount === 0; attempts++)
        await new Promise((r) => setTimeout(r, 20));

      assert.ok(managedRepomix.activeProcessCount >= 1, 'Should track active child process');

      // Call dispose, which must kill the process tree and clear tracking
      await managedRepomix.dispose();
      assert.strictEqual(managedRepomix.activeProcessCount, 0, 'activeProcessCount must be 0 after dispose');

      // The health check promise should settle gracefully without throwing unhandled rejection
      const result = await healthPromise;
      assert.ok(result.available);
    });

    it('P2 Fix: fallback packer must strictly cap files at maxFiles (e.g. maxFiles: 1)', async () => {
      const fallbackResult = await (repomix as any).packWithFallback({ maxFiles: 1 });
      assert.strictEqual(fallbackResult.fileCount, 1, 'maxFiles: 1 must collect strictly 1 file');
    });

    it('P2 Fix: fallback packer must output valid XML when outputFormat is xml', async () => {
      const xmlResult = await (repomix as any).packWithFallback({ outputFormat: 'xml', maxFiles: 2 });
      assert.ok(xmlResult.content.includes('<project_context'));
      assert.ok(xmlResult.content.includes('<file path='));
      assert.ok(xmlResult.content.includes('</project_context>'));
    });

    it('v0.4: empty candidateFiles is a closed set and must not dump the workspace', async () => {
      const empty = await (repomix as any).packWithFallback({ candidateFiles: [], maxFiles: 20 });
      assert.strictEqual(empty.fileCount, 0);
      assert.ok(!empty.content.includes('src/Core/ToolRouter.ts'));
    });

    it('P2 Fix: candidateFiles and focusAreas filtering must be respected', async () => {
      const candResult = await (repomix as any).packWithFallback({
        candidateFiles: ['package.json'],
        maxFiles: 5,
      });
      assert.strictEqual(candResult.fileCount, 1);
      assert.ok(candResult.content.includes('package.json'));

      const focusResult = await (repomix as any).packWithFallback({
        include: ['src/Gateway'],
        maxFiles: 10,
      });
      assert.ok(focusResult.fileCount > 0);
      assert.ok(focusResult.content.includes('src/Gateway'));
    });
  });
});
