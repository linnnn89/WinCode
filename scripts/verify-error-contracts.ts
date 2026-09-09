import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { getDefaultConfig } from '../src/Core/Config.js';
import { ToolRouter } from '../src/Core/ToolRouter.js';
import { WinCodeMcpServer } from '../src/Gateway/McpServer.js';
import { AbortError } from '../src/Core/ResourceManager.js';

// Inventory current public responses before proposing an additive contract.
// Generated inputs only; native UI and external adapters are disabled.
const parent = path.resolve('test-tmp/error-contracts');
await fs.mkdir(parent, { recursive: true });
const root = await fs.mkdtemp(path.join(parent, 'run-'));
await fs.writeFile(path.join(root, 'A.cs'), 'class Same {}\n');
await fs.writeFile(path.join(root, 'B.cs'), 'class Same {}\n');
await fs.writeFile(path.join(root, 'Long.cs'), Array.from({ length: 100 }, (_, i) => `// ${i} ${'x'.repeat(100)}`).join('\n'));
const config = getDefaultConfig(root);
config.adapters.serena.enabled = false;
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
  try { body = JSON.parse(result.content[0].text); } catch { /* Plain-text errors are part of this inventory. */ }
  observations.push({ scenario, tool: name, result });
  check(result, body);
}
try {
  await router.initialize();
  await Promise.all([client.connect(left), (server as any).server.connect(right)]);
  await observe('unknown tool', 'missing_tool', {}, result => assert.equal(result.isError, true));
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
    assert.equal(body.source, 'serena-adapter-fallback'); assert.equal(body.analysisCompleteness, 'degraded');
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
  await router.dispose();
  await observe('shutdown rejection before admission', 'wincode_find_code_symbol', { query: 'Same' }, (result, body) => {
    assert.equal(result.isError, true); assert.equal(body.reason, 'cancelled'); assert.equal(body.recoverable, false);
  });
} catch (error) { failure = String(error); process.exitCode = 1; }
finally {
  await client.close();
  await server.stop();
  const reportFile = path.join(root, 'report.json');
  await fs.writeFile(reportFile, JSON.stringify({ success: !failure, failure, observations }, null, 2));
  console.log(JSON.stringify({ reportFile, success: !failure, scenarios: observations.length, failure }));
}
