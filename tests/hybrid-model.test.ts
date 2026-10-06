import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { httpCompletion, modelTasks, runModelUiTask, type ModelReply, type Completion } from '../scripts/lib/hybrid-model.js';
import type { UiReadCaller } from '../src/Client/ReadonlyUiWorkflow.js';

const target = { pid: 42, hwnd: '0x123' };
const reply = (toolCalls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>, content?: unknown): ModelReply => ({
  model: 'fixed-test-model', choices: [{ message: { role: 'assistant', content: content === undefined ? null : JSON.stringify(content),
    ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls ? 'tool_calls' : 'stop' }],
  usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
});
const invoke = (id: string, name: string, args: unknown) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const call: UiReadCaller = async (_name, args) => {
  const id = (args.query as { automationId: string }).automationId;
  const children = id === 'hybridChecks' ? Array.from({ length: 8 }, (_, i) => ({ id: i + 2, parentId: 1, automationId: 'hybridCheck' + i,
    isEnabled: i !== 6, states: { toggle: i === 3 ? 'Off' : 'On' }, children: [] })) : [];
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, ...target, requestId: 'observation-' + id, treeComplete: true, truncated: false,
    queryResult: { status: 'unique', searchComplete: true, visitedNodes: 1, matches: [] },
    tree: { id: 1, parentId: null, automationId: id, states: { toggle: 'On' }, children } }) }] };
};
async function listen(server: Server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${(server.address() as { port: number }).port}`; }
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }

it('real HTTP contract counts all native/hybrid model requests, provider usage and final answers', async () => {
  const native = [reply([invoke('n1', 'wincode_ui_inspect', { query: { automationId: 'hybridSummary' }, readStates: true })]),
    reply([invoke('n2', 'wincode_ui_inspect', { query: { automationId: 'hybridChecks' }, readStates: true })]),
    reply(undefined, { detailsRequired: true, details: { checkedCount: 7, unchecked: ['hybridCheck3'], disabled: ['hybridCheck6'] } })];
  const hybrid = [reply([invoke('h1', 'run_readonly_workflow', { recipe: 'T3' })]), reply(undefined,
    { detailsRequired: true, details: { disabled: ['hybridCheck6'], unchecked: ['hybridCheck3'], checkedCount: 7 } })];
  const requests: any[] = [];
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer test-key'); assert.equal(request.url, '/chat/completions');
    let text = ''; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text); requests.push(body);
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify((body.tools[0].function.name === 'run_readonly_workflow' ? hybrid : native).shift()));
  });
  const base = await listen(server);
  try {
    const complete = httpCompletion(base, 'test-key');
    const a = await runModelUiTask({ task: modelTasks[2], mode: 'native', target, model: 'fixed-test-model', complete, call });
    const b = await runModelUiTask({ task: modelTasks[2], mode: 'hybrid', target, model: 'fixed-test-model', complete, call });
    assert.equal(a.success, true, a.failure); assert.equal(b.success, true, b.failure);
    assert.deepEqual([a.modelRequests, b.modelRequests, a.modelToolRounds, b.modelToolRounds, a.mcpCalls, b.mcpCalls], [3, 2, 2, 1, 2, 2]);
    assert.deepEqual(a.measuredUsage, { promptTokens: 300, completionTokens: 30, totalTokens: 330 });
    assert.deepEqual(b.measuredUsage, { promptTokens: 200, completionTokens: 20, totalTokens: 220 });
    assert.equal(requests[2].messages.filter((message: any) => message.role === 'tool').length, 2);
    assert.equal(requests[4].messages[3].tool_call_id, 'h1');
    assert.equal(requests.every(body => body.temperature === 0 && body.thinking.type === 'disabled'), true);
  } finally { await close(server); }
});

it('observation barriers preserve each call ID, defer dependent plans and reject writes or target drift before dispatch', async () => {
  let round = 0; const seen: string[] = [];
  const complete: Completion = async request => {
    round++;
    if (round === 1) return reply([invoke('summary', 'wincode_ui_inspect', { query: { automationId: 'hybridSummary' }, readStates: true }),
      invoke('premature', 'wincode_ui_inspect', { query: { automationId: 'hybridChecks' }, readStates: true })]);
    if (round === 2) {
      const results = request.messages.filter(message => message.role === 'tool');
      assert.deepEqual(results.map(message => message.tool_call_id), ['summary', 'premature']);
      assert.equal(JSON.parse(results[1].content!).errorCode, 'DEFERRED_AFTER_OBSERVATION');
      assert.equal(JSON.parse(results[1].content!).workStarted, false);
      assert.deepEqual(seen, ['hybridSummary']);
      return reply([invoke('after-observation', 'wincode_ui_inspect', { query: { automationId: 'hybridChecks' }, readStates: true })]);
    }
    return reply(undefined, { detailsRequired: true, details: { checkedCount: 7, unchecked: ['hybridCheck3'], disabled: ['hybridCheck6'] } });
  };
  const result = await runModelUiTask({ task: modelTasks[2], mode: 'native', target, model: 'test', complete,
    call: async (...args) => { seen.push((args[1].query as { automationId: string }).automationId); return call(...args); } });
  assert.equal(result.success, true, result.failure); assert.equal(result.deferredCalls, 1); assert.equal(result.mcpCalls, 2);
  for (const invalid of [invoke('effect', 'wincode_ui_click', {}), invoke('drift', 'wincode_ui_inspect', { pid: 999 })]) {
    let requests = 0;
    const rejected = await runModelUiTask({ task: modelTasks[0], mode: 'native', target, model: 'test', call: async () => { throw new Error('must not dispatch'); },
      complete: async () => ++requests === 1 ? reply([invalid]) : reply(undefined, { detailsRequired: true }) });
    assert.equal(rejected.mcpCalls, 0); assert.equal(rejected.failure, 'FINAL_WITHOUT_OBSERVATION');
    assert.equal((rejected.toolResults[0].result as any).workStarted, false);
  }
});

it('missing usage stays unknown and cancellation or HTTP errors produce partial evidence without retry or credential logging', async () => {
  let calls = 0;
  const complete: Completion = async () => {
    const value = ++calls === 1 ? reply([invoke('read', 'run_readonly_workflow', { recipe: 'T1' })]) : reply(undefined, { detailsRequired: true });
    delete value.usage; return value;
  };
  const unknown = await runModelUiTask({ task: modelTasks[0], mode: 'hybrid', target, model: 'test', complete, call });
  assert.equal(unknown.success, true); assert.equal(unknown.measuredUsage, null);
  let requests = 0, hold = false, entered!: () => void;
  const entering = new Promise<void>(resolve => { entered = resolve; });
  const server = createServer((_request, response) => {
    requests++; if (hold) { entered(); return; }
    response.writeHead(503); response.end('private provider error; never persist this body');
  });
  const base = await listen(server);
  try {
    const failed = await runModelUiTask({ task: modelTasks[0], mode: 'native', target, model: 'test', complete: httpCompletion(base, 'secret-test-key'), call });
    assert.equal(failed.failure, 'MODEL_HTTP_503'); assert.equal(failed.modelRequests, 1); assert.equal(requests, 1);
    assert.equal(failed.measuredUsage, null); assert.equal(JSON.stringify(failed).includes('secret-test-key'), false);
    const cancelled = await runModelUiTask({ task: modelTasks[0], mode: 'native', target, model: 'test', complete, call, signal: AbortSignal.abort() });
    assert.equal(cancelled.failure, 'TASK_CANCELLED_OR_TIMED_OUT'); assert.equal(cancelled.modelRequests, 0); assert.equal(cancelled.mcpCalls, 0);
    hold = true;
    const controller = new AbortController();
    const pending = runModelUiTask({ task: modelTasks[0], mode: 'native', target, model: 'test', complete: httpCompletion(base, 'test-key'), call, signal: controller.signal });
    await entering; controller.abort();
    const interrupted = await pending;
    assert.equal(interrupted.failure, 'TASK_CANCELLED_OR_TIMED_OUT'); assert.equal(interrupted.modelRequests, 1); assert.equal(interrupted.mcpCalls, 0);
    assert.equal(requests, 2); assert.equal(interrupted.measuredUsage, null);
  } finally { await close(server); }
});
