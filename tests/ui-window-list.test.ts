import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { FlaUiAdapter } from '../src/Adapters/FlaUiAdapter.js';
import { getDefaultConfig } from '../src/Core/Config.js';
import { killProcessTree } from '../src/Core/ResourceManager.js';
import { UiInspectResult } from '../src/Core/UiContracts.js';

it('window discovery rejects invalid filters, disabled configuration and queued cancellation', async () => {
  const config = getDefaultConfig(process.cwd());
  config.adapters.flaui!.enabled = false;
  const disabled = new FlaUiAdapter(config);
  assert.equal((await disabled.listWindows({})).errorCode, 'HOST_UNAVAILABLE');
  assert.equal(disabled.isRunning, false);
  for (const request of [{ pid: 0 }, { maxWindows: 101 }, { titleContains: ' ' }, { processName: 3 }])
    assert.equal((await disabled.listWindows(request as any)).errorCode, 'INVALID_ARGUMENT');
  await disabled.dispose();

  const adapter = new FlaUiAdapter(getDefaultConfig(process.cwd()));
  let calls = 0;
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  (adapter as any).executeHost = async () => {
    calls++; entered(); await blocked;
    return { success: true, windows: [] };
  };
  const first = adapter.listWindows({}); await started;
  const controller = new AbortController();
  const queued = adapter.listWindows({}, controller.signal); controller.abort();
  assert.equal((await queued).errorCode, 'CANCELLED');
  assert.equal(calls, 1, 'Cancelled queued discovery must never execute');
  release(); await first;
  await adapter.listWindows({}); assert.equal(calls, 2);
  await adapter.dispose();
});

it('discovery timeout and cancellation wait for the actual helper process to exit', { timeout: 15000 }, async () => {
  const adapter = new FlaUiAdapter(getDefaultConfig(process.cwd()));
  adapter.resolveHostCommand = () => ({ command: process.execPath, args: ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000)'] });
  try {
    for (const cancel of [true, false]) {
      const controller = new AbortController();
      const pending = adapter.listWindows({}, controller.signal);
      const deadline = Date.now() + 2000;
      while (!adapter.getRuntimeStatus().activePid && Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 10));
      const helperPid = adapter.getRuntimeStatus().activePid;
      assert.ok(helperPid);
      if (cancel) controller.abort();
      const result = await pending;
      assert.equal(result.errorCode, cancel ? 'CANCELLED' : 'TIMEOUT');
      assert.equal(adapter.isRunning, false);
      assert.throws(() => process.kill(helperPid, 0), 'Helper must be gone at OS level');
    }
  } finally { await adapter.dispose(); }
});

it('real stdio MCP discovers duplicate Chinese windows, filters, caps and rejects stale handles', { timeout: 30000 }, async () => {
  const fixtures: ChildProcess[] = [];
  const client = new Client({ name: 'window-discovery-acceptance', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/index.js'], stderr: 'pipe' });
  try {
    for (let i = 0; i < 2; i++) {
      const child = spawn(path.resolve('tests/fixtures/wpf-ui-review/bin/Release/net10.0-windows/win-x64/publish/wpf-ui-review.exe'),
        ['--window-list-fixture', '--auto-close=25000'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      fixtures.push(child);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Fixture READY timeout')), 8000);
        let output = '';
        child.stdout!.on('data', chunk => { output += chunk; if (output.includes('READY ')) { clearTimeout(timer); resolve(); } });
        child.once('error', error => { clearTimeout(timer); reject(error); });
      });
    }
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.find(t => t.name === 'wincode_ui_list_windows')?.annotations?.readOnlyHint, true);
    const call = async (args: Record<string, unknown>): Promise<UiInspectResult> => {
      const response = await client.callTool({ name: 'wincode_ui_list_windows', arguments: args });
      const blocks = response.content as Array<{ type: string; text: string }>;
      assert.equal(blocks.length, 1); assert.equal(blocks[0].type, 'text');
      assert.ok(Buffer.byteLength(blocks[0].text) <= 128 * 1024);
      return JSON.parse(blocks[0].text);
    };
    assert.equal((await call({ maxWindows: 0 })).errorCode, 'INVALID_ARGUMENT');
    const result = await call({ processName: 'WPF-UI-REVIEW', titleContains: '窗口发现夹具', unexpected: true });
    assert.equal(result.success, true); assert.equal(result.enumerationComplete, true);
    assert.ok(Number.isFinite(Date.parse(result.capturedAt!)));
    const own = result.windows!.filter(w => fixtures.some(p => p.pid === w.pid));
    assert.equal(own.length, 4, 'Same titles within and across processes must remain separate');
    assert.equal(new Set(own.map(w => w.hwnd)).size, 4);
    assert.equal(result.tree, undefined); assert.equal(result.screenshotPngBase64, undefined);
    const target = fixtures[0].pid!;
    const filtered = await call({ pid: target, titleContains: '窗口发现夹具', processName: 'wpf-ui-review' });
    assert.equal(filtered.windows!.length, 2);
    const cap = await call({ pid: target, maxWindows: 1 });
    assert.equal(cap.windows!.length, 1); assert.equal(cap.truncated, true);
    assert.equal(cap.truncateReason, 'maxWindows'); assert.equal(cap.enumerationComplete, false);
    assert.equal((await call({ pid: target, processName: 'does-not-match' })).windows!.length, 0);
    for (const child of fixtures) process.kill(child.pid!, 0);
    const stale = filtered.windows![0];
    await killProcessTree(fixtures[0]);
    const inspection = await client.callTool({ name: 'wincode_ui_inspect', arguments: { pid: target, hwnd: stale.hwnd } });
    assert.equal(inspection.isError, true, 'A vanished target must not resolve another application');
    const health = await client.callTool({ name: 'wincode_hello_world', arguments: {} });
    assert.notEqual(health.isError, true);
    const status = JSON.parse((health.content as Array<{text: string}>)[0].text);
    assert.equal(status.health.flaui.runtime.activePid, null);
    assert.equal(status.health.flaui.runtime.isRunning, false);
    process.kill(fixtures[1].pid!, 0);
  } finally {
    await client.close();
    for (const child of fixtures) await killProcessTree(child);
  }
});
