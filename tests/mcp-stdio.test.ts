import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { getDefaultConfig } from '../src/Core/Config.js';

import { killProcessTree } from '../src/Core/ResourceManager.js';

// 每个功能套件拥有独立缓存；并行文件不能删除彼此正在使用的缓存。
describe('mcp-stdio', () => {
  const root = process.cwd();
  const testCacheDir = path.join(root, '.cache', `test_mcp-stdio_${process.pid}`);
  const config = getDefaultConfig(root);
  config.cacheDir = testCacheDir;
  const FIXTURE_DOTNET = path.resolve(root, 'tests/fixtures/dotnet-mini');

  before(async () => {
    await fs.mkdir(testCacheDir, { recursive: true });
  });
  after(async () => {
    await fs.rm(testCacheDir, { recursive: true, force: true }).catch(() => { });
  });
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
          } catch { }
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
        await killProcessTree(proc).catch(() => { });
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
        arguments: { path: root },
      });
      const data = JSON.parse(res.result?.content?.[0]?.text);
      assert.strictEqual(data.workspace, root);
      assert.equal(typeof data.type, 'string');
      assert.equal(data.metadata.totalFiles, null);
      assert.equal(data.fileTree, undefined);
      assert.ok(data.entryPoints.length <= 8);

      const rejected = await callMcp('tools/call', {
        name: 'workspace_open',
        arguments: { path: FIXTURE_DOTNET },
      });
      assert.strictEqual(rejected.result.isError, true);
      assert.strictEqual(JSON.parse(rejected.result.content[0].text).errorCode, 'WORKSPACE_MISMATCH');
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
      assert.deepEqual(data.health.workspaceBinding, { mode: 'fixed', root, source: 'argument' });
      assert.equal(data.codeProvider, 'local-text');
      assert.equal(data.adapters.text.source, 'local-text');
      assert.equal(data.health.text.semanticConfigured, false);
      assert.equal(data.adapters.serena, undefined);
    });

    it('Tool 2: wincode_analyze_workspace works', async () => {
      const res = await callMcp('tools/call', {
        name: 'wincode_analyze_workspace',
        arguments: {},
      });
      const data = JSON.parse(res.result?.content?.[0]?.text);
      assert.equal(data.projectName, path.basename(root), 'workspace identity follows the actual checkout directory');
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
      assert.equal(res.result.content.length, 1);
      assert.ok(impact.formattedReport.includes('# Impact Analysis'));

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

    it('Error Handling: Unknown tool name returns a protocol error without crashing server', async () => {
      const res = await callMcp('tools/call', {
        name: 'non_existent_tool_12345',
        arguments: {},
      });
      assert.equal(res.error?.code, -32602);
      assert.equal(res.result, undefined);
      assert.ok(res.error?.message.includes('Unknown tool: non_existent_tool_12345'));
    });
  });
});
