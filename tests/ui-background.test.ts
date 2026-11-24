import { it } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/client';
import { WinCodeMcpServer } from '../src/Gateway/McpServer.js';
import { ToolRouter } from '../src/Core/ToolRouter.js';
import { getDefaultConfig } from '../src/Core/Config.js';
import { FlaUiAdapter } from '../src/Adapters/FlaUiAdapter.js';
import type { UiInspectRequest } from '../src/Core/UiContracts.js';

it('a background connection enforces window identity, safe actions and helper capabilities in both workspace modes', async t => {
  const sent: UiInspectRequest[] = [];
  let hostVersion = 7;
  t.mock.method(FlaUiAdapter.prototype as any, 'executeHost', async (request: UiInspectRequest) => {
    sent.push(request);
    return { schemaVersion: '1.0', protocolVersion: '1.0', requestId: request.requestId,
      success: true, inspectionVersion: hostVersion, backgroundOnly: request.backgroundOnly,
      tree: { id: 1, parentId: null, children: [] } };
  });
  const target = { pid: 123, hwnd: '0x42' };
  const control = { ...target, targetAutomationId: 'edit' };
  for (const workspaceMode of ['fixed', 'dynamic'] as const) {
    const router = new ToolRouter({ ...getDefaultConfig(process.cwd()), workspaceMode, backgroundUi: true,
      uiWriteWindow: { ...target, processStartFileTime: '133000000000000000' } });
    const server = new WinCodeMcpServer(router);
    const client = new Client({ name: 'background-connection', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      return JSON.parse((result.content as Array<{ text: string }>)[0].text);
    };
    try {
      await (server as any).server.connect(b); await client.connect(a);
      const listed = (await client.listTools()).tools.map(tool => tool.name);
      assert.ok(!listed.includes('wincode_ui_click') && !listed.includes('wincode_ui_set_expanded'));
      assert.equal((await call('wincode_hello_world', {})).uiMode, 'background');
      const project = workspaceMode === 'dynamic' ? { workspacePath: process.cwd() } : {};
      const review = { ...project, candidateFiles: ['tests/fixtures/wpf-ui-review/MainWindow.xaml'] };
      sent.length = 0;
      for (const args of [{ pid: target.pid }, { ...target, hwnd: '0x0' }, { ...target, hwnd: 'invalid' },
          { ...target, backgroundOnly: false }])
        assert.equal((await call('wincode_ui_inspect', args)).errorCode, 'INVALID_ARGUMENT');
      assert.equal((await call('wincode_ui_review', { ...review, pid: target.pid })).errorCode, 'INVALID_ARGUMENT');
      for (const args of [{ ...control, inputText: 'fixture' }, { ...control, inputText: 'fixture', mode: 'type' }])
        assert.equal((await call('wincode_ui_type', args)).errorCode, 'INVALID_ARGUMENT');
      assert.equal((await call('wincode_ui_click', control)).errorCode, 'UI_BACKGROUND_ONLY');
      assert.equal((await call('wincode_ui_set_expanded', { ...control, expanded: true })).errorCode, 'UI_BACKGROUND_ONLY');
      assert.equal((await call('wincode_ui_type', { ...control, hwnd: '0x43', mode: 'setValue', inputText: 'fixture',
        uiWriteWindow: { ...target, hwnd: '0x43' } })).errorCode, 'UI_WRITE_TARGET_DENIED');
      assert.equal(sent.length, 0);

      assert.equal((await call('wincode_ui_list_windows', {})).success, true);
      assert.equal((await call('wincode_ui_inspect', target)).backgroundOnly, true);
      assert.equal((await call('wincode_ui_review', { ...review, ...target })).backgroundOnly, true);
      assert.equal((await call('wincode_ui_type', { ...control, inputText: '', mode: 'setValue' })).success, true);
      assert.deepEqual(sent.filter(r => r.action !== 'health').map(r => [r.action ?? 'inspect', r.backgroundOnly]),
        [['listWindows', undefined], ['inspect', true], ['inspect', true], ['setValue', true]]);
      sent.length = 0;
      hostVersion = 5;
      assert.equal((await call('wincode_ui_type', { ...control, inputText: 'fixture', mode: 'setValue' })).errorCode, 'VERSION_MISMATCH');
      assert.deepEqual(sent.map(r => [r.action, r.hwnd, r.inputText]), [['health', undefined, undefined]]);
    } finally { hostVersion = 7; await client.close(); await server.stop(); }
  }
});

it('raw capture quality hints survive MCP without discarding image or UIA evidence', async () => {
  const router = new ToolRouter(getDefaultConfig(process.cwd()));
  const server = new WinCodeMcpServer(router);
  const client = new Client({ name: 'capture-quality', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  router.inspectUi = async () => ({ schemaVersion: '1.0', protocolVersion: '1.0', requestId: 'quality', success: true,
    tree: { id: 1, parentId: null, children: [] }, backgroundOnly: true, captureMethod: 'printWindow',
    captureQuality: { status: 'suspect-low-variation', sampleCount: 1024, maxChannelRange: 0, message: 'May be blank or a legitimate uniform view.' },
    screenshotPngBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=' });
  try {
    await (server as any).server.connect(b); await client.connect(a);
    const response = await client.callTool({ name: 'wincode_ui_inspect', arguments: { pid: 1, hwnd: '0x1', capture: 'original', backgroundOnly: true } });
    const blocks = response.content as Array<{ type: string; text: string }>;
    assert.equal(response.isError, false);
    const data = JSON.parse(blocks[0].text);
    assert.equal(data.tree.id, 1);
    assert.equal(data.captureQuality.status, 'suspect-low-variation');
    assert.equal(data.hasScreenshot, true);
    assert.equal(blocks.filter(item => item.type === 'image').length, 1);
  } finally { await client.close(); await server.stop(); }
});

it('background policy validates explicit identity before spawning and survives MCP serialization', async () => {
  const router = new ToolRouter(getDefaultConfig(process.cwd()));
  const server = new WinCodeMcpServer(router);
  const client = new Client({ name: 'background-policy', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  let calls = 0;
  router.inspectUi = async request => {
    calls++; assert.equal(request.backgroundOnly, true);
    return { schemaVersion: '1.0', protocolVersion: '1.0', requestId: 'background', success: true,
      backgroundOnly: true, tree: { id: 1, parentId: null, children: [] },
      imageOmitted: true, imageOmittedReason: 'Window capture failed; screen fallback disabled by backgroundOnly.' };
  };
  try {
    await (server as any).server.connect(b); await client.connect(a);
    for (const args of [{ pid: 1, backgroundOnly: true }, { hwnd: '0x1', backgroundOnly: true },
      { pid: 1, hwnd: '0x1', backgroundOnly: 'true' }]) {
      const result = await client.callTool({ name: 'wincode_ui_inspect', arguments: args });
      assert.equal(result.isError, true);
    }
    assert.equal(calls, 0);
    const response = await client.callTool({ name: 'wincode_ui_inspect', arguments: {
      pid: 1, hwnd: '0x1', backgroundOnly: true, capture: 'original',
    } });
    const blocks = response.content as Array<{ text: string }>;
    assert.equal(blocks.length, 1);
    const result = JSON.parse(blocks[0].text);
    assert.equal(result.tree.id, 1); assert.equal(result.imageOmitted, true);
    assert.equal(result.hasScreenshot, false); assert.equal(result.backgroundOnly, true);
    assert.equal(calls, 1);
  } finally { await client.close(); await server.stop(); }
});

it('ordinary connections verify per-request background capabilities and only return window-sourced images', async () => {
  const adapter = new FlaUiAdapter(getDefaultConfig(process.cwd()));
  let version: number | string = 7;
  let method = 'screen', omitTarget = false;
  const phases: string[] = [];
  const execute = (adapter as any).executeHost.bind(adapter);
  (adapter as any).executeHost = (request: UiInspectRequest, ...rest: unknown[]) => {
    phases.push(request.action ?? 'inspect'); return execute(request, ...rest);
  };
  adapter.resolveHostCommand = () => ({ command: process.execPath, args: ['-e',
    `let input='';process.stdin.on('data', c=>input+=c);process.stdin.on('end',()=>{
      const r=JSON.parse(input), out={schemaVersion:'1.0',protocolVersion:'1.0',requestId:r.requestId,success:true,inspectionVersion:${JSON.stringify(version)}};
      if(r.action==='inspect'){
        if(r.capture!=='none'||r.windowCapture!=='original') process.exit(2);
        Object.assign(out,{pid:r.pid,hwnd:${omitTarget ? 'undefined' : 'r.hwnd'},backgroundOnly:r.backgroundOnly,
          captureMethod:${JSON.stringify(method)},tree:{id:1},screenshotPngBase64:'Zml4dHVyZQ==',annotatedPngBase64:'Zml4dHVyZQ=='});
      }console.log(JSON.stringify(out));});`] });
  const request = { pid: 1, hwnd: '0x1', backgroundOnly: true, capture: 'original' as const };
  try {
    assert.equal((await adapter.inspect({ pid: 1, backgroundOnly: true })).errorCode, 'INVALID_ARGUMENT');
    for (const old of [6, '7']) {
      version = old; phases.length = 0;
      assert.equal((await adapter.inspect(request)).errorCode, 'VERSION_MISMATCH');
      assert.deepEqual(phases, ['health']);
    }
    version = 7;
    const omitted = await adapter.inspect(request);
    assert.equal(omitted.tree?.id, 1); assert.equal(omitted.imageOmitted, true);
    assert.equal(omitted.screenshotPngBase64, undefined); assert.equal(omitted.annotatedPngBase64, undefined);
    method = 'printWindowDwm';
    assert.ok((await adapter.inspect(request)).screenshotPngBase64);
    omitTarget = true;
    assert.equal((await adapter.inspect(request)).errorCode, 'VERSION_MISMATCH');
    assert.equal(adapter.isRunning, false);
  } finally { await adapter.dispose(); }
});
