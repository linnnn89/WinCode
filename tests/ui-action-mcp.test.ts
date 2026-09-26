import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { WinCodeMcpServer } from '../src/Gateway/McpServer.js';
import { ToolRouter } from '../src/Core/ToolRouter.js';
import { getDefaultConfig } from '../src/Core/Config.js';
import { FlaUiAdapter } from '../src/Adapters/FlaUiAdapter.js';
import { killProcessTree } from '../src/Core/ResourceManager.js';

const root = process.cwd();

/** 只允许 ASCII 键盘输入：FlaUI 的 Keyboard.Type(string) 无法为非 ASCII 字符构造按键事件。 */
const TYPED_TEXT = 'typed-text';

it('ui actions are rejected at the boundary before any helper is launched', async () => {
  const adapter = new FlaUiAdapter(getDefaultConfig(root));
  let launched = 0;
  (adapter as any).executeHost = async () => { launched++; throw new Error('the helper must not be launched'); };
  const rejected = async (request: Record<string, unknown>, expectedMessage: RegExp) => {
    const result = await adapter.performUiAction(request as any);
    assert.equal(result.success, false, JSON.stringify(request));
    assert.equal(result.errorCode, 'INVALID_ARGUMENT', JSON.stringify(result));
    assert.match(result.errorMessage ?? '', expectedMessage);
  };
  try {
    // 没有唯一目标就不允许操作；这也是"必须先用 inspect 确认目标"的可执行版本。
    await rejected({ action: 'click', pid: 1 }, /selector/);
    await rejected({ action: 'click', pid: 1, targetAutomationId: '   ' }, /selector/);
    await rejected({ action: 'click', pid: 1, targetAutomationId: 42 }, /selector/);
    await rejected({ action: 'click', pid: 1, targetName: 'x', targetControlType: 'y', query: { name: 'Save' } }, /inspection/);
    await rejected({ action: 'click', pid: 1, targetName: 'Save', readStates: true }, /inspection/);
    // click 不接受输入文本；type 必须带非空输入；setValue 允许空串清空。
    await rejected({ action: 'click', pid: 1, targetAutomationId: 'a', inputText: 'x' }, /inputText/);
    await rejected({ action: 'type', pid: 1, targetAutomationId: 'a', inputText: '' }, /empty/);
    await rejected({ action: 'type', pid: 1, targetAutomationId: 'a', inputText: 'x'.repeat(4097) }, /4096/);
    await rejected({ action: 'type', pid: 1, targetAutomationId: 'a' }, /inputText/);
    await rejected({ action: 'click', pid: 1, targetAutomationId: 'a', clearBefore: true }, /clearBefore/);
    await rejected({ action: 'click', pid: 1, targetAutomationId: 'a', clearBefore: 'yes' }, /clearBefore/);
    assert.equal(launched, 0, 'rejected action requests must not start the native helper');
    // setValue 的空串用于清空值：它必须通过边界校验并真的走到 Helper，而不是被提前拒绝。
    const cleared = await adapter.performUiAction({ action: 'setValue', pid: 1, targetAutomationId: 'actionValue', inputText: '' } as any);
    assert.notEqual(cleared.errorCode, 'INVALID_ARGUMENT', JSON.stringify(cleared));
    assert.equal(launched, 1, 'an empty setValue is a valid request and must reach the native helper');
  } finally { await adapter.dispose(); }
});

