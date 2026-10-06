import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runReadonlyUiWorkflow, type UiReadCaller } from '../src/Client/ReadonlyUiWorkflow.js';
import type { UiInspectResult } from '../src/Core/UiContracts.js';

const target = { pid: 42, hwnd: '0x123' };
const observation = (requestId = 'read-1'): UiInspectResult => ({ schemaVersion: '1.0', protocolVersion: '1.0',
  requestId, success: true, ...target, treeComplete: true, truncated: false,
  queryResult: { status: 'unique', searchComplete: true, visitedNodes: 1, matches: [] },
  tree: { id: 1, parentId: null, automationId: 'check', isEnabled: false,
    states: { toggle: 'On', selection: 'unsupported', expandCollapse: 'unsupported' }, children: [] } });
const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });

test('readonly workflow serializes concurrent requests, evaluates actual observations and retains native image evidence', async () => {
  let active = 0;
  const calls: string[] = [];
  const call: UiReadCaller = async (name, args) => {
    assert.equal(++active, 1);
    assert.deepEqual({ pid: args.pid, hwnd: args.hwnd }, target);
    assert.equal(args.backgroundOnly, true);
    assert.equal(args.responseFormat, 'compact');
    calls.push(name);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    const value = observation('read-' + calls.length);
    const payload = name === 'wincode_ui_review' ? { ...value, sourceEvidence: { fileScanComplete: true, truncated: false } } : value;
    return args.capture === 'original' ? { ...result(payload), content: [...result(payload).content,
      { type: 'image' as const, mimeType: 'image/png', data: 'aW1hZ2U=' }] } : result(payload);
  };
  const report = await runReadonlyUiWorkflow(call, target, async reader => {
    const [summary] = await Promise.all([reader.inspect({ query: { automationId: 'check' }, readStates: true }),
      reader.inspect({ query: { automationId: 'second' } })]);
    if (summary.tree?.states?.toggle === 'On') await reader.review({ query: { automationId: 'details' },
      candidateFiles: ['MainWindow.xaml'], capture: 'original' });
    const disabled = summary.tree?.isEnabled === false;
    summary.tree!.isEnabled = true;
    return { disabled };
  });
  assert.deepEqual(calls, ['wincode_ui_inspect', 'wincode_ui_inspect', 'wincode_ui_review']);
  assert.equal(report.isError, false);
  assert.deepEqual(report.report.findings, { disabled: true });
  assert.deepEqual(report.report.steps.map(step => step.requestId), ['read-1', 'read-2', 'read-3']);
  assert.equal((report.report.steps[0].evidence?.nodes as Array<{ isEnabled: boolean }>)[0].isEnabled, false);
  assert.equal(report.report.steps[2].imageContentIndex, 1);
  assert.equal(report.content[1].type, 'image');
  assert.equal((report.content[1] as { data: string }).data, 'aW1hZ2U=');
});

test('business/MCP errors, ambiguity, incomplete evidence and target drift stop dependents while retaining completed steps', async () => {
  for (const failure of [
    { value: { ...observation(), success: false, errorCode: 'TIMEOUT' }, isError: false, code: 'TIMEOUT' },
    { value: observation(), isError: true, code: 'TOOL_ERROR' },
    { value: { ...observation(), queryResult: { status: 'ambiguous', searchComplete: true } }, code: 'QUERY_AMBIGUOUS' },
    { value: { ...observation(), treeComplete: false, truncated: true }, code: 'INCOMPLETE_OBSERVATION' },
    { value: { ...observation(), pid: 99 }, code: 'TARGET_CHANGED' },
    { value: { ...observation(), sourceEvidence: { fileScanComplete: false } }, code: 'INCOMPLETE_OBSERVATION' },
    { value: { ...observation(), codeEvidence: { fileScanComplete: true, truncated: true } }, code: 'INCOMPLETE_OBSERVATION' },
  ]) {
    let count = 0;
    const value = await runReadonlyUiWorkflow(async () => ++count === 1 ? result(observation('completed')) :
      { ...result(failure.value), isError: failure.isError }, target, async reader => {
      await reader.inspect({});
      await Promise.all([reader.inspect({}), reader.inspect({})]);
    });
    assert.equal(count, 2);
    assert.equal(value.isError, true);
    assert.equal(value.report.errorCode, failure.code);
    assert.deepEqual(value.report.steps.map(step => step.status), ['completed', 'failed', 'not_started']);
    assert.equal(value.report.steps[0].requestId, 'completed');
  }
});

test('cancellation and input/step/data/output budgets prevent further dispatch without automatic retry', async () => {
  let calls = 0;
  const aborted = new AbortController();
  const cancelled = await runReadonlyUiWorkflow(async (_name, _args, options) => {
    calls++;
    aborted.abort();
    assert.equal(options.signal.aborted, true);
    return result(observation());
  }, target, async reader => { await Promise.all([reader.inspect({}), reader.inspect({})]); }, { signal: aborted.signal });
  assert.equal(calls, 1);
  assert.equal(cancelled.report.errorCode, 'CANCELLED');
  const invalid = await runReadonlyUiWorkflow(async () => { throw new Error('must not dispatch'); }, target,
    async reader => reader.inspect({ action: 'click' } as never));
  assert.equal(invalid.report.metrics.dispatchedCalls, 0);
  assert.equal(invalid.report.errorCode, 'INVALID_ARGUMENT');
  const exceeded = await runReadonlyUiWorkflow(async () => result(observation()), target,
    async reader => { await reader.inspect({}); await reader.inspect({}); }, { maxSteps: 1 });
  assert.equal(exceeded.report.errorCode, 'STEP_BUDGET_EXCEEDED');
  assert.equal(exceeded.report.metrics.dispatchedCalls, 1);
  const data = await runReadonlyUiWorkflow(async () => result(observation()), target, reader => reader.inspect({}), { maxIntermediateBytes: 1 });
  assert.equal(data.report.errorCode, 'INTERMEDIATE_BUDGET_EXCEEDED');
  const output = await runReadonlyUiWorkflow(async () => result(observation()), target, async reader => {
    await reader.inspect({}); return 'x'.repeat(9000);
  }, { maxOutputBytes: 8192 });
  assert.equal(output.report.errorCode, 'OUTPUT_BUDGET_EXCEEDED');
  assert.equal(output.report.steps[0].status, 'completed');
  assert.equal(output.report.steps[0].evidenceOmitted, true);
  const deadline = await runReadonlyUiWorkflow(async () => new Promise(() => {}), target,
    reader => reader.inspect({}), { timeoutMs: 10 });
  assert.equal(deadline.report.errorCode, 'DEADLINE_EXCEEDED');
});
