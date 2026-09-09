import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { CacheManager } from '../src/Core/Cache.js';
import { WorkspaceManager } from '../src/Core/Workspace.js';
import { getDefaultConfig } from '../src/Core/Config.js';
import { LocalTextAdapter } from '../src/Adapters/LocalTextAdapter.js';

import { ImpactAnalyzer } from '../src/CompositeTools/ImpactAnalyzer.js';

import { ToolRouter } from '../src/Core/ToolRouter.js';

// 每个功能套件拥有独立缓存；并行文件不能删除彼此正在使用的缓存。
describe('composite-tools', () => {
  const root = process.cwd();
  const testCacheDir = path.join(root, '.cache', `test_composite-tools_${process.pid}`);
  const config = getDefaultConfig(root);
  config.cacheDir = testCacheDir;
  const FIXTURE_DOTNET = path.resolve(root, 'tests/fixtures/dotnet-mini');
  const TAVERN_PATH = process.env.WINCODE_TAVERN_PATH
    ? path.resolve(process.env.WINCODE_TAVERN_PATH)
    : path.resolve('d:/CODEX PROJECT/New-tavern');
  const HAS_TAVERN = existsSync(path.join(TAVERN_PATH, 'TavernDesk.sln'));
  before(async () => {
    await fs.mkdir(testCacheDir, { recursive: true });
  });
  after(async () => {
    await fs.rm(testCacheDir, { recursive: true, force: true }).catch(() => { });
  });
  describe('5. CompositeTools: Architecture, Impact, Diagnostics & Refactor', () => {
    const router = new ToolRouter(config);

    before(async () => {
      await router.initialize();
    });

    after(async () => {
      await router.dispose();
    });

    it('ArchitectureAnalyzer should categorize layers and entry points', async () => {
      const arch = await router.architecture.analyze();
      assert.ok(arch.layers.length >= 4);
      const layerNames = arch.layers.map((l) => l.name);
      assert.ok(layerNames.includes('Presentation / Gateway'));
      assert.ok(layerNames.includes('Core / Domain'));
      assert.ok(layerNames.includes('Adapters / Infrastructure'));
      assert.ok(layerNames.includes('Composite Tools'));
    });

    it('ArchitectureAnalyzer should emit .NET project graph from fixture sln/csproj files', async () => {
      const fixtureConfig = getDefaultConfig(FIXTURE_DOTNET);
      fixtureConfig.cacheDir = testCacheDir;
      const fixtureRouter = new ToolRouter(fixtureConfig);
      const arch = await fixtureRouter.architecture.analyze();
      assert.ok(arch.projectGraph);
      assert.deepStrictEqual(arch.projectGraph!.solutions, ['MiniDesk.sln']);
      assert.strictEqual(arch.projectGraph!.projects.length, 3);
      const names = arch.projectGraph!.projects.map((p) => p.name).sort();
      assert.deepStrictEqual(names, ['App', 'Core', 'Infra']);
      const app = arch.projectGraph!.projects.find((p) => p.name === 'App');
      assert.ok(app?.isWpf);
      assert.ok(app?.projectReferences.includes('Core'));
      assert.ok(app?.projectReferences.includes('Infra'));
      assert.ok(arch.projectGraph!.edges.some((e) => e.from === 'App' && e.to === 'Core'));
      assert.ok(arch.projectGraph!.edges.some((e) => e.from === 'Infra' && e.to === 'Core'));
      assert.ok(arch.keyEntryPoints.some((e) => e.replace(/\\/g, '/').includes('App.xaml.cs')));
      assert.ok(arch.recommendedAgentFocus.includes('file-derived structure'));
    });

    it('ImpactAnalyzer should calculate blast radius and correct risk level', async () => {
      // A growing checkout (including optional upstream installs) is not a bounded test fixture.
      const impactRoot = path.join(testCacheDir, 'impact-fixture');
      await fs.mkdir(impactRoot, { recursive: true });
      await fs.writeFile(path.join(impactRoot, 'ToolRouter.ts'), 'export class ToolRouter {}');
      await fs.writeFile(path.join(impactRoot, 'Caller.ts'), 'import { ToolRouter } from "./ToolRouter";\nexport const caller = new ToolRouter();');
      const impactConfig = getDefaultConfig(impactRoot);

      const impactQueries = new LocalTextAdapter(impactConfig, new CacheManager(path.join(testCacheDir, 'impact-cache')));
      const impact = await new ImpactAnalyzer(impactQueries, impactConfig).analyzeImpact('ToolRouter');
      assert.strictEqual(impact.target, 'ToolRouter');
      assert.ok(impact.targetFile.includes('ToolRouter.ts'));
      assert.ok(
        ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(impact.riskLevel),
        `expected ranked risk, got ${impact.riskLevel} (${impact.riskReason})`
      );
      assert.ok(impact.referencesCount > 0);
      assert.ok(Array.isArray(impact.affected));
      assert.ok(impact.recommendations.length >= 3);
      assert.ok(impact.formattedReport.includes('# Impact Analysis'));
      assert.ok(impact.formattedReport.includes('Target:'));
      assert.ok(impact.formattedReport.includes('References:'));
      assert.ok(impact.formattedReport.includes('Affected:'));
      assert.ok(impact.formattedReport.includes('Risk:'));
      assert.ok(impact.formattedReport.includes('Recommended:'));
      assert.notStrictEqual(impact.confidence, 'HIGH');
      assert.ok(!impact.formattedReport.includes('Safe for targeted in-place refactoring'));
    });

    it('Phase 5: ImpactAnalyzer resolves MemoryService callers in the portable .NET fixture', async () => {
      const fixtureConfig = getDefaultConfig(FIXTURE_DOTNET);
      fixtureConfig.cacheDir = testCacheDir;
      const fixtureCache = new CacheManager(testCacheDir);
      const fixtureQueries = new LocalTextAdapter(fixtureConfig, fixtureCache);
      const fixtureImpact = new ImpactAnalyzer(fixtureQueries, fixtureConfig);

      const result = await fixtureImpact.analyzeImpact('MemoryService');
      assert.ok(result.targetFile.includes('MemoryService'));
      assert.ok(result.referencesCount > 0);
      assert.ok(result.affected.some((a) => a === 'SaveManager' || a === 'MainWindow'));
      assert.ok(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(result.riskLevel));
      assert.notStrictEqual(result.confidence, 'HIGH', 'Fallback scan must not receive HIGH confidence from source alone');
      assert.strictEqual(result.uniqueResolution, true);
      assert.ok(!result.formattedReport.includes('Safe for targeted in-place refactoring'));
    });

    it('Phase 5: accurately matches the exact user showcase scenario (MemoryService)', async () => {
      const mockQueries: any = {
        findSymbols: async (q: string) => [
          { name: 'MemoryService', kind: 'class', file: 'D:/project/Game/MemoryService.cs', line: 10 },
        ],
        findReferences: async (sym: string) => [
          { symbolName: sym, file: 'D:/project/Game/GameSession.cs', line: 15, preview: 'MemoryService mem' },
          { symbolName: sym, file: 'D:/project/Game/GameSession.cs', line: 20, preview: 'mem.Save()' },
          { symbolName: sym, file: 'D:/project/Game/GameSession.cs', line: 25, preview: 'mem.Load()' },
          { symbolName: sym, file: 'D:/project/Game/GameSession.cs', line: 30, preview: 'mem.Flush()' },
          { symbolName: sym, file: 'D:/project/Game/SaveManager.cs', line: 40, preview: 'new MemoryService()' },
          { symbolName: sym, file: 'D:/project/Game/SaveManager.cs', line: 45, preview: 'MemoryService.Instance' },
          { symbolName: sym, file: 'D:/project/Game/SaveManager.cs', line: 50, preview: 'mem.Backup()' },
          { symbolName: sym, file: 'D:/project/Game/SaveManager.cs', line: 55, preview: 'mem.Sync()' },
          { symbolName: sym, file: 'D:/project/Game/ExportService.cs', line: 60, preview: 'MemoryService exporter' },
          { symbolName: sym, file: 'D:/project/Game/ExportService.cs', line: 65, preview: 'exporter.Dump()' },
          { symbolName: sym, file: 'D:/project/Game/ExportService.cs', line: 70, preview: 'exporter.Serialize()' },
          { symbolName: sym, file: 'D:/project/Game/ExportService.cs', line: 75, preview: 'exporter.Archive()' },
        ],
      };

      const analyzer = new ImpactAnalyzer(mockQueries);
      const impact = await analyzer.analyzeImpact('MemoryService');

      assert.strictEqual(impact.targetFile, 'MemoryService.cs');
      assert.strictEqual(impact.referencesCount, 12);
      assert.deepStrictEqual(impact.affected, ['GameSession', 'SaveManager', 'ExportService']);
      assert.strictEqual(impact.riskLevel, 'HIGH');
      assert.ok(impact.recommendations.some((r) => r.includes('Add interface')));
      assert.ok(impact.recommendations.some((r) => r.includes('Split persistence layer')));
      assert.ok(impact.recommendations.some((r) => r.includes('Update tests')));

      // Check formatted report matches format exactly
      assert.ok(impact.formattedReport.includes('Target:\nMemoryService.cs'));
      assert.ok(impact.formattedReport.includes('References:\n12'));
      assert.ok(impact.formattedReport.includes('Affected:\n- GameSession\n- SaveManager\n- ExportService'));
      assert.ok(impact.formattedReport.includes('Risk:\nHIGH'));
      assert.strictEqual(impact.confidence, 'MEDIUM');
      assert.strictEqual(impact.source, 'local-text');
      assert.strictEqual(impact.uniqueResolution, true);
    });

    it('v0.4: Local text source with 0 references must be UNKNOWN, not LOW, and confidence must not follow source', async () => {
      const mockQueries: any = {
        findSymbolsDetailed: async () => ({
          query: 'GhostService',
          symbols: [{ name: 'GhostService', kind: 'class', file: 'GhostService.cs', line: 1 }],
          source: 'roslyn',
          queryComplete: true,
          truncated: false,
          uniqueTypeMatch: true,
          typeMatchCount: 1,
          limitations: [],
        }),
        findReferencesDetailed: async () => ({
          symbolName: 'GhostService',
          references: [],
          source: 'roslyn',
          queryComplete: true,
          truncated: false,
          limitations: [],
        }),
        findSymbols: async () => [{ name: 'GhostService', kind: 'class', file: 'GhostService.cs', line: 1 }],
        findReferences: async () => [],
      };
      const impact = await new ImpactAnalyzer(mockQueries).analyzeImpact('GhostService');
      assert.strictEqual(impact.source, 'roslyn');
      assert.strictEqual(impact.riskLevel, 'UNKNOWN');
      assert.strictEqual(impact.confidence, 'UNCERTAIN');
      assert.ok(!impact.formattedReport.toLowerCase().includes('safe'));
    });

    it('v0.4: incomplete Local text query and ambiguous types return UNKNOWN', async () => {
      const incomplete: any = {
        findSymbolsDetailed: async () => ({
          query: 'MemoryService',
          symbols: [{ name: 'MemoryService', kind: 'class', file: 'A.cs', line: 1 }],
          source: 'roslyn',
          queryComplete: false,
          queryError: 'truncated',
          truncated: true,
          uniqueTypeMatch: true,
          typeMatchCount: 1,
          limitations: ['truncated'],
        }),
        findReferencesDetailed: async () => ({
          symbolName: 'MemoryService',
          references: [{ symbolName: 'MemoryService', file: 'B.cs', line: 2, preview: 'x' }],
          source: 'roslyn',
          queryComplete: false,
          truncated: true,
          limitations: [],
        }),
        findSymbols: async () => [],
        findReferences: async () => [],
      };
      const incompleteImpact = await new ImpactAnalyzer(incomplete).analyzeImpact('MemoryService');
      assert.strictEqual(incompleteImpact.riskLevel, 'UNKNOWN');
      assert.strictEqual(incompleteImpact.confidence, 'UNCERTAIN');
      assert.strictEqual(incompleteImpact.analysisCompleteness, 'incomplete');

      const fixtureConfig = getDefaultConfig(FIXTURE_DOTNET);
      fixtureConfig.cacheDir = testCacheDir;
      const fixtureQueries = new LocalTextAdapter(fixtureConfig, new CacheManager(testCacheDir));
      const dup = await new ImpactAnalyzer(fixtureQueries, fixtureConfig).analyzeImpact('DuplicateName');
      assert.strictEqual(dup.uniqueResolution, false);
      assert.strictEqual(dup.riskLevel, 'UNKNOWN');
      assert.strictEqual(dup.confidence, 'UNCERTAIN');

      const unused = await new ImpactAnalyzer(fixtureQueries, fixtureConfig).analyzeImpact('UnusedHelper');
      assert.strictEqual(unused.uniqueResolution, true);
      assert.strictEqual(unused.referencesCount, 0);
      assert.strictEqual(unused.riskLevel, 'UNKNOWN');
      assert.strictEqual(unused.confidence, 'UNCERTAIN');
    });

    it('v0.4: prepare_context returns file evidence for MemoryService and declares insufficient evidence otherwise', async () => {
      const fixtureConfig = getDefaultConfig(FIXTURE_DOTNET);
      fixtureConfig.cacheDir = testCacheDir;
      const fixtureRouter = new ToolRouter(fixtureConfig);
      const ctx = await fixtureRouter.context.prepareContext({
        task: 'MemoryService 是否适合拆分',
        maxTokens: 4000,
      });
      assert.strictEqual(ctx.evidenceInsufficient, false);
      assert.ok(ctx.evidence.some((e) => e.file.replace(/\\/g, '/').includes('MemoryService.cs')));
      assert.ok(ctx.evidence.some((e) => e.snippet.includes('class MemoryService')));
      assert.ok(ctx.metrics.estimatedTokens <= 4000 + 500);

      const empty = await fixtureRouter.context.prepareContext({
        task: '完全不相关的任务 XYZ_NO_SYMBOL_QQQ',
        maxTokens: 1000,
      });
      assert.strictEqual(empty.evidenceInsufficient, true);
      assert.ok(empty.limitations.some((l) => l.includes('证据不足')));

      const dumpGuard = await fixtureRouter.context.prepareContext({
        task: '完全不相关的任务 XYZ_NO_SYMBOL_QQQ',
        includeFullText: true,
        maxTokens: 8000,
      });
      assert.strictEqual(dumpGuard.evidenceInsufficient, true);
      assert.ok(dumpGuard.limitations.some((l) => l.includes('refusing to dump') || l.includes('证据不足')));
      assert.ok(!dumpGuard.formattedContent.includes('class DuplicateName'));

      const full = await fixtureRouter.context.prepareContext({
        task: 'MemoryService',
        includeFullText: true,
        maxTokens: 8000,
      });
      assert.ok(full.formattedContent.includes('public class MemoryService') || full.evidence.some((e) => e.snippet.includes('class MemoryService')));
    });

    it('v0.4: symbol names with regex metacharacters must not throw', async () => {
      const refs = await router.text.findReferences('C++');
      assert.ok(Array.isArray(refs));
      const impact = await router.impact.analyzeImpact('foo.bar[]');
      assert.strictEqual(impact.riskLevel, 'UNKNOWN');
    });

    it('P1 Fix: non-existent/unindexed symbol must report UNKNOWN risk, UNCERTAIN confidence, and never claim safe', async () => {
      const mysterySymbol = 'NonExistent_Ghost_Symbol_987654';
      const impact = await router.impact.analyzeImpact(mysterySymbol);

      assert.strictEqual(impact.riskLevel, 'UNKNOWN', 'Unindexed symbol risk must be UNKNOWN');
      assert.strictEqual(impact.confidence, 'UNCERTAIN', 'Confidence must be UNCERTAIN');
      assert.ok(impact.riskReason.includes('not found in workspace index'));
      assert.ok(!impact.formattedReport.includes('Safe for targeted in-place refactoring'));
      assert.ok(impact.recommendations.some((r) => r.includes('Verify symbol spelling')));
    });

    it('P1 Fix: local fallback reference scanner must ignore comment lines and non-code docs', async () => {
      const testQueries = router.text;
      const refs = await testQueries.findReferences('ToolRouter');
      for (const r of refs) {
        assert.ok(!r.preview.startsWith('//'), `Preview must not be a comment: ${r.preview}`);
        assert.ok(!r.preview.startsWith('/*'), `Preview must not be a comment: ${r.preview}`);
        assert.ok(!r.file.endsWith('.md'), `Must not count markdown as code references: ${r.file}`);
      }
    });

    it('ProjectDiagnostics should verify Windows and SDK health', async () => {
      const diag = await router.diagnostics.runDiagnostics();
      assert.ok(diag.diagnostics.length > 0);
      const categories = diag.diagnostics.map((d) => d.category);
      assert.ok(categories.includes('Windows'));
      assert.ok(categories.includes('Environment'));
      assert.ok(categories.includes('Project'));
    });

    it('Optional TavernDesk integration is skipped unless the pinned workspace exists', { skip: !HAS_TAVERN }, async () => {
      const tavernWs = new WorkspaceManager(getDefaultConfig(TAVERN_PATH));
      const result = await tavernWs.openWorkspace(TAVERN_PATH);
      assert.strictEqual(result.type, 'dotnet');
      assert.ok(result.solution);
      assert.ok(result.projects >= 1);
    });

    it('RefactorAssistant should generate structured plan with safe boundaries', async () => {
      const plan = await router.refactor.planRefactoring('CacheManager', 'Add Redis distributed cache');
      assert.ok(plan.targetComponent === 'CacheManager');
      assert.ok(plan.recommendedSteps.length >= 3);
      assert.ok(plan.safeBoundaries.some((b) => b.includes('trash')));
    });
  });
});
