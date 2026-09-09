import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { CacheManager } from '../src/Core/Cache.js';

import { getDefaultConfig } from '../src/Core/Config.js';
import { LocalTextAdapter } from '../src/Adapters/LocalTextAdapter.js';

// 每个功能套件拥有独立缓存；并行文件不能删除彼此正在使用的缓存。
describe('text-symbols', () => {
  const root = process.cwd();
  const testCacheDir = path.join(root, '.cache', `test_text-symbols_${process.pid}`);
  const config = getDefaultConfig(root);
  config.cacheDir = testCacheDir;
  const FIXTURE_DOTNET = path.resolve(root, 'tests/fixtures/dotnet-mini');

  before(async () => {
    await fs.mkdir(testCacheDir, { recursive: true });
  });
  after(async () => {
    await fs.rm(testCacheDir, { recursive: true, force: true }).catch(() => { });
  });
  describe('3. Adapters: LocalTextAdapter Symbol Extraction & Reference Tracking', () => {
    const cache = new CacheManager(testCacheDir);
    const text = new LocalTextAdapter(config, cache);

    it('should extract class, interface, method, and function symbols across the repo', async () => {
      const classes = await text.findSymbols('ToolRouter', 'class');
      assert.ok(classes.length > 0);
      assert.strictEqual(classes[0].name, 'ToolRouter');
      assert.strictEqual(classes[0].kind, 'class');

      const interfaces = await text.findSymbols('IAdapter', 'interface');
      assert.ok(interfaces.length > 0);
      assert.strictEqual(interfaces[0].name, 'IAdapter');
      assert.strictEqual(interfaces[0].kind, 'interface');
    });

    it('should find accurate symbol references with word boundaries', async () => {
      const refs = await text.findReferences('ToolRouter');
      assert.ok(refs.length > 0);
      for (const ref of refs) {
        assert.ok(ref.file);
        assert.ok(ref.line > 0);
        assert.ok(ref.preview.includes('ToolRouter'));
      }
    });

    it('should return empty results for non-existent symbols without throwing', async () => {
      const dynamicName = 'SYM_RANDOM_' + Math.random().toString(36).substring(2) + '_XYZ';
      const missing = await text.findSymbols(dynamicName);
      assert.deepStrictEqual(missing, []);

      const missingRefs = await text.findReferences(dynamicName);
      assert.deepStrictEqual(missingRefs, []);
    });

    it('Phase 4: LocalTextAdapter should index C# classes and references in the portable .NET fixture', async () => {
      const fixtureConfig = getDefaultConfig(FIXTURE_DOTNET);
      fixtureConfig.cacheDir = testCacheDir;
      const fixtureQueries = new LocalTextAdapter(fixtureConfig, cache);
      const symResult = await fixtureQueries.findSymbolsDetailed('MainWindow');
      assert.ok(symResult.symbols.length > 0);
      assert.ok(symResult.symbols.some((s) => s.name === 'MainWindow' && s.kind === 'class'));
      assert.strictEqual(symResult.uniqueTypeMatch, true);
      assert.strictEqual(symResult.queryComplete, true);

      const refResult = await fixtureQueries.findReferencesDetailed('MemoryService');
      assert.ok(refResult.totalReferences > 0);
      assert.ok(refResult.references.some((r) => r.file.replace(/\\/g, '/').includes('SaveManager.cs')));
      assert.ok(refResult.references.some((r) => r.file.replace(/\\/g, '/').includes('MainWindow.xaml.cs')));
    });
  });
});