it('an old helper cannot report a requested action as a successful inspection', async () => {
  const adapter = new FlaUiAdapter(getDefaultConfig(root));
  const parse = (hostResponse: unknown, request: Record<string, unknown>) =>
    (adapter as any).parseHostResponse(JSON.stringify(hostResponse),
      { requestId: 'fixture', pid: 1, targetAutomationId: 'btnSave', ...request });
  try {
    const older = { schemaVersion: '1.0', protocolVersion: '1.0', requestId: 'fixture',
      success: true, inspectionVersion: 2, action: 'click', actionMethod: 'InvokePattern' };
    // 旧 Helper 忽略 action 字段后返回的是一次成功的只读取证，绝不能被当作动作已执行。
    const refused = parse(older, { action: 'click' });
    assert.equal(refused.success, false);
    assert.equal(refused.errorCode, 'VERSION_MISMATCH');
    // 同一版本下，显式失败仍按 Helper 自己的原因上报，不伪装成版本问题。
    const failed = parse({ ...older, success: false, errorCode: 'WINDOW_NOT_FOUND' }, { action: 'click' });
    assert.equal(failed.errorCode, 'WINDOW_NOT_FOUND');
    // 升级后的 Helper 必须被接受，且新增的 query/state 门不会把 v3 误判为不兼容。
    const current = parse({ ...older, inspectionVersion: 3 }, { action: 'click' });
    assert.equal(current.success, true);
    assert.equal(current.actionMethod, 'InvokePattern');
    assert.equal(parse({ ...older, inspectionVersion: 3, queryResult: { status: 'unique', searchComplete: true, visitedNodes: 1, matches: [] } },
      { query: { name: 'Save' } }).success, true);
    // 新增的动作门不得放宽既有的 query/状态门：真正更旧的 Helper 仍必须被拒绝。
    assert.equal(parse(older, { query: { name: 'Save' } }).success, true);
    assert.equal(parse({ ...older, inspectionVersion: 1 }, { query: { name: 'Save' } }).errorCode, 'VERSION_MISMATCH');
    assert.equal(parse({ ...older, inspectionVersion: undefined }, { readStates: true }).errorCode, 'VERSION_MISMATCH');
  } finally { await adapter.dispose(); }
});

