import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { FlaUiAdapter } from '../src/Adapters/FlaUiAdapter.js';
import { getDefaultConfig } from '../src/Core/Config.js';
import { killProcessTree } from '../src/Core/ResourceManager.js';
import { UiInspectResult } from '../src/Core/UiContracts.js';

for (const sameWindow of [false, true]) {
  it(`two stdio Gateways preserve ${sameWindow ? 'one window' : 'distinct windows'} across audit contention`, { timeout: 45000 }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-two-ui-'));
    const marker = path.join(root, 'provider-entered');
    const fixtures: ChildProcess[] = [];
    const gateways: Array<{ client: Client; transport: StdioClientTransport }> = [];
    const targets: Array<{ pid: number; hwnd: string }> = [];
    let first: Promise<any> | undefined;
    const call = async (index: number, name: string, args: Record<string, unknown> = {}) => {
      const result = await gateways[index].client.callTool({ name, arguments: args }, { timeout: 20000 });
      return { response: result, data: JSON.parse((result.content as Array<{ text: string }>)[0].text) };
    };
    try {
      for (let i = 0; i < 2; i++) {
        const child = spawn(path.resolve('tests/fixtures/wpf-ui-review/bin/Release/net10.0-windows/win-x64/publish/wpf-ui-review.exe'),
          ['--background-fixture', '--auto-close=40000'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
            env: { ...process.env, WINCODE_TEST_UI_LABEL: `Gateway target ${i}`, ...(i === 0 ? { WINCODE_TEST_UI_HOLD_MARKER: marker } : {}) } });
        fixtures.push(child);
        child.stderr!.resume();
        targets.push(await new Promise<{ pid: number; hwnd: string }>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('WPF fixture READY timeout')), 8000);
          let output = '';
          child.stdout!.on('data', chunk => {
            output = (output + chunk).slice(-4096);
            const ready = /READY (\d+) (0x[0-9A-F]+)/i.exec(output);
            if (ready) { clearTimeout(timer); resolve({ pid: Number(ready[1]), hwnd: ready[2] }); }
          });
          child.once('error', error => { clearTimeout(timer); reject(error); });
          child.once('exit', code => { clearTimeout(timer); reject(new Error(`WPF fixture exited: ${code}`)); });
        }));
        const workspace = path.join(root, `workspace-${i}`);
        await fs.mkdir(workspace);
        const transport = new StdioClientTransport({ command: process.execPath,
          args: [path.resolve('dist/index.js'), '--workspace', workspace], cwd: workspace, stderr: 'pipe' });
        transport.stderr?.on('data', () => {});
        const client = new Client({ name: `two-gateways-${i}`, version: '1' });
        gateways.push({ client, transport });
        await client.connect(transport);
      }
      assert.notEqual(gateways[0].transport.pid, gateways[1].transport.pid);
      const request = (target: number) => ({ ...targets[target], backgroundOnly: true, capture: 'original', maxDepth: 2 });
      await fs.writeFile(marker + '.armed', '');
      first = call(0, 'wincode_ui_inspect', request(0));
      // The provider marker is written only after the first helper enters real UIA access.
      const deadline = Date.now() + 8000;
      while (!(await fs.stat(marker).catch(() => null)) && Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(await fs.readFile(marker, 'utf8'), String(targets[0].pid));
      const active = (await call(0, 'wincode_hello_world')).data.health.flaui.runtime.activePid;
      assert.ok(active);
      const target = sameWindow ? 0 : 1;
      const blocked = await call(1, 'wincode_ui_inspect', request(target));
      assert.equal(blocked.data.errorCode, 'AUDIT_BUSY');
      assert.equal(blocked.data.success, false);
      assert.equal(blocked.data.tree, undefined);
      await fs.writeFile(marker + '.release', '');
      const completed = await first;
      const recovered = await call(1, 'wincode_ui_inspect', request(target));
      for (const [result, expected] of [[completed, 0], [recovered, target]] as const) {
        assert.equal(result.data.success, true, JSON.stringify(result.data));
        assert.equal(result.data.pid, targets[expected].pid);
        assert.equal(result.data.hwnd.toLowerCase(), targets[expected].hwnd.toLowerCase());
        assert.equal(result.data.tree.name, `Gateway target ${expected}`);
        const image = (result.response.content as Array<{ type: string; data?: string }>).find(block => block.type === 'image');
        assert.ok(image?.data, 'A successful original capture must contain a screenshot');
        const png = Buffer.from(image.data, 'base64');
        assert.equal(png.subarray(1, 4).toString(), 'PNG');
        assert.equal(png.readUInt32BE(16), result.data.imageWidth);
        assert.equal(png.readUInt32BE(20), result.data.imageHeight);
      }
      assert.throws(() => process.kill(active, 0), 'Completed helper must exit');
      for (let i = 0; i < 2; i++) {
        const health = (await call(i, 'wincode_hello_world')).data.health;
        assert.equal(health.flaui.runtime.activePid, null);
        assert.equal(health.managedChildProcesses, 0);
      }
    } finally {
      await fs.writeFile(marker + '.release', '');
      await first?.catch(() => {});
      for (const gateway of gateways) { await gateway.client.close(); await gateway.transport.close(); }
      for (const child of fixtures) { await killProcessTree(child); assert.throws(() => process.kill(child.pid!, 0)); }
      assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}

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
