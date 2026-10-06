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
    await rejected({ action: 'setExpanded', pid: 1, targetAutomationId: 'a' }, /expanded/);
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
    assert.equal(parse({ ...older, inspectionVersion: 3 }, { action: 'setExpanded', expanded: true }).errorCode, 'VERSION_MISMATCH');
    assert.equal(parse({ ...older, inspectionVersion: 4 }, { action: 'setExpanded', expanded: true }).success, true);
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

  const startFixture = async (extraArgs: string[] = []) => {
    const executable = path.resolve(root, 'tests/fixtures/wpf-ui-review/bin/Release/net10.0-windows/win-x64/publish/wpf-ui-review.exe');
    const built = fs.existsSync(executable);
    const args = ['--action-fixture', '--navigation-candidates', ...extraArgs, '--auto-close=120000'];
    const child = spawn(built ? executable : 'dotnet', built ? args :
      ['run', '--project', 'tests/fixtures/wpf-ui-review/wpf-ui-review.csproj', '--no-build', '--', ...args],
      { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    try {
      const target = await new Promise<{ pid: number; hwnd: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('fixture launch timed out waiting for READY')), 20000);
        let buffer = '';
        child.stdout?.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          const match = buffer.match(/READY\s+(\d+)\s+(0x[0-9a-fA-F]+)/);
          if (match) { clearTimeout(timer); resolve({ pid: Number(match[1]), hwnd: match[2] }); }
        });
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('close', code => { clearTimeout(timer); reject(new Error(`fixture exited prematurely with code ${code}`)); });
      });
      await new Promise(resolve => setTimeout(resolve, 400));
      return { child, target };
    } catch (error) { await killProcessTree(child); throw error; }
  };

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
    const started = await startFixture();
    fixture = started.child; pid = started.target.pid; hwnd = started.target.hwnd;
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

  const navigate = async (parent = { automationId: 'actionAdvanced' }) => {
    const { runExpandUiWorkflow } = await import('../src/Client/ExpandUiWorkflow.js');
    return runExpandUiWorkflow((name, args, options) => client.callTool({ name, arguments: args }, options),
      { pid, hwnd }, { parentQuery: parent, childQuery: { automationId: 'actionNormalize' } }, { timeoutMs: 15000 });
  };

  it('real property failures allow auxiliary gaps but distinguish unknown enabled evidence from disabled targets',
    { timeout: 45000 }, async () => {
      // Separate fault window keeps unknown-enabled nodes out of the normal discovery scenarios.
      const fault = await startFixture(['--background-fixture', '--navigation-evidence']);
      const callFault = (name: string, args: Record<string, unknown>) => call(name, { ...args, ...fault.target });
      try {
        for (const [id, expected] of [['actionAuxiliary', undefined], ['actionEnabledUnknown', 'TARGET_EVIDENCE_INCOMPLETE'],
          ['actionDisabledExpander', 'TARGET_DISABLED']] as const) {
          const before = await callFault('wincode_ui_inspect', { query: { automationId: id }, readStates: true,
            backgroundOnly: true, capture: 'none', responseFormat: 'compact' });
          assert.equal(before.body.tree.states.expandCollapse, 'Collapsed');
          assert.ok(before.body.tree.propertyIssues?.some((issue: string) => issue.startsWith('className:')));
          const action = await callFault('wincode_ui_set_expanded', { targetAutomationId: id, expanded: true });
          if (expected) {
            assert.equal(action.body.errorCode, expected, JSON.stringify(action));
            const after = await callFault('wincode_ui_inspect', { query: { automationId: id }, readStates: true });
            assert.equal(after.body.tree.states.expandCollapse, 'Collapsed');
          } else {
            assert.equal(action.body.success, true, JSON.stringify(action));
            assert.ok(action.body.actionTarget.propertyIssues?.some((issue: string) => issue.startsWith('className:')));
            await callFault('wincode_ui_set_expanded', { targetAutomationId: id, expanded: false });
            const { runExpandUiWorkflow } = await import('../src/Client/ExpandUiWorkflow.js');
            const checked = await runExpandUiWorkflow((name, args, options) => client.callTool({ name, arguments: args }, options),
              fault.target, { parentQuery: { automationId: id }, childQuery: { automationId: id + 'Check' } });
            assert.equal(checked.report.success, true, JSON.stringify(checked.report));
            assert.equal(checked.report.diagnosis.relationshipVerified, true);
            assert.equal(checked.report.findings?.state, 'On');
            assert.equal(checked.report.steps.filter(step => step.tool === 'wincode_ui_set_expanded').length, 1);
            await callFault('wincode_ui_set_expanded', { targetAutomationId: id, expanded: false });
          }
        }
        } finally { await killProcessTree(fault.child); }
    });

  it('expands a collapsed parent, verifies it and reads its actual child', { timeout: 30000 }, async () => {
    const collapsed = await call('wincode_ui_set_expanded', { pid, hwnd, targetAutomationId: 'actionAdvanced', expanded: false });
    assert.equal(collapsed.body.success, true, JSON.stringify(collapsed));
    const result = await navigate();
    assert.equal(result.report.success, true, JSON.stringify(result.report));
    assert.equal(result.report.steps[0].value.queryResult?.status, 'not-found');
    assert.equal(result.report.diagnosis.parentState, 'Collapsed');
    assert.equal(result.report.actionAttempted, true);
    assert.equal(result.report.findings?.state, 'On');
  });

  it('discovers the collapsed group without a parent selector and skips navigation when the child is visible', { timeout: 30000 }, async () => {
    const collapsed = await call('wincode_ui_set_expanded', { pid, hwnd, targetAutomationId: 'actionAdvanced', expanded: false });
    assert.equal(collapsed.body.success, true, JSON.stringify(collapsed));
    const { runExpandUiWorkflow } = await import('../src/Client/ExpandUiWorkflow.js');
    const automatic = () => runExpandUiWorkflow((name, args, options) => client.callTool({ name, arguments: args }, options),
      { pid, hwnd }, { childQuery: { automationId: 'actionNormalize' } }, { timeoutMs: 15000 });
    const discovered = await automatic();
    assert.equal(discovered.report.success, true, JSON.stringify(discovered.report));
    assert.equal(discovered.report.steps[0].value.queryResult?.status, 'not-found');
    assert.equal(discovered.report.diagnosis.candidateSource, 'discovered-group');
    assert.equal(discovered.report.diagnosis.relationshipVerified, true);
    assert.equal(discovered.report.actionAttempted, true);
    assert.equal(discovered.report.findings?.state, 'On');
    assert.equal(discovered.report.metrics.dispatchedCalls, 6);
    const visible = await automatic();
    assert.equal(visible.report.success, true, JSON.stringify(visible.report));
    assert.equal(visible.report.actionAttempted, false);
    assert.equal(visible.report.findings?.state, 'On');
    assert.equal(visible.report.metrics.dispatchedCalls, 1);
  });

  it('keeps an already expanded parent open without another navigation action', { timeout: 30000 }, async () => {
    const opened = await call('wincode_ui_set_expanded', { pid, hwnd, targetAutomationId: 'actionAdvanced', expanded: true });
    assert.equal(opened.body.success, true, JSON.stringify(opened));
    const result = await navigate();
    assert.equal(result.report.success, true, JSON.stringify(result.report));
    assert.equal(result.report.actionAttempted, false);
    assert.equal(result.report.findings?.state, 'On');
    const unchanged = await call('wincode_ui_set_expanded', { pid, hwnd, targetAutomationId: 'actionAdvanced', expanded: true });
    assert.equal(unchanged.body.status, 'already-expanded');
  });

  it('returns selectable live candidates and expands only the chosen group', { timeout: 30000 }, async () => {
    for (const id of ['actionAdvanced', 'actionDisplayAdvanced']) {
      const collapsed = await call('wincode_ui_set_expanded', { pid, hwnd, targetAutomationId: id, expanded: false });
      assert.equal(collapsed.body.success, true, JSON.stringify(collapsed));
    }
    const { runExpandUiWorkflow } = await import('../src/Client/ExpandUiWorkflow.js');
    const caller = (name: string, args: Record<string, unknown>, options: any) => client.callTool({ name, arguments: args }, options);
    const first = await runExpandUiWorkflow(caller, { pid, hwnd }, { childQuery: { automationId: 'actionNormalize' } });
    assert.equal(first.report.status, 'selection-required', JSON.stringify(first.report));
    assert.equal(first.isError, false);
    assert.equal(first.report.actionAttempted, false);
    assert.equal(first.report.diagnosis.candidates?.length, 2);
    const chosen = first.report.diagnosis.candidates!.find(candidate => candidate.query.name === 'Speech advanced');
    assert.ok(chosen?.nextRequest);
    const request = chosen.nextRequest;
    const selected = await runExpandUiWorkflow(caller, request.target, request.parameters, { timeoutMs: request.timeoutMs });
    assert.equal(selected.report.success, true, JSON.stringify(selected.report));
    assert.equal(selected.report.diagnosis.candidateSource, 'selected-group');
    assert.equal(selected.report.diagnosis.relationshipVerified, true);
    assert.equal(selected.report.findings?.state, 'On');
    assert.equal(selected.report.steps.filter(step => step.tool === 'wincode_ui_set_expanded').length, 1);
    const other = await call('wincode_ui_inspect', { pid, hwnd, query: { automationId: 'actionDisplayAdvanced' }, readStates: true });
    assert.equal(other.body.tree.states.expandCollapse, 'Collapsed');
    await call('wincode_ui_set_expanded', { pid, hwnd, targetAutomationId: 'actionDisplayAdvanced', expanded: true });
  });

  it('refuses ambiguous or unsupported navigation and preserves the parent state', { timeout: 30000 }, async () => {
    await call('wincode_ui_set_expanded', { pid, hwnd, targetAutomationId: 'actionAdvanced', expanded: false });
    for (const [parent, code] of [
      [{ automationId: 'actionDuplicate' }, 'QUERY_AMBIGUOUS'],
      [{ automationId: 'actionToggle' }, 'NO_EXPAND_COLLAPSE_PATTERN'],
    ] as const) {
      const result = await navigate(parent);
      assert.equal(result.report.errorCode, code, JSON.stringify(result.report));
      assert.equal(result.report.actionAttempted, false);
    }
    const refused = await call('wincode_ui_set_expanded', { pid, hwnd, targetAutomationId: 'actionToggle', expanded: true });
    assert.equal(refused.body.errorCode, 'NO_EXPAND_COLLAPSE_PATTERN');
    const parent = await call('wincode_ui_inspect', { pid, hwnd, query: { automationId: 'actionAdvanced' }, readStates: true });
    assert.equal(parent.body.tree.states.expandCollapse, 'Collapsed');
  });

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
