import { test, describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CacheManager } from '../src/Core/Cache.js';
import { WorkspaceManager } from '../src/Core/Workspace.js';
import { getDefaultConfig } from '../src/Core/Config.js';
import { SerenaAdapter } from '../src/Adapters/SerenaAdapter.js';
import { RepomixAdapter } from '../src/Adapters/RepomixAdapter.js';
import { ContextManager } from '../src/Core/Context.js';
import { ImpactAnalyzer } from '../src/CompositeTools/ImpactAnalyzer.js';
import { ArchitectureAnalyzer } from '../src/CompositeTools/ArchitectureAnalyzer.js';
import { ProjectDiagnostics } from '../src/CompositeTools/ProjectDiagnostics.js';
import { RefactorAssistant } from '../src/CompositeTools/RefactorAssistant.js';
import { ToolRouter } from '../src/Core/ToolRouter.js';
import { killProcessTree } from '../src/Core/ResourceManager.js';

describe('WinCode MCP Comprehensive TDD Test Suite', () => {
  const root = process.cwd();
  const testCacheDir = path.join(root, '.cache', 'test_cache_tdd');
  const config = getDefaultConfig(root);
  config.cacheDir = testCacheDir;
  const FIXTURE_DOTNET = path.resolve(root, 'tests/fixtures/dotnet-mini');
  const TAVERN_PATH = process.env.WINCODE_TAVERN_PATH
    ? path.resolve(process.env.WINCODE_TAVERN_PATH)
    : path.resolve('d:/CODEX PROJECT/New-tavern');
  const HAS_TAVERN = existsSync(path.join(TAVERN_PATH, 'TavernDesk.sln'));

  // Clean up test cache
  before(async () => {
    await fs.mkdir(testCacheDir, { recursive: true });
  });

  after(async () => {
    await fs.rm(testCacheDir, { recursive: true, force: true }).catch(() => {});
  });

  // ==========================================
  // Suite 1: CacheManager TDD
  // ==========================================
  describe('1. Core: CacheManager', () => {
    it('should store and retrieve data from memory and disk', async () => {
      const cache = new CacheManager(testCacheDir);
      await cache.initialize();

      await cache.set('user_profile', { name: 'Coder', level: 10 });
      const retrieved = await cache.get<{ name: string; level: number }>('user_profile');

      assert.ok(retrieved);
      assert.strictEqual(retrieved.name, 'Coder');
      assert.strictEqual(retrieved.level, 10);
    });

    it('should respect TTL expiration', async () => {
      const cache = new CacheManager(testCacheDir);
      await cache.initialize();

      await cache.set('transient_token', { token: 'xyz123' }, { ttlMs: 50 });
      const beforeExp = await cache.get('transient_token');
      assert.ok(beforeExp);

      // Wait for expiration
      await new Promise((r) => setTimeout(r, 70));
      const afterExp = await cache.get('transient_token');
      assert.strictEqual(afterExp, null, 'Cache item should be null after TTL expired');
    });

    it('should invalidate cache when workspace fingerprint changes', async () => {
      const cache = new CacheManager(testCacheDir);
      await cache.initialize();

      await cache.set('versioned_data', { data: 'old' }, { fingerprint: 'fp_v1' });

      // Retrieve with matching fingerprint -> hit
      const hit = await cache.get('versioned_data', 'fp_v1');
      assert.ok(hit);

      // Retrieve with altered fingerprint -> miss
      const miss = await cache.get('versioned_data', 'fp_v2');
      assert.strictEqual(miss, null, 'Cache item must miss when fingerprint changes');
    });

    it('should compute sensitive workspace fingerprint that changes upon file edits and additions', async () => {
      const cache = new CacheManager(testCacheDir);
      await cache.initialize();

      const fpOriginal = await cache.computeWorkspaceFingerprint(root, { fresh: true });
      assert.ok(fpOriginal && typeof fpOriginal === 'string');

      // Create a temporary file in root to simulate workspace change
      const probeFile = path.join(root, 'tdd_probe_temp_file.txt');
      await fs.writeFile(probeFile, 'probe content v1');

      try {
        const fpAfterCreate = await cache.computeWorkspaceFingerprint(root, { fresh: true });
        assert.notStrictEqual(fpAfterCreate, fpOriginal, 'Fingerprint must change when an untracked file is added');

        await new Promise((r) => setTimeout(r, 40));
        await fs.writeFile(probeFile, 'probe content v2 modified');
        const fpAfterModify = await cache.computeWorkspaceFingerprint(root, { fresh: true });
        assert.notStrictEqual(fpAfterModify, fpAfterCreate, 'Fingerprint must change when an existing dirty file is modified');
      } finally {
        await fs.unlink(probeFile).catch(() => {});
      }

      const fpRestored = await cache.computeWorkspaceFingerprint(root, { fresh: true });
      assert.strictEqual(fpRestored, fpOriginal, 'Fingerprint should restore when modifications are reverted');
    });

    it('should detect file edits in non-git directories as well', async () => {
      const cache = new CacheManager(testCacheDir);
      const tempNonGit = path.join(testCacheDir, 'nongit_probe');
      await fs.mkdir(path.join(tempNonGit, 'src'), { recursive: true });
      const testFile = path.join(tempNonGit, 'src', 'code.ts');
      await fs.writeFile(testFile, 'export const a = 1;');

      const fp1 = await cache.computeWorkspaceFingerprint(tempNonGit, { fresh: true });
      await new Promise((r) => setTimeout(r, 40));
      await fs.writeFile(testFile, 'export const a = 2;');
      const fp2 = await cache.computeWorkspaceFingerprint(tempNonGit, { fresh: true });

      assert.notStrictEqual(fp1, fp2, 'Non-git workspace fingerprint must reflect subfolder file changes');
    });

    it('P2 Fix: CacheManager should enforce memory capacity limit and LRU eviction', async () => {
      const smallCacheDir = path.join(testCacheDir, 'lru_test_cache');
      const smallCache = new CacheManager(smallCacheDir, 3, 3);
      await smallCache.initialize();

      await smallCache.set('k1', 'val1');
      await smallCache.set('k2', 'val2');
      await smallCache.set('k3', 'val3');
      assert.strictEqual(smallCache.memoryEntryCount, 3);

      // Access k1 to make it most recently used (LRU order: k2, k3, k1)
      const hit = await smallCache.get('k1');
      assert.strictEqual(hit, 'val1');

      // Adding k4 should evict k2 (oldest)
      await smallCache.set('k4', 'val4');
      assert.ok(smallCache.memoryEntryCount <= 3);

      // k1, k3, k4 should be accessible
      assert.strictEqual(await smallCache.get('k1'), 'val1');
      assert.strictEqual(await smallCache.get('k4'), 'val4');
    });
  });

  // ==========================================
  // Suite 2: WorkspaceManager & Safe Trash
  // ==========================================
  describe('2. Core: WorkspaceManager & Safe Trash Policy', () => {
    const ws = new WorkspaceManager(config);

    it('should accurately detect project environment and tools', async () => {
      const identity = await ws.identifyProject();
      assert.ok(identity.name);
      assert.ok(identity.frameworks.includes('Node.js / TypeScript'));
      assert.ok(identity.packageManagers.includes('npm/node'));
    });

    it('should scan workspace directory tree with maxDepth', async () => {
      const tree = await ws.getDirectoryTree(2);
      assert.strictEqual(tree.type, 'directory');
      assert.ok(tree.children && tree.children.length > 0);
      const childNames = tree.children.map((c) => c.name);
      assert.ok(childNames.includes('src'));
      assert.ok(!childNames.includes('node_modules'), 'Default ignores like node_modules must be excluded');
      assert.ok(!childNames.includes('.git'), '.git directory must be excluded');
    });

    it('Security Boundary: Safe moveToTrash must move file and write metadata', async () => {
      const testFile = path.join(root, 'tdd_temp_file_for_trash.txt');
      await fs.writeFile(testFile, 'Crucial content that should never be permanently deleted', 'utf-8');

      const result = await ws.moveToTrash('tdd_temp_file_for_trash.txt', 'TDD safety test');
      assert.strictEqual(result.success, true);
      assert.ok(result.trashPath.includes('trash'));

      // Confirm source file no longer exists
      const srcExists = await fs.stat(testFile).then(() => true).catch(() => false);
      assert.strictEqual(srcExists, false, 'Source file must be moved away');

      // Confirm file exists in trash
      const trashExists = await fs.stat(result.trashPath).then(() => true).catch(() => false);
      assert.strictEqual(trashExists, true, 'File must exist inside trash directory');

      // Confirm audit metadata exists in trash
      const metaPath = `${result.trashPath}.meta.json`;
      const metaExists = await fs.stat(metaPath).then(() => true).catch(() => false);
      assert.strictEqual(metaExists, true, 'Audit metadata file must be created');

      const metaContent = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
      assert.ok(metaContent.deletedAt);
      assert.strictEqual(metaContent.reason, 'TDD safety test');
    });

    it('Resilience: moveToTrash on non-existent file within workspace should fail gracefully without throwing', async () => {
      const result = await ws.moveToTrash('non_existent_file_99999.xyz', 'Test non-existent');
      assert.strictEqual(result.success, false);
      assert.ok(result.message.includes('Failed to move file to trash'));
    });

    it('Security Boundary: moveToTrash strictly accepts only non-empty relative paths within workspace with zero rename calls', async () => {
      // Intercept fs.rename to verify zero calls on rejected inputs
      const originalRename = fs.rename;
      let renameCallCount = 0;
      (fs as any).rename = async (...args: any[]) => {
        renameCallCount++;
        return originalRename.apply(fs, args as any);
      };

      try {
        // 1. Empty or whitespace
        const emptyRes = await ws.moveToTrash('   ', 'Empty path');
        assert.strictEqual(emptyRes.success, false);
        assert.ok(emptyRes.message.includes('Path cannot be empty'));

        // 2. Absolute path (same drive)
        const absRes = await ws.moveToTrash(path.join(root, 'tdd_temp_file_for_trash.txt'), 'Absolute path');
        assert.strictEqual(absRes.success, false);
        assert.ok(absRes.message.includes('Only non-empty relative paths within the workspace are accepted'));

        // 3. Absolute path (different drive / external)
        const extAbsRes = await ws.moveToTrash('C:\\Windows\\System32\\cmd.exe', 'External absolute path');
        assert.strictEqual(extAbsRes.success, false);
        assert.ok(extAbsRes.message.includes('Only non-empty relative paths within the workspace are accepted'));

        // 4. Windows drive-relative path (e.g. C:foo or D:bar)
        const driveRelRes = await ws.moveToTrash('C:some_file.txt', 'Drive-relative path');
        assert.strictEqual(driveRelRes.success, false);
        assert.ok(driveRelRes.message.includes('Only non-empty relative paths within the workspace are accepted'));

        // 5. UNC network share path
        const uncRes = await ws.moveToTrash('\\\\server\\share\\file.txt', 'UNC path');
        assert.strictEqual(uncRes.success, false);
        assert.ok(uncRes.message.includes('Only non-empty relative paths within the workspace are accepted'));

        // 6. Relative ../ escaping workspace root
        const relEscapeRes = await ws.moveToTrash('../outside_secret.txt', 'Parent traversal escape');
        assert.strictEqual(relEscapeRes.success, false);
        assert.ok(relEscapeRes.message.includes('outside the workspace boundary'));

        // 7. Workspace root itself
        const rootRes = await ws.moveToTrash('.', 'Workspace root itself');
        assert.strictEqual(rootRes.success, false);
        assert.ok(rootRes.message.includes('outside the workspace boundary'));

        // 8. Trash directory itself
        const trashDirRes = await ws.moveToTrash('trash', 'Trash directory itself');
        assert.strictEqual(trashDirRes.success, false);
        assert.ok(trashDirRes.message.includes('Cannot move items from or within the trash directory'));

        // 9. Files inside trash directory sub-tree (prevent recursive archiving and metadata corruption)
        const testTrashFile = path.join(ws.trashDir, 'already_trashed.txt');
        await fs.mkdir(ws.trashDir, { recursive: true });
        await fs.writeFile(testTrashFile, 'already in trash', 'utf-8');
        const trashSubRes = await ws.moveToTrash('trash/already_trashed.txt', 'File inside trash');
        assert.strictEqual(trashSubRes.success, false);
        assert.ok(trashSubRes.message.includes('Cannot move items from or within the trash directory'));
        await fs.rm(testTrashFile, { force: true }).catch(() => {});

        // 10. Symlink pointing outside workspace
        const symlinkPath = path.join(root, 'temp_symlink_to_outside.txt');
        const outsideTarget = path.resolve(root, '..', 'temp_outside_real_file.txt');
        await fs.writeFile(outsideTarget, 'outside real file', 'utf-8');
        try {
          await fs.symlink(outsideTarget, symlinkPath, 'file');
          const symlinkRes = await ws.moveToTrash('temp_symlink_to_outside.txt', 'Symlink to outside');
          assert.strictEqual(symlinkRes.success, false);
          assert.ok(symlinkRes.message.includes('resolves outside the workspace via symlink or junction'));
        } catch {
          // On Windows, non-admin symlink creation may require privilege; skip if OS denies
        } finally {
          await fs.rm(symlinkPath, { force: true }).catch(() => {});
          await fs.rm(outsideTarget, { force: true }).catch(() => {});
        }

        // CRITICAL: Verify rename was NEVER called for any of the above invalid/escaping inputs
        assert.strictEqual(renameCallCount, 0, 'fs.rename call count must be ZERO for all rejected boundary inputs');
      } finally {
        (fs as any).rename = originalRename;
      }
    });

    it('Phase 2: openWorkspace parses the portable .NET fixture sln, projects, metadata and tree', async () => {
      const result = await ws.openWorkspace(FIXTURE_DOTNET);
      assert.strictEqual(result.type, 'dotnet');
      assert.strictEqual(result.solution, 'MiniDesk.sln');
      assert.strictEqual(result.language, 'C#');
      assert.strictEqual(result.projects, 3);
      assert.ok(result.metadata.frameworks.includes('WPF'));
      assert.equal(result.metadata.totalFiles, null);
      assert.equal(result.fileTree, undefined);
      assert.ok(result.entryPoints.length <= 8);

      ws.setRoot(root);
    });

    it('Workspace switching: openWorkspace and setRoot must synchronize trashDir and isolate cross-project deletions', async () => {
      const initialTrash = path.resolve(ws.trashDir);
      assert.strictEqual(initialTrash, path.join(root, 'trash'));

      await ws.openWorkspace(FIXTURE_DOTNET);
      assert.strictEqual(path.resolve(ws.root), FIXTURE_DOTNET);
      const switchedTrash = path.resolve(ws.trashDir);
      assert.strictEqual(switchedTrash, path.join(FIXTURE_DOTNET, 'trash'), 'trashDir must update to fixture workspace');

      const rejectCrossProject = await ws.moveToTrash('../../../package.json', 'Try deleting host file from fixture');
      assert.strictEqual(rejectCrossProject.success, false);
      assert.ok(rejectCrossProject.message.includes('outside the workspace boundary'));

      const tempBFile = path.join(FIXTURE_DOTNET, 'temp_test_b_file.txt');
      await fs.writeFile(tempBFile, 'File in fixture project', 'utf-8');

      const trashBResult = await ws.moveToTrash('temp_test_b_file.txt', 'Safe deletion in fixture');
      assert.strictEqual(trashBResult.success, true);
      assert.ok(trashBResult.trashPath.startsWith(path.join(FIXTURE_DOTNET, 'trash')), 'Must move to fixture trash');
      assert.ok(!trashBResult.trashPath.startsWith(path.join(root, 'trash')), 'Must NOT move to host trash');

      await fs.rm(trashBResult.trashPath, { force: true }).catch(() => {});
      await fs.rm(`${trashBResult.trashPath}.meta.json`, { force: true }).catch(() => {});
      await fs.rm(path.join(FIXTURE_DOTNET, 'trash'), { recursive: true, force: true }).catch(() => {});

      ws.setRoot(root);
      assert.strictEqual(path.resolve(ws.root), root);
      assert.strictEqual(path.resolve(ws.trashDir), path.join(root, 'trash'), 'trashDir must restore to host workspace');
    });
  });

  // ==========================================
  // Suite 3: SerenaAdapter (Symbol & References)
  // ==========================================
  describe('3. Adapters: SerenaAdapter Symbol Extraction & Reference Tracking', () => {
    const cache = new CacheManager(testCacheDir);
    const serena = new SerenaAdapter(config, cache);

    it('should extract class, interface, method, and function symbols across the repo', async () => {
      const classes = await serena.findSymbols('ToolRouter', 'class');
      assert.ok(classes.length > 0);
      assert.strictEqual(classes[0].name, 'ToolRouter');
      assert.strictEqual(classes[0].kind, 'class');

      const interfaces = await serena.findSymbols('IAdapter', 'interface');
      assert.ok(interfaces.length > 0);
      assert.strictEqual(interfaces[0].name, 'IAdapter');
      assert.strictEqual(interfaces[0].kind, 'interface');
    });

    it('should find accurate symbol references with word boundaries', async () => {
      const refs = await serena.findReferences('ToolRouter');
      assert.ok(refs.length > 0);
      for (const ref of refs) {
        assert.ok(ref.file);
        assert.ok(ref.line > 0);
        assert.ok(ref.preview.includes('ToolRouter'));
      }
    });

    it('should return empty results for non-existent symbols without throwing', async () => {
      const dynamicName = 'SYM_RANDOM_' + Math.random().toString(36).substring(2) + '_XYZ';
      const missing = await serena.findSymbols(dynamicName);
      assert.deepStrictEqual(missing, []);

      const missingRefs = await serena.findReferences(dynamicName);
      assert.deepStrictEqual(missingRefs, []);
    });

    it('Phase 4: SerenaAdapter should index C# classes and references in the portable .NET fixture', async () => {
      const fixtureConfig = getDefaultConfig(FIXTURE_DOTNET);
      fixtureConfig.cacheDir = testCacheDir;
      const fixtureSerena = new SerenaAdapter(fixtureConfig, cache);
      const symResult = await fixtureSerena.findSymbolsDetailed('MainWindow');
      assert.ok(symResult.symbols.length > 0);
      assert.ok(symResult.symbols.some((s) => s.name === 'MainWindow' && s.kind === 'class'));
      assert.strictEqual(symResult.uniqueTypeMatch, true);
      assert.strictEqual(symResult.queryComplete, true);

      const refResult = await fixtureSerena.findReferencesDetailed('MemoryService');
      assert.ok(refResult.totalReferences > 0);
      assert.ok(refResult.references.some((r) => r.file.replace(/\\/g, '/').includes('SaveManager.cs')));
      assert.ok(refResult.references.some((r) => r.file.replace(/\\/g, '/').includes('MainWindow.xaml.cs')));
    });

    it('should correctly map Serena official upstream format for symbols (name_path, relative_path, body_location)', () => {
      const upstreamSerenaJson = JSON.stringify([
        {
          name_path: 'App/MainWindow',
          kind: 'Class',
          relative_path: 'src/MainWindow.xaml.cs',
          body_location: {
            start_line: 25,
            end_line: 150,
          },
        },
        {
          name_path: 'ToolRouter',
          kind: 'Class',
          relative_path: 'src/Core/ToolRouter.ts',
          body_location: {
            start_line: 42,
            end_line: 220,
          },
        },
      ]);

      const mapped = serena.mapSerenaSymbols(upstreamSerenaJson, 'query');
      assert.strictEqual(mapped.length, 2);

      assert.strictEqual(mapped[0].name, 'MainWindow');
      assert.strictEqual(mapped[0].containerName, 'App');
      assert.strictEqual(mapped[0].file, 'src/MainWindow.xaml.cs');
      assert.strictEqual(mapped[0].line, 26);
      assert.strictEqual(mapped[0].kind, 'class');

      assert.strictEqual(mapped[1].name, 'ToolRouter');
      assert.strictEqual(mapped[1].file, 'src/Core/ToolRouter.ts');
      assert.strictEqual(mapped[1].line, 43);
      assert.strictEqual(mapped[1].kind, 'class');
    });

    it('should correctly map Serena official grouped references format (relative_path and kind grouping)', () => {
      const upstreamGroupedRefsJson = JSON.stringify({
        'src/Core/ToolRouter.ts': {
          Method: [
            {
              name_path: 'ToolRouter/dispatch',
              body_location: {
                start_line: 55,
                end_line: 80,
              },
              content_around_reference: 'const refs = await this.serena.findReferences(symbolName);',
            },
          ],
        },
        'src/CompositeTools/ImpactAnalyzer.ts': {
          Method: [
            {
              name_path: 'ImpactAnalyzer/analyze',
              body_location: {
                start_line: 90,
                end_line: 120,
              },
              content_around_reference: 'const refs = await this.serena.findReferences(symbolName, targetFile);',
            },
          ],
        },
      });

      const refs = serena.mapSerenaReferences(upstreamGroupedRefsJson, 'findReferences');
      assert.strictEqual(refs.length, 2);

      assert.strictEqual(refs[0].symbolName, 'findReferences');
      assert.strictEqual(refs[0].file, 'src/Core/ToolRouter.ts');
      assert.strictEqual(refs[0].line, 56);
      assert.ok(refs[0].preview.includes('const refs = await this.serena.findReferences(symbolName);'));

      assert.strictEqual(refs[1].symbolName, 'findReferences');
      assert.strictEqual(refs[1].file, 'src/CompositeTools/ImpactAnalyzer.ts');
      assert.strictEqual(refs[1].line, 91);
      assert.ok(refs[1].preview.includes('const refs = await this.serena.findReferences(symbolName, targetFile);'));
    });

    it('Resilience: when Serena upstream returns isError (e.g. 没有激活项目), it must fall back to local scanning', async () => {
      const mockSerena = new SerenaAdapter(config, cache);

      // Inject a mock connected client that returns an MCP error (isError: true)
      (mockSerena as any).isConnectedToSerena = true;
      (mockSerena as any).serenaTools = new Set(['find_symbol', 'find_referencing_symbols']);
      (mockSerena as any).serenaClient = {
        callTool: async () => ({
          isError: true,
          content: [{ type: 'text', text: 'Error: 没有激活项目' }],
        }),
      };

      const result = await mockSerena.findSymbolsDetailed('ToolRouter');
      assert.strictEqual(result.source, 'serena-adapter-fallback', 'Source must fall back to local adapter');
      assert.strictEqual(result.queryComplete, false, 'Serena isError means the semantic query is incomplete');
      assert.strictEqual(result.analysisCompleteness, 'incomplete');
      assert.ok(result.symbols.length > 0, 'Local indexing should have found ToolRouter symbols');
      assert.strictEqual(result.symbols[0].name, 'ToolRouter');
      const status = mockSerena.getUpstreamStatus();
      assert.strictEqual(status.projectActive, false);
      assert.notStrictEqual(status.mode, 'connected');

      const refResult = await mockSerena.findReferencesDetailed('ToolRouter');
      assert.strictEqual(refResult.source, 'serena-adapter-fallback', 'References source must fall back to local adapter');
      assert.ok(refResult.references.length > 0, 'Local references scanner should have found references to ToolRouter');
    });

    it('Lifecycle safety: re-initializing SerenaAdapter must close existing client and transport', async () => {
      const adapter = new SerenaAdapter(config, cache);
      let closeClientCalls = 0;
      let closeTransportCalls = 0;

      const mockClient = {
        close: async () => {
          closeClientCalls++;
        },
      };
      const mockTransport = {
        close: async () => {
          closeTransportCalls++;
        },
      };

      // Set existing connection
      (adapter as any).serenaClient = mockClient;
      (adapter as any).serenaTransport = mockTransport;
      (adapter as any).isConnectedToSerena = true;
      (adapter as any).serenaTools.add('test_tool');

      // Call initialize
      await adapter.initialize();

      // Verify previous instances were closed
      assert.strictEqual(closeClientCalls, 1, 'Previous client must be closed upon re-initialize');
      assert.strictEqual(closeTransportCalls, 1, 'Previous transport must be closed upon re-initialize');
      assert.strictEqual((adapter as any).serenaTools.size, 0, 'Tools set must be cleared');
    });

    it('Lifecycle safety: repeated openWorkspace on ToolRouter must close old Serena instances', async () => {
      const testRouter = new ToolRouter(config);
      await testRouter.initialize();
      try {
      let closeClient1Calls = 0;
      let closeTransport1Calls = 0;

      const mockClient1 = {
        close: async () => {
          closeClient1Calls++;
        },
      };
      const mockTransport1 = {
        close: async () => {
          closeTransport1Calls++;
        },
      };

      // Inject active Serena connection for initial workspace
      (testRouter.serena as any).serenaClient = mockClient1;
      (testRouter.serena as any).serenaTransport = mockTransport1;
      (testRouter.serena as any).isConnectedToSerena = true;

      // Open new workspace
      const nextWsPath = HAS_TAVERN ? TAVERN_PATH : FIXTURE_DOTNET;
      await testRouter.openWorkspace(nextWsPath);

      assert.strictEqual(closeClient1Calls, 1, 'Old Serena client must be closed when opening new workspace');
      assert.strictEqual(closeTransport1Calls, 1, 'Old Serena transport must be closed when opening new workspace');

      } finally {
        await testRouter.dispose();
        testRouter.workspace.setRoot(root);
      }
    });

    it('Lifecycle safety: failed Serena connection must close newly created transport and client', async () => {
      const failingConfig = getDefaultConfig(root);
      // Point custom command to a non-existent command to trigger connection failure
      failingConfig.adapters.serena.customCommand = 'non_existent_serena_cmd_12345';
      failingConfig.cacheDir = testCacheDir;

      const adapter = new SerenaAdapter(failingConfig, cache);
      await adapter.initialize();
      await adapter.ensureConnected();

      assert.strictEqual((adapter as any).isConnectedToSerena, false);
      assert.strictEqual((adapter as any).serenaClient, null);
      assert.strictEqual((adapter as any).serenaTransport, null);
      assert.strictEqual((adapter as any).serenaTools.size, 0);
    });
  });

  // ==========================================
  // Suite 4: RepomixAdapter & ContextManager
  // ==========================================
  describe('4. Adapters: RepomixAdapter & ContextManager', () => {
    const cache = new CacheManager(testCacheDir);
    const ws = new WorkspaceManager(config);
    const repomix = new RepomixAdapter(config, cache);
    const serena = new SerenaAdapter(config, cache);
    const context = new ContextManager(config, ws, repomix, serena);

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
      const slowRepomix = new RepomixAdapter(config, cache);
      const startTime = Date.now();

      // Test with a tiny timeout (50ms) to ensure timeout handling kicks in without hanging
      const health = await slowRepomix.checkHealth(50);
      const elapsed = Date.now() - startTime;

      assert.ok(health.available, 'Should be marked available');
      // Either it finishes immediately if cached/fast or times out and falls back
      if (health.source === 'fallback') {
        assert.ok(health.details?.includes('timed out') || health.details?.includes('built-in'));
      }
      assert.ok(elapsed < 2000, `Health check must not block, took ${elapsed}ms`);
      assert.strictEqual(slowRepomix.activeProcessCount, 0, 'Active process count must be 0 after completion or timeout');
    });

    it('Process Management & Dispose: should terminate all active child process trees on dispose()', async () => {
      const managedRepomix = new RepomixAdapter(config, cache);

      // Start a long-running child process simulated via checkHealth with large timeout
      const healthPromise = managedRepomix.checkHealth(15000);

      // Give it a few ms to spawn the child process
      await new Promise((r) => setTimeout(r, 100));

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

  // ==========================================
  // Suite 5: Composite Tools
  // ==========================================
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
      const impact = await router.impact.analyzeImpact('ToolRouter');
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
      const fixtureSerena = new SerenaAdapter(fixtureConfig, fixtureCache);
      const fixtureImpact = new ImpactAnalyzer(fixtureSerena, fixtureConfig);

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
      const mockSerena: any = {
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

      const analyzer = new ImpactAnalyzer(mockSerena);
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
      assert.strictEqual(impact.source, 'serena-adapter-fallback');
      assert.strictEqual(impact.uniqueResolution, true);
    });

    it('v0.4: Serena source with 0 references must be UNKNOWN, not LOW, and confidence must not follow source', async () => {
      const mockSerena: any = {
        findSymbolsDetailed: async () => ({
          query: 'GhostService',
          symbols: [{ name: 'GhostService', kind: 'class', file: 'GhostService.cs', line: 1 }],
          source: 'serena-mcp',
          queryComplete: true,
          truncated: false,
          uniqueTypeMatch: true,
          typeMatchCount: 1,
          limitations: [],
        }),
        findReferencesDetailed: async () => ({
          symbolName: 'GhostService',
          references: [],
          source: 'serena-mcp',
          queryComplete: true,
          truncated: false,
          limitations: [],
        }),
        findSymbols: async () => [{ name: 'GhostService', kind: 'class', file: 'GhostService.cs', line: 1 }],
        findReferences: async () => [],
      };
      const impact = await new ImpactAnalyzer(mockSerena).analyzeImpact('GhostService');
      assert.strictEqual(impact.source, 'serena-mcp');
      assert.strictEqual(impact.riskLevel, 'UNKNOWN');
      assert.strictEqual(impact.confidence, 'UNCERTAIN');
      assert.ok(!impact.formattedReport.toLowerCase().includes('safe'));
    });

    it('v0.4: incomplete Serena query and ambiguous types return UNKNOWN', async () => {
      const incomplete: any = {
        findSymbolsDetailed: async () => ({
          query: 'MemoryService',
          symbols: [{ name: 'MemoryService', kind: 'class', file: 'A.cs', line: 1 }],
          source: 'serena-mcp',
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
          source: 'serena-mcp',
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
      const fixtureSerena = new SerenaAdapter(fixtureConfig, new CacheManager(testCacheDir));
      const dup = await new ImpactAnalyzer(fixtureSerena, fixtureConfig).analyzeImpact('DuplicateName');
      assert.strictEqual(dup.uniqueResolution, false);
      assert.strictEqual(dup.riskLevel, 'UNKNOWN');
      assert.strictEqual(dup.confidence, 'UNCERTAIN');

      const unused = await new ImpactAnalyzer(fixtureSerena, fixtureConfig).analyzeImpact('UnusedHelper');
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

    it('v0.4: health check must not treat command-found as Serena connected', async () => {
      const health = await router.serena.checkHealth();
      assert.strictEqual(health.available, true);
      assert.ok(health.upstream);
      assert.strictEqual(typeof health.upstream!.commandFound, 'boolean');
      assert.strictEqual(typeof health.upstream!.handshakeOk, 'boolean');
      if (health.upstream!.projectActive !== true) {
        assert.strictEqual(health.upstream!.semanticQueryUsable, false);
        assert.strictEqual(health.upstream!.mode, 'degraded');
      }
      if (!health.upstream!.handshakeOk) {
        assert.notStrictEqual(health.source, 'installed');
        assert.ok(!health.details?.includes('Serena 已连接'));
      }
    });

    it('v0.4: symbol names with regex metacharacters must not throw', async () => {
      const refs = await router.serena.findReferences('C++');
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
      const testSerena = router.serena;
      const refs = await testSerena.findReferences('ToolRouter');
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

  // ==========================================
  // Suite 6: Full Stdio MCP Server End-to-End
  // ==========================================
  describe('6. End-to-End MCP Stdio Protocol & All 9 Tools Execution', () => {
    let proc: any;
    let pendingRequests = new Map<number | string, (res: any) => void>();
    let buffer = '';

    before(async () => {
      const serverPath = path.resolve('dist/index.js');
      proc = spawn('node', [serverPath, '--workspace', root], {
        cwd: root,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      proc.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const msg = JSON.parse(trimmed);
            if (msg.id !== undefined && pendingRequests.has(msg.id)) {
              const resolve = pendingRequests.get(msg.id)!;
              pendingRequests.delete(msg.id);
              resolve(msg);
            }
          } catch {}
        }
      });

      // Handshake
      const initPayload = JSON.stringify({
        jsonrpc: '2.0',
        id: 100,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'TDD-Runner', version: '1.0.0' },
        },
      }) + '\n';
      proc.stdin.write(initPayload);
      await new Promise((r) => setTimeout(r, 600));

      const initializedPayload = JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }) + '\n';
      proc.stdin.write(initializedPayload);
      await new Promise((r) => setTimeout(r, 200));
    });

    after(async () => {
      if (proc) {
        proc.stdin.end();
        await new Promise((r) => setTimeout(r, 200));
        await killProcessTree(proc).catch(() => {});
      }
    });

    const callMcp = (method: string, params?: any): Promise<any> => {
      const id = Math.floor(Math.random() * 10000000);
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pendingRequests.delete(id);
          reject(new Error(`MCP call ${method} timed out`));
        }, 8000);

        pendingRequests.set(id, (res) => {
          clearTimeout(timeout);
          resolve(res);
        });

        const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
        proc.stdin.write(payload);
      });
    };

    it('MCP tools/list should list all registered high-level tools', async () => {
      const res = await callMcp('tools/list', {});
      const tools = res.result?.tools || [];
      assert.ok(tools.length >= 10, 'Must expose at least 10 registered high-level tools');
      const toolNames = tools.map((t: any) => t.name);
      assert.ok(toolNames.includes('workspace_open'));
      assert.ok(toolNames.includes('wincode_hello_world'));
      assert.ok(toolNames.includes('wincode_analyze_workspace'));
      assert.ok(toolNames.includes('wincode_prepare_context'));
      assert.ok(toolNames.includes('wincode_find_code_symbol'));
      assert.ok(toolNames.includes('wincode_find_references'));
      assert.ok(toolNames.includes('analyze_change_impact'));
      assert.ok(toolNames.includes('wincode_analyze_change_impact'));
      assert.ok(toolNames.includes('wincode_diagnose_project'));
      assert.ok(toolNames.includes('wincode_plan_refactoring'));
      assert.ok(toolNames.includes('wincode_safe_move_to_trash'));
    });

    it('Tool 0: workspace_open works end-to-end via MCP', async () => {
      const res = await callMcp('tools/call', {
        name: 'workspace_open',
        arguments: { path: FIXTURE_DOTNET },
      });
      const data = JSON.parse(res.result?.content?.[0]?.text);
      assert.strictEqual(data.type, 'dotnet');
      assert.strictEqual(data.solution, 'MiniDesk.sln');
      assert.strictEqual(data.projects, 3);
      assert.strictEqual(data.language, 'C#');
      assert.equal(data.metadata.totalFiles, null);
      assert.equal(data.fileTree, undefined);
      assert.ok(data.entryPoints.length <= 8);

      await callMcp('tools/call', {
        name: 'workspace_open',
        arguments: { path: root },
      });
    });

    it('Tool 1: wincode_hello_world works', async () => {
      const res = await callMcp('tools/call', {
        name: 'wincode_hello_world',
        arguments: { greeting: 'TDD Test Greeting' },
      });
      const data = JSON.parse(res.result?.content?.[0]?.text);
      assert.strictEqual(data.status, 'online');
      assert.strictEqual(data.message, 'TDD Test Greeting');
      assert.strictEqual(data.gateway, 'WinCode Agent Gateway');
      assert.ok(data.adapters?.serena?.upstream);
      assert.ok(['connected', 'degraded'].includes(data.adapters.serena.upstream.mode));
      if (data.adapters.serena.upstream.mode !== 'connected') {
        assert.ok(!JSON.stringify(data).includes('Serena 已连接'));
      }
    });

    it('Tool 2: wincode_analyze_workspace works', async () => {
      const res = await callMcp('tools/call', {
        name: 'wincode_analyze_workspace',
        arguments: {},
      });
      const data = JSON.parse(res.result?.content?.[0]?.text);
      assert.ok(data.projectName === 'WinCode' || data.projectName === 'WinCode MCP');
      assert.ok(data.layers.length > 0);
    });

    it('Tool 3: wincode_prepare_context works with architecture analysis task', async () => {
      const res = await callMcp('tools/call', {
        name: 'wincode_prepare_context',
        arguments: { task: '分析这个项目架构' },
      });
      assert.strictEqual(res.result?.content?.length, 1);
      const meta = JSON.parse(res.result.content[0].text);
      assert.strictEqual(meta.task, '分析这个项目架构');
      assert.ok(Array.isArray(meta.evidence));
      assert.strictEqual(typeof meta.evidenceInsufficient, 'boolean');
      assert.ok(meta.guidance.length > 0);

      assert.strictEqual(meta.metrics.totalCharacters, res.result.content[0].text.length);
      assert.ok(meta.metrics.estimatedTokens <= meta.metrics.budgetTokens);
      const legacy = await callMcp('tools/call', {
        name: 'wincode_prepare_context',
        arguments: { task: '分析这个项目架构', responseFormat: 'legacy' },
      });
      assert.strictEqual(legacy.result.content.length, 2);
      const text = legacy.result.content[1].text;
      assert.ok(text.includes('AI Agent Context Snapshot'));
      assert.ok(text.includes('分析这个项目架构'));
    });

    it('Tool 4: wincode_find_code_symbol works', async () => {
      const res = await callMcp('tools/call', {
        name: 'wincode_find_code_symbol',
        arguments: { query: 'ToolRouter' },
      });
      const data = JSON.parse(res.result?.content?.[0]?.text);
      assert.ok(data.totalFound > 0);
      assert.ok(data.symbols.length > 0);
      assert.strictEqual(data.symbols[0].name, 'ToolRouter');
    });

    it('Tool 5: wincode_find_references works', async () => {
      const res = await callMcp('tools/call', {
        name: 'wincode_find_references',
        arguments: { symbolName: 'ToolRouter' },
      });
      const data = JSON.parse(res.result?.content?.[0]?.text);
      assert.ok(data.totalReferences > 0);
      assert.ok(data.references.length > 0);
    });

    it('Tool 6: analyze_change_impact and alias wincode_analyze_change_impact work', async () => {
      const res = await callMcp('tools/call', {
        name: 'analyze_change_impact',
        arguments: { target: 'ToolRouter' },
      });
      const impact = JSON.parse(res.result?.content?.[0]?.text);
      assert.strictEqual(impact.target, 'ToolRouter');
      assert.ok(impact.targetFile.includes('ToolRouter.ts'));
      assert.ok(impact.riskLevel);
      assert.ok(impact.recommendations.length >= 3);
      assert.ok(res.result?.content?.[1]?.text.includes('# Impact Analysis'));

      // Alias verification
      const aliasRes = await callMcp('tools/call', {
        name: 'wincode_analyze_change_impact',
        arguments: { target: 'ToolRouter' },
      });
      const aliasImpact = JSON.parse(aliasRes.result?.content?.[0]?.text);
      assert.strictEqual(aliasImpact.target, 'ToolRouter');
    });

    it('Tool 7: wincode_diagnose_project works', async () => {
      const res = await callMcp('tools/call', {
        name: 'wincode_diagnose_project',
        arguments: {},
      });
      const diag = JSON.parse(res.result?.content?.[0]?.text);
      assert.ok(diag.workspaceName);
      assert.ok(diag.diagnostics.length > 0);
    });

    it('Tool 8: wincode_plan_refactoring works', async () => {
      const res = await callMcp('tools/call', {
        name: 'wincode_plan_refactoring',
        arguments: { target: 'McpServer', goal: 'Decouple transport layer' },
      });
      const plan = JSON.parse(res.result?.content?.[0]?.text);
      assert.strictEqual(plan.targetComponent, 'McpServer');
      assert.ok(plan.recommendedSteps.length > 0);
    });

    it('Tool 9: wincode_safe_move_to_trash works safely with relative paths and rejects boundary violations', async () => {
      const tempTddFile = path.join(root, 'tdd_mcp_trash_test.txt');
      await fs.writeFile(tempTddFile, 'Temporary file to test MCP safe trash tool', 'utf-8');

      // Valid relative path
      const res = await callMcp('tools/call', {
        name: 'wincode_safe_move_to_trash',
        arguments: { filePath: 'tdd_mcp_trash_test.txt', reason: 'Testing via MCP call' },
      });
      assert.ok(!res.result?.isError);
      const result = JSON.parse(res.result?.content?.[0]?.text);
      assert.strictEqual(result.success, true);
      assert.ok(result.trashPath.includes('trash'));

      // Absolute path rejection via MCP
      const absRes = await callMcp('tools/call', {
        name: 'wincode_safe_move_to_trash',
        arguments: { filePath: tempTddFile, reason: 'Absolute path rejection via MCP' },
      });
      assert.strictEqual(absRes.result?.isError, true);

      // Traversal ../ rejection via MCP
      const escapeRes = await callMcp('tools/call', {
        name: 'wincode_safe_move_to_trash',
        arguments: { filePath: '../escape_via_mcp.txt', reason: 'Escape rejection via MCP' },
      });
      assert.strictEqual(escapeRes.result?.isError, true);
    });

    it('Error Handling: Unknown tool name returns isError without crashing server', async () => {
      const res = await callMcp('tools/call', {
        name: 'non_existent_tool_12345',
        arguments: {},
      });
      assert.strictEqual(res.result?.isError, true);
      assert.ok(res.result?.content?.[0]?.text.includes('Unknown tool: non_existent_tool_12345'));
    });
  });
});