describe('semantic UI actions against the real WPF fixture', () => {
  const cacheDir = path.resolve(root, 'test-tmp/mcp_ui_action_test');
  let router: ToolRouter;
  let server: WinCodeMcpServer;
  let client: Client;
  let fixture: ChildProcess | null = null;
  let pid = 0;
  let hwnd = '';

  before(async () => {
    await fsp.mkdir(cacheDir, { recursive: true });
    const config = getDefaultConfig(root);
    config.cacheDir = path.join(cacheDir, 'cache');
    router = new ToolRouter(config);
    server = new WinCodeMcpServer(router);
    await router.initialize();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await (server as any).server.connect(serverTransport);
    client = new Client({ name: 'ui-action-suite', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);

    // 夹具是独立的真实 WPF 应用：验证的是应用自身的副作用，而不是 Host 自报的 success。
    const executable = path.resolve(root, 'tests/fixtures/wpf-ui-review/bin/Release/net10.0-windows/win-x64/publish/wpf-ui-review.exe');
    const built = fs.existsSync(executable);
    fixture = spawn(built ? executable : 'dotnet',
      built ? ['--action-fixture', '--auto-close=120000']
        : ['run', '--project', 'tests/fixtures/wpf-ui-review/wpf-ui-review.csproj', '--no-build', '--', '--action-fixture', '--auto-close=120000'],
      { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: false });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fixture launch timed out waiting for READY')), 20000);
      let buffer = '';
      fixture?.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const match = buffer.match(/READY\s+(\d+)\s+(0x[0-9a-fA-F]+)/);
        if (match) { clearTimeout(timer); pid = parseInt(match[1], 10); hwnd = match[2]; resolve(); }
      });
      fixture?.on('error', error => { clearTimeout(timer); reject(error); });
      fixture?.on('close', code => { clearTimeout(timer); reject(new Error(`fixture exited prematurely with code ${code}`)); });
    });
    await new Promise(resolve => setTimeout(resolve, 400));
  });

  after(async () => {
    if (fixture) { await killProcessTree(fixture).catch(() => {}); fixture = null; }
    try { await client?.close(); } catch {}
    try { await server?.stop(); } catch {}
    await fsp.rm(cacheDir, { recursive: true, force: true }).catch(() => {});
  });

  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await client.callTool({ name, arguments: args });
    return { isError: response.isError === true, body: JSON.parse((response.content as any)[0].text) };
  };
  /** 独立只读取证：TextBlock 的 UIA Name 就是它的文本，因此能看到动作的真实后果。 */
  const echo = async () => {
    const { body } = await call('wincode_ui_inspect', { pid, hwnd, query: { automationId: 'actionEcho' } });
    assert.equal(body.success, true, JSON.stringify(body));
    assert.equal(body.queryResult?.status, 'unique', JSON.stringify(body.queryResult));
    return body.queryResult.matches[0].name as string;
  };

  it('clicks, refuses ambiguous/disabled targets and writes text without echoing it', { timeout: 180000 }, async () => {
    assert.equal(await echo(), 'idle');

    const clicked = await call('wincode_ui_click', { pid, hwnd, targetAutomationId: 'actionIncrement' });
    assert.equal(clicked.isError, false, JSON.stringify(clicked.body));
    assert.equal(clicked.body.success, true);
    assert.equal(clicked.body.actionMethod, 'InvokePattern');
    assert.equal(clicked.body.actionTarget.automationId, 'actionIncrement');
    assert.equal(clicked.body.actionTarget.isEnabled, true);
    // 副作用必须由应用自身产生，而不是工具自报。
    assert.equal(await echo(), 'clicked:1');

    const ambiguous = await call('wincode_ui_click', { pid, hwnd, targetAutomationId: 'actionDuplicate' });
    assert.equal(ambiguous.isError, true);
    assert.equal(ambiguous.body.errorCode, 'TARGET_AMBIGUOUS');
    assert.equal(await echo(), 'clicked:1', 'an ambiguous selector must not click anything');

    const disabled = await call('wincode_ui_click', { pid, hwnd, targetAutomationId: 'actionDisabled' });
    assert.equal(disabled.body.errorCode, 'TARGET_DISABLED');
    assert.equal(await echo(), 'clicked:1');

    const missing = await call('wincode_ui_click', { pid, hwnd, targetAutomationId: 'actionDoesNotExist' });
    assert.equal(missing.body.errorCode, 'TARGET_NOT_FOUND');
    assert.equal(await echo(), 'clicked:1');

    const toggled = await call('wincode_ui_click', { pid, hwnd, targetAutomationId: 'actionToggle' });
    assert.equal(toggled.body.success, true, JSON.stringify(toggled.body));
    assert.equal(await echo(), 'toggled:true');

    // 键盘输入需要一个在前台的窗口：显式让夹具取得焦点，而不是让 Host 去激活它。
    const focus = await call('wincode_ui_click', { pid, hwnd, targetAutomationId: 'actionFocus' });
    assert.equal(focus.body.success, true, JSON.stringify(focus.body));
    await new Promise(resolve => setTimeout(resolve, 800));

    const typed = await call('wincode_ui_type', { pid, hwnd, targetAutomationId: 'actionInput', inputText: TYPED_TEXT, clearBefore: true });
    assert.equal(typed.isError, false, JSON.stringify(typed.body));
    assert.equal(typed.body.actionMethod, 'keyboard:clear+type');
    assert.equal(typed.body.inputLength, TYPED_TEXT.length);
    assert.equal(JSON.stringify(typed.body).includes(TYPED_TEXT), false, 'the sent text must not be echoed back');
    assert.equal(await echo(), 'text:' + TYPED_TEXT);

    const written = await call('wincode_ui_type', { pid, hwnd, targetAutomationId: 'actionValue', inputText: 'via-value', mode: 'setValue' });
    assert.equal(written.body.success, true, JSON.stringify(written.body));
    assert.equal(written.body.actionMethod, 'ValuePattern');
    assert.equal(await echo(), 'value:via-value');

    const readOnly = await call('wincode_ui_type', { pid, hwnd, targetAutomationId: 'actionReadOnly', inputText: 'nope', mode: 'setValue' });
    assert.equal(readOnly.body.success, false);
    assert.equal(readOnly.body.errorCode, 'VALUE_READONLY');
    assert.equal(await echo(), 'value:via-value');

    // 空串是合法的 setValue：schema 不得用 minLength 提前拒绝，且控件值必须真的被清空。
    const typeSchema = (await client.listTools()).tools.find(tool => tool.name === 'wincode_ui_type')!.inputSchema as any;
    assert.equal(typeSchema.properties.inputText.minLength, undefined, 'an empty inputText must stay schema-valid for mode=setValue');
    const clearedValue = await call('wincode_ui_type', { pid, hwnd, targetAutomationId: 'actionValue', inputText: '', mode: 'setValue' });
    assert.equal(clearedValue.body.success, true, JSON.stringify(clearedValue.body));
    assert.equal(clearedValue.body.inputLength, 0);
    assert.equal(await echo(), 'value:');
  });
});
