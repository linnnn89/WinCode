import { test, describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
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

describe('WinCode MCP Comprehensive TDD Test Suite', () => {
  const root = process.cwd();
  const testCacheDir = path.join(root, '.cache', 'test_cache_tdd');
  const config = getDefaultConfig(root);
  config.cacheDir = testCacheDir;

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

      const result = await ws.moveToTrash(testFile, 'TDD safety test');
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

    it('Resilience: moveToTrash on non-existent file should fail gracefully without throwing', async () => {
      const fakePath = path.join(root, 'non_existent_file_99999.xyz');
      const result = await ws.moveToTrash(fakePath, 'Test non-existent');
      assert.strictEqual(result.success, false);
      assert.ok(result.message.includes('Failed to move file to trash'));
    });

    it('Phase 2: openWorkspace accurately parses .NET solutions, projects, git, metadata and tree', async () => {
      const tavernPath = path.resolve('d:/CODEX PROJECT/New-tavern');
      const result = await ws.openWorkspace(tavernPath);
      assert.strictEqual(result.type, 'dotnet');
      assert.strictEqual(result.solution, 'TavernDesk.sln');
      assert.strictEqual(result.language, 'C#');
      assert.strictEqual(result.projects, 4);
      assert.strictEqual(result.git.isGit, true);
      assert.ok(result.metadata.totalFiles > 0);
      assert.ok(result.fileTree.children && result.fileTree.children.length > 0);

      // Restore root to current workspace
      ws.setRoot(root);
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
  });

  // ==========================================
  // Suite 4: RepomixAdapter & ContextManager
  // ==========================================
  describe('4. Adapters: RepomixAdapter & ContextManager', () => {
    const cache = new CacheManager(testCacheDir);
    const repomix = new RepomixAdapter(config, cache);
    const serena = new SerenaAdapter(config, cache);
    const context = new ContextManager(config, repomix, serena);

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

    it('should prepare high-semantic, token-efficient context for targeted task', async () => {
      const prep = await context.prepareContext('Inspect cache mechanics and invalidation', ['src/Core/Cache.ts']);
      assert.ok(prep.targetFiles.includes('src/Core/Cache.ts'));
      assert.ok(prep.packedContent.includes('CacheManager'));
      assert.ok(prep.estimatedTokens > 0);
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

    it('ImpactAnalyzer should calculate blast radius and correct risk level', async () => {
      const impact = await router.impact.analyzeImpact('ToolRouter');
      assert.ok(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(impact.riskLevel));
      assert.ok(impact.recommendations.length > 0);
      assert.ok(impact.affectedFiles.length > 0);
    });

    it('ProjectDiagnostics should verify Windows and SDK health', async () => {
      const diag = await router.diagnostics.runDiagnostics();
      assert.ok(diag.diagnostics.length > 0);
      const categories = diag.diagnostics.map((d) => d.category);
      assert.ok(categories.includes('Windows'));
      assert.ok(categories.includes('Environment'));
      assert.ok(categories.includes('Project'));
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
        await new Promise((r) => setTimeout(r, 300));
        proc.kill();
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

    it('MCP tools/list should list all 10 high-level tools', async () => {
      const res = await callMcp('tools/list', {});
      const tools = res.result?.tools || [];
      assert.strictEqual(tools.length, 10, 'Must expose exactly 10 registered high-level tools');
      const toolNames = tools.map((t: any) => t.name);
      assert.ok(toolNames.includes('workspace_open'));
      assert.ok(toolNames.includes('wincode_hello_world'));
      assert.ok(toolNames.includes('wincode_analyze_workspace'));
      assert.ok(toolNames.includes('wincode_prepare_context'));
      assert.ok(toolNames.includes('wincode_find_code_symbol'));
      assert.ok(toolNames.includes('wincode_find_references'));
      assert.ok(toolNames.includes('wincode_analyze_change_impact'));
      assert.ok(toolNames.includes('wincode_diagnose_project'));
      assert.ok(toolNames.includes('wincode_plan_refactoring'));
      assert.ok(toolNames.includes('wincode_safe_move_to_trash'));
    });

    it('Tool 0: workspace_open works end-to-end via MCP', async () => {
      const res = await callMcp('tools/call', {
        name: 'workspace_open',
        arguments: { path: 'd:/CODEX PROJECT/New-tavern' },
      });
      const data = JSON.parse(res.result?.content?.[0]?.text);
      assert.strictEqual(data.type, 'dotnet');
      assert.strictEqual(data.solution, 'TavernDesk.sln');
      assert.strictEqual(data.projects, 4);
      assert.strictEqual(data.language, 'C#');
      assert.strictEqual(data.git.isGit, true);
      assert.ok(data.metadata.totalFiles > 0);
      assert.ok(data.fileTree.children && data.fileTree.children.length > 0);

      // Revert active workspace back to current root
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
    });

    it('Tool 2: wincode_analyze_workspace works', async () => {
      const res = await callMcp('tools/call', {
        name: 'wincode_analyze_workspace',
        arguments: {},
      });
      const data = JSON.parse(res.result?.content?.[0]?.text);
      assert.strictEqual(data.projectName, 'WinCode MCP');
      assert.ok(data.layers.length > 0);
    });

    it('Tool 3: wincode_prepare_context works', async () => {
      const res = await callMcp('tools/call', {
        name: 'wincode_prepare_context',
        arguments: { task: 'Analyze cache and workspace' },
      });
      assert.ok(res.result?.content?.length >= 1);
      const summary = JSON.parse(res.result.content[0].text);
      assert.ok(summary.summary);
      assert.ok(summary.estimatedTokens > 0);
    });

    it('Tool 4: wincode_find_code_symbol works', async () => {
      const res = await callMcp('tools/call', {
        name: 'wincode_find_code_symbol',
        arguments: { query: 'ToolRouter' },
      });
      const symbols = JSON.parse(res.result?.content?.[0]?.text);
      assert.ok(symbols.length > 0);
      assert.strictEqual(symbols[0].name, 'ToolRouter');
    });

    it('Tool 5: wincode_find_references works', async () => {
      const res = await callMcp('tools/call', {
        name: 'wincode_find_references',
        arguments: { symbolName: 'ToolRouter' },
      });
      const refs = JSON.parse(res.result?.content?.[0]?.text);
      assert.ok(refs.length > 0);
    });

    it('Tool 6: wincode_analyze_change_impact works', async () => {
      const res = await callMcp('tools/call', {
        name: 'wincode_analyze_change_impact',
        arguments: { target: 'ToolRouter' },
      });
      const impact = JSON.parse(res.result?.content?.[0]?.text);
      assert.strictEqual(impact.target, 'ToolRouter');
      assert.ok(impact.riskLevel);
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

    it('Tool 9: wincode_safe_move_to_trash works safely', async () => {
      const tempTddFile = path.join(root, 'tdd_mcp_trash_test.txt');
      await fs.writeFile(tempTddFile, 'Temporary file to test MCP safe trash tool', 'utf-8');

      const res = await callMcp('tools/call', {
        name: 'wincode_safe_move_to_trash',
        arguments: { filePath: tempTddFile, reason: 'Testing via MCP call' },
      });
      const result = JSON.parse(res.result?.content?.[0]?.text);
      assert.strictEqual(result.success, true);
      assert.ok(result.trashPath.includes('trash'));
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
