import { it } from 'node:test';
import assert from 'node:assert/strict';
import { FlaUiAdapter } from '../src/Adapters/FlaUiAdapter.js';
import { getDefaultConfig } from '../src/Core/Config.js';
import { ToolRouter } from '../src/Core/ToolRouter.js';
import { WinCodeMcpServer } from '../src/Gateway/McpServer.js';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/client';

it('UIA initialization validates files without launching a probe; concurrent first diagnostics share the observation', async () => {
  const adapter = new FlaUiAdapter(getDefaultConfig(process.cwd()));
  let calls = 0;
  (adapter as any).resolveHostCommand = () => ({ command: process.execPath, args: [] });
  (adapter as any).executeHost = async () => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 20));
    return { success: true, status: 'healthy', hostIdentity: { version: 'fixture', configuration: 'Release' } };
  };
  try {
    await Promise.all([adapter.initialize(), adapter.initialize()]);
    assert.equal(calls, 0);
    assert.deepEqual(adapter.getKnownHealth(), { observedAt: null, health: null });
    const results = await Promise.all([adapter.checkHealth(), adapter.checkHealth()]);
    assert.equal(calls, 1);
    assert.ok(results.every(result => result.available));
  } finally { await adapter.dispose(); }
});

it('missing UIA files are reported at initialization and the first use can recover after files return', async () => {
  const adapter = new FlaUiAdapter(getDefaultConfig(process.cwd()));
  let calls = 0;
  (adapter as any).resolveHostCommand = () => null;
  try {
    await adapter.initialize();
    assert.equal(adapter.getKnownHealth().health?.available, false);
    assert.equal((await adapter.inspect({ pid: 1 })).errorCode, 'HOST_UNAVAILABLE');
    (adapter as any).executeHost = async () => { calls++; return { success: true, hostIdentity: { version: 'fixture' } }; };
    assert.equal((await adapter.inspect({ pid: 1 })).success, true);
    assert.equal(calls, 1, 'First use must execute only the requested operation');
    assert.equal(adapter.getKnownHealth().health?.available, true);
    assert.ok(adapter.getKnownHealth().health?.lastError, 'Successful use must preserve the earlier failure observation');
  } finally { await adapter.dispose(); }
});

it('a failed first UI operation preserves unknown health and remains visible in runtime errors', async () => {
  const router = new ToolRouter(getDefaultConfig(process.cwd()));
  (router.flaui as any).executeHost = async () => ({ success: false, errorCode: 'TIMEOUT', errorMessage: 'fixture timeout' });
  try {
    await router.flaui.inspect({ pid: 1 });
    const health = await router.getRuntimeHealth();
    assert.equal(health.healthObservation.flaui.state, 'unknown');
    assert.equal(health.flaui.available, null);
    assert.equal(health.lastAdapterError?.provider, 'flaui');
    assert.equal(health.lastAdapterError?.reason, 'timeout');
  } finally { await router.dispose(); }
});

it('helper pipe preserves Chinese characters split across UTF-8 chunks', async () => {
  const adapter = new FlaUiAdapter(getDefaultConfig(process.cwd()));
  const code = `process.stdin.resume(); process.stdin.on('end', () => {
    const bytes = Buffer.from(JSON.stringify({protocolVersion:'1.0', success:true, errorMessage:'中文'}));
    const split = bytes.indexOf(Buffer.from('中')) + 1;
    process.stdout.write(bytes.subarray(0,split));
    setTimeout(() => process.stdout.write(bytes.subarray(split)), 40);
  });`;
  (adapter as any).resolveHostCommand = () => ({ command: process.execPath, args: ['-e', code] });
  try {
    const result = await (adapter as any).executeHost({ requestId: 'split', action: 'inspect' }, 3000);
    assert.equal(result.success, true);
    assert.equal(result.errorMessage, '中文');
    assert.equal(adapter.isRunning, false);
  } finally { await adapter.dispose(); }
});

it('flooding helper is rejected at the transport budget and reaped', async () => {
  const adapter = new FlaUiAdapter(getDefaultConfig(process.cwd()));
  const code = `process.stdin.resume(); process.stdin.on('end', () => {
    setInterval(() => process.stdout.write(Buffer.alloc(65536, 120)), 1);
  });`;
  (adapter as any).resolveHostCommand = () => ({ command: process.execPath, args: ['-e', code] });
  try {
    const result = await (adapter as any).executeHost({ requestId: 'flood', action: 'inspect' }, 5000);
    assert.equal(result.errorCode, 'PAYLOAD_TOO_LARGE');
    assert.equal(adapter.isRunning, false);
  } finally { await adapter.dispose(); }
});

it('inspect deadline includes time waiting behind another request', async () => {
  const adapter = new FlaUiAdapter(getDefaultConfig(process.cwd()));
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  let calls = 0;
  (adapter as any).executeHost = async () => {
    calls++; entered();
    await new Promise<void>(r => { release = r; });
    return { success: true };
  };
  const first = adapter.inspect({ pid: 1, timeoutMs: 2000 });
  await started;
  try {
    const result = await adapter.inspect({ pid: 1, timeoutMs: 30 });
    assert.equal(result.errorCode, 'TIMEOUT');
    assert.equal(calls, 1, 'Timed-out queue entry must not execute');
  } finally { release(); await first; }
});

it('unconfirmed previous process blocks both inspection and health helper launches', async () => {
  const adapter = new FlaUiAdapter(getDefaultConfig(process.cwd()));
  (adapter as any).activeProcess = { pid: 123 };
  const res = await adapter.inspect({ pid: 1 });
  assert.equal(res.errorCode, 'BUSY');
  assert.equal(adapter.isRunning, true);
  const health = await adapter.checkHealth();
  assert.equal(health.available, false);
  assert.equal(adapter.isRunning, true);
});

it('final MCP text budget includes response metadata and uses UTF-8 bytes', async () => {
  const router = new ToolRouter(getDefaultConfig(process.cwd()));
  const server = new WinCodeMcpServer(router);
  const client = new Client({ name: 'budget-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await (server as any).server.connect(b);
  await client.connect(a);
  router.inspectUi = async () => ({
    schemaVersion: '1.0', protocolVersion: '1.0', requestId: 'test', success: true,
    errorMessage: '汉'.repeat(50000), screenshotPngBase64: 'AAAA',
  });
  try {
    const result = await client.callTool({ name: 'wincode_ui_inspect', arguments: { pid: 1 } });
    const content = result.content as Array<{ type: string; text?: string }>;
    assert.equal(result.isError, true);
    assert.equal(content.length, 1, 'Do not retain an image whose evidence was dropped');
    assert.ok(Buffer.byteLength(content[0].text!, 'utf8') <= 128 * 1024);
    assert.equal(JSON.parse(content[0].text!).errorCode, 'PAYLOAD_TOO_LARGE');
  } finally { await client.close(); await server.stop(); }
});
