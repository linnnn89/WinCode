import assert from 'node:assert/strict';
import { mock } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { getDefaultConfig } from '../src/Core/Config.js';
import { ToolRouter } from '../src/Core/ToolRouter.js';
import { WinCodeMcpServer } from '../src/Gateway/McpServer.js';
import { AbortError } from '../src/Core/ResourceManager.js';

// Verify the unified JSON tool-error contract, including domain outcomes.
// Generated inputs only; native UI and external adapters are disabled.
const parent = path.resolve('test-tmp/error-contracts');
await fs.mkdir(parent, { recursive: true });
const root = await fs.mkdtemp(path.join(parent, 'run-'));
await fs.writeFile(path.join(root, 'A.cs'), 'class Same {}\n');
await fs.writeFile(path.join(root, 'B.cs'), 'class Same {}\n');
await fs.writeFile(path.join(root, 'Long.cs'), Array.from({ length: 100 }, (_, i) => `// ${i} ${'x'.repeat(100)}`).join('\n'));
const config = getDefaultConfig(root);

config.adapters.flaui.enabled = false;
config.adapters.repomix.useCli = false;
const router = new ToolRouter(config);
const server = new WinCodeMcpServer(router);
const client = new Client({ name: 'error-contract-inventory', version: '1' });
const [left, right] = InMemoryTransport.createLinkedPair();
const observations: unknown[] = [];
let failure: string | undefined;
async function observe(scenario: string, name: string, args: Record<string, unknown>, check: (result: any, body: any) => void) {
  const result: any = await client.callTool({ name, arguments: args });
  let body: any = null;
  try { body = JSON.parse(result.content[0].text); } catch { throw new Error('Every tool response in this acceptance must contain JSON text.'); }
  if (result.isError) { assert.deepEqual(result.structuredContent, body); assert.equal(body.success, false); }
  observations.push({ scenario, tool: name, result });
  check(result, body);
}
try {
  await router.initialize();
  await Promise.all([client.connect(left), (server as any).server.connect(right)]);
  await assert.rejects(client.callTool({ name: 'missing_tool', arguments: {} }), (error: any) => {
    assert.equal(error.code, -32602);
    observations.push({ scenario: 'unknown tool protocol error', code: error.code });
    return true;
  });
  await observe('invalid code arguments', 'wincode_find_code_symbol', { query: 5 }, result => assert.equal(result.isError, true));
  await observe('outside workspace scope', 'wincode_prepare_context', { task: 'read', scopeFiles: ['../outside.cs'] }, result => assert.equal(result.isError, true));
  await observe('invalid UI arguments before native access', 'wincode_ui_inspect', {}, (result, body) => {
    assert.equal(result.isError, true); assert.equal(body.errorCode, 'INVALID_ARGUMENT');
  });
  await observe('ambiguous context target', 'wincode_prepare_context', { task: 'read', scopeFiles: ['A.cs', 'B.cs'], symbol: 'Same' }, (_result, body) => {
    assert.equal(body.evidence.length, 0); assert.ok(body.fileIssues.some((item: any) => item.reason.includes('ambiguous')));
  });
  await observe('response budget truncation', 'wincode_prepare_context', { task: 'read', lineRanges: [{ file: 'Long.cs', startLine: 1, endLine: 100 }], maxTokens: 512 }, (result, body) => {
    assert.equal(body.truncated, true); assert.ok(result.content[0].text.length <= 2048);
  });
  await observe('unavailable semantic upstream with empty local result', 'wincode_find_code_symbol', { query: 'Absent' }, (_result, body) => {
    assert.equal(body.source, 'local-text'); assert.equal(body.analysisCompleteness, 'degraded');
    assert.equal(body.totalFound, 0);
  });
  const original = router.findCodeSymbols;
  try {
    router.findCodeSymbols = async () => { throw new AbortError('inventory'); };
    await observe('execution cancellation (injected operation error)', 'wincode_find_code_symbol', { query: 'Same' }, (result, body) => {
      assert.equal(result.isError, true); assert.equal(body.errorCode, 'CANCELLED');
    });
    router.findCodeSymbols = async () => { throw new Error('inventory execution failure'); };
    await observe('unclassified execution exception', 'wincode_find_code_symbol', { query: 'Same' }, result => assert.equal(result.isError, true));
  } finally { router.findCodeSymbols = original; }
  // 保留领域载荷，不用人工构造的统一错误对象替代真实移动/恢复行为。
  await fs.writeFile(path.join(root, 'Trash.cs'), 'class Trash {}');
  const write = fs.writeFile;
  const metadataFault = mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
    if (String(args[0]).endsWith('.meta.json')) throw new Error('isolated metadata failure');
    return write(...args);
  });
  let movedPath = '';
  try {
    await observe('trash metadata partial failure', 'wincode_safe_move_to_trash', { filePath: 'Trash.cs' }, (result, body) => {
      assert.equal(result.isError, true); assert.equal(body.errorCode, 'TRASH_METADATA_FAILED');
      assert.equal(body.outcome, 'partial'); assert.equal(body.failureStage, 'metadata');
      assert.equal(body.originalPath, path.join(root, 'Trash.cs')); movedPath = body.trashPath;
    });
  } finally { metadataFault.mock.restore(); }
  assert.equal(await fs.readFile(movedPath, 'utf8'), 'class Trash {}');
  await assert.rejects(fs.stat(path.join(root, 'Trash.cs')), { code: 'ENOENT' });
  await observe('trash retry does not move again', 'wincode_safe_move_to_trash', { filePath: 'Trash.cs' }, (result, body) => {
    assert.equal(result.isError, true); assert.equal(body.outcome, 'not_moved'); assert.equal(body.trashPath, '');
  });
  const uiFault = mock.method(router, 'inspectUi', async () => ({ success: false, errorCode: 'CAPTURE_FAILED',
    errorMessage: 'isolated capture failure', auditNotice: { fixture: true },
    screenshotPngBase64: 'ZmFrZQ==' }) as any);
  try {
    await observe('UI failure preserves metadata and separate image (injected adapter result)', 'wincode_ui_inspect', { pid: 123 }, (result, body) => {
      assert.equal(result.isError, true); assert.equal(body.errorCode, 'CAPTURE_FAILED');
      assert.equal(body.hasScreenshot, true); assert.deepEqual(body.auditNotice, { fixture: true });
      assert.equal(body.screenshotPngBase64, undefined); assert.equal(result.content[1].type, 'image');
    });
  } finally { uiFault.mock.restore(); }
  const nextRoot = path.join(root, 'next');
  await fs.mkdir(nextRoot);
  const switchFault = mock.method(router.text, 'initialize', async () => { throw new Error('isolated rebind failure'); });
  try {
    await observe('workspace commit failure', 'workspace_open', { path: nextRoot }, (result, body) => {
      assert.equal(result.isError, true); assert.equal(body.errorCode, 'WORKSPACE_RECOVERY_REQUIRED');
      assert.equal(body.recoveryAction, 'workspace_open'); assert.equal(body.workspaceRecovery.recoveryAction, 'workspace_open');
    });
  } finally { switchFault.mock.restore(); }
  await observe('recovery state blocks subsequent business calls', 'wincode_find_code_symbol', { query: 'Same' }, (result, body) => {
    assert.equal(result.isError, true); assert.equal(body.errorCode, 'WORKSPACE_RECOVERY_REQUIRED');
    assert.equal(body.workspaceRecovery.recoveryAction, body.recoveryAction);
  });
  await observe('explicit workspace recovery', 'workspace_open', { path: root }, result => assert.notEqual(result.isError, true));
  await router.dispose();
  await observe('shutdown rejection before admission', 'wincode_find_code_symbol', { query: 'Same' }, (result, body) => {
    assert.equal(result.isError, true); assert.equal(body.errorCode, 'SHUTDOWN'); assert.equal(body.recoveryAction, 'restart_gateway');
  });
} catch (error) { failure = String(error); process.exitCode = 1; }
finally {
  await client.close();
  await server.stop();
  const reportFile = path.join(root, 'report.json');
  await fs.writeFile(reportFile, JSON.stringify({ success: !failure, failure, observations }, null, 2));
  console.log(JSON.stringify({ reportFile, success: !failure, scenarios: observations.length, failure }));
}
