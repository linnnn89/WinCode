import type { CallToolResult } from '@modelcontextprotocol/client';
import { WINCODE_TOOLS } from '../../src/Gateway/ToolRegistry.js';
import { runReadonlyUiWorkflow, type UiReader, type UiTarget, type UiReadCaller } from '../../src/Client/ReadonlyUiWorkflow.js';
import { createReadonlyUiRecipe } from '../../src/Client/ReadonlyUiRecipes.js';

export const sourceFile = 'tests/fixtures/wpf-ui-review/MainWindow.xaml';
const summary = { query: { automationId: 'hybridSummary' }, readStates: true, maxDepth: 2, maxNodes: 8 };
const checkboxParameters = { regionAutomationId: 'hybridChecks',
  checkboxAutomationIds: Array.from({ length: 8 }, (_, i) => 'hybridCheck' + i), maxDepth: 4, maxNodes: 40 };
const checked = { checkedCount: 7, unchecked: ['hybridCheck3'], disabled: ['hybridCheck6'] };
export const modelTasks = [
  { id: 'T1', instructions: 'Read hybridSummary toggle state using query:{automationId:"hybridSummary"}. Return {detailsRequired:boolean}. On means true; Off means false; unknown is an error.',
    expected: { detailsRequired: true }, run: async (reader: UiReader) => {
      const state = (await reader.inspect(summary)).tree?.states?.toggle;
      if (state !== 'On' && state !== 'Off') throw new Error('Unknown summary state.');
      return { detailsRequired: state === 'On' };
    } },
  { id: 'T2', instructions: 'Read hybridChecks once using query:{automationId:"hybridChecks"} (common parent of hybridCheck0 through hybridCheck7). Return {checkedCount:number,unchecked:string[],disabled:string[]}, arrays sorted by automationId. Count only these eight CheckBoxes, not their text children. checkedCount counts every toggle=On, including disabled controls; enabled and checked are independent states.',
    expected: checked, run: createReadonlyUiRecipe('checkbox-audit', checkboxParameters) },
  { id: 'T3', instructions: 'First observe hybridSummary using query:{automationId:"hybridSummary"}. Only after observing On, read hybridChecks using query:{automationId:"hybridChecks"} and return {detailsRequired:true,details:{checkedCount:number,unchecked:string[],disabled:string[]}} as in T2. Count only hybridCheck0 through hybridCheck7; count every toggle=On including disabled controls, and sort arrays by automationId. If Off, skip detail read and return {detailsRequired:false}. Unknown is an error. Do not plan a dependent detail read before observing the summary.',
    expected: { detailsRequired: true, details: checked },
    run: createReadonlyUiRecipe('checkbox-audit', { ...checkboxParameters, summaryAutomationId: 'hybridSummary' }) },
  { id: 'T4', instructions: `Use wincode_ui_review with query:{automationId:"btnNormalAction"} and candidateFiles:["${sourceFile}"]. Omit textQueries and candidateCodeFiles. Return {disabled:boolean,sourceCandidates:[{file:string,automationId:string}],runtimeSourceVerified:boolean}. Report literal source candidates without claiming runtime mapping.`,
    expected: { disabled: true, sourceCandidates: [{ file: sourceFile, automationId: 'btnNormalAction' }], runtimeSourceVerified: false },
    run: async (reader: UiReader) => {
      const value = await reader.review({ query: { automationId: 'btnNormalAction' }, maxDepth: 2, maxNodes: 8, candidateFiles: [sourceFile] });
      return { disabled: value.tree?.isEnabled === false, sourceCandidates: value.sourceEvidence?.nodes.flatMap(node =>
        node.candidates.map(candidate => ({ file: candidate.file, automationId: candidate.automationId }))),
        runtimeSourceVerified: value.sourceEvidence?.runtimeSourceVerified };
    } },
];
export type ModelTask = { id: string; instructions: string; expected: unknown; run: (reader: UiReader) => Promise<unknown> };
export function createModelTasks(summaryState: 'On' | 'Off'): ModelTask[] {
  if (!['On', 'Off'].includes(summaryState)) throw new Error('Unsupported fixture summary state.');
  return modelTasks.map(task => summaryState === 'Off' && ['T1', 'T3'].includes(task.id) ?
    { ...task, expected: { detailsRequired: false } } : task);
}
export type Message = { role: string; content?: string | null; tool_calls?: ToolCall[]; tool_call_id?: string; [key: string]: unknown };
type ToolCall = { id: string; type: string; function: { name: string; arguments: string } };
export type ModelReply = { id?: string; model?: string; system_fingerprint?: string; choices: Array<{ message: Message; finish_reason: string }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number; prompt_cache_hit_tokens?: number; [key: string]: unknown } };
export type ModelRequest = { model: string; messages: Message[]; tools: unknown[]; temperature: number; max_tokens: number; thinking: { type: string } };
export type Completion = (request: ModelRequest, signal: AbortSignal) => Promise<ModelReply>;

export function modelTools(mode: 'native' | 'hybrid') {
  return mode === 'native' ? WINCODE_TOOLS.filter(tool => ['wincode_ui_inspect', 'wincode_ui_review'].includes(tool.name))
    .map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })) :
    [{ type: 'function', function: { name: 'run_readonly_workflow',
      description: 'Run one trusted, preinstalled client recipe using existing serial inspect/review calls. ' + modelTasks.map(task => `${task.id}: ${task.instructions}`).join('\n'),
      parameters: { type: 'object', properties: { recipe: { type: 'string', enum: modelTasks.map(task => task.id) } }, required: ['recipe'], additionalProperties: false } } }];
}

/** A closed harness: no model source execution, tool discovery, arbitrary files or effect tools. */
export async function runModelUiTask(options: { task: ModelTask; mode: 'native' | 'hybrid'; target: UiTarget; model: string;
  complete: Completion; call: UiReadCaller; signal?: AbortSignal; timeoutMs?: number }) {
  const { task, mode, target, model, complete, call } = options;
  const signal = AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 120000), ...(options.signal ? [options.signal] : [])]);
  const messages: Message[] = [{ role: 'system', content: 'You are testing an isolated Windows fixture. Use only supplied tools. ' +
    'Observe before planning dependent reads; all calls execute serially. A deferred call did not execute. ' +
    'Read tool success and completeness. Missing state is not false. Final answer must be only the requested JSON object, no Markdown. ' +
    `Fixed target PID=${target.pid}, HWND=${target.hwnd}. Use backgroundOnly:true,capture:"none",responseFormat:"compact". ` +
    'Best scoped options: hybridSummary maxDepth=2 maxNodes=8 readStates=true; hybridChecks maxDepth=4 maxNodes=40 readStates=true; btnNormalAction maxDepth=2 maxNodes=8. ' +
    (mode === 'hybrid' ? 'The supplied recipes are already installed trusted programs; their descriptions and schema count toward context usage.' : '') },
    { role: 'user', content: `Task ${task.id}: ${task.instructions}` + (mode === 'hybrid' ? ` Use the matching preinstalled recipe ${task.id}.` : '') }];
  const tools = modelTools(mode), turns: Array<{ request: ModelRequest; response: ModelReply; elapsedMs: number }> = [];
  const toolResults: Array<{ id: string; name: string; result: unknown }> = [];
  let mcpCalls = 0, intermediateTextBytes = 0, deliveredTextBytes = 0, deferredCalls = 0, modelRequests = 0, modelLatencyMs = 0;
  const observations: string[] = [];
  let observedSummary: string | undefined;
  const tracked: UiReadCaller = async (name, args, opts) => {
    mcpCalls++; const value = await call(name, args, opts);
    intermediateTextBytes += value.content.filter(block => block.type === 'text').reduce((sum, block) => sum + Buffer.byteLength(block.text), 0);
    return value;
  };
  const recordObservations = (report: Awaited<ReturnType<typeof runReadonlyUiWorkflow>>['report']) => {
    // Raw MCP success is provisional. Only an accepted complete workflow can justify a final answer.
    if (!report.success) return;
    for (const step of report.steps) {
      const node = (step.evidence?.nodes as Array<{ automationId?: string; states?: { toggle?: string } }> | undefined)?.[0];
      if (step.status === 'completed' && typeof node?.automationId === 'string') {
        observations.push(node.automationId);
        if (node.automationId === 'hybridSummary') observedSummary = node.states?.toggle;
      }
    }
  };
  const started = performance.now();
  let findings: unknown, failure: string | undefined;
  try {
    for (let round = 0; round < 8; round++) {
      signal.throwIfAborted();
      const request: ModelRequest = { model, messages: structuredClone(messages), tools, temperature: 0, max_tokens: 2048, thinking: { type: 'disabled' } };
      if (Buffer.byteLength(JSON.stringify(request)) > 512 * 1024) throw new Error('MODEL_CONTEXT_BUDGET_EXCEEDED');
      const begin = performance.now(); modelRequests++;
      let response: ModelReply;
      try { response = await complete(request, signal); }
      finally { modelLatencyMs += performance.now() - begin; }
      turns.push({ request, response, elapsedMs: performance.now() - begin });
      const choice = response.choices?.[0];
      if (!choice || !choice.message || choice.message.role !== 'assistant') throw new Error('INVALID_MODEL_RESPONSE');
      messages.push(choice.message);
      const planned = choice.message.tool_calls ?? [];
      if (!planned.length) {
        if (choice.finish_reason !== 'stop') throw new Error('INCOMPLETE_MODEL_RESPONSE');
        if (!mcpCalls) throw new Error('FINAL_WITHOUT_OBSERVATION');
        findings = JSON.parse(choice.message.content ?? ''); break;
      }
      if (choice.finish_reason !== 'tool_calls') throw new Error('INCOMPLETE_MODEL_RESPONSE');
      if (planned.length > 16 || new Set(planned.map(item => item.id)).size !== planned.length || planned.some(item => !item.id))
        throw new Error('INVALID_MODEL_CALL_IDS');
      let observed = false;
      for (const item of planned) {
        signal.throwIfAborted();
        let result: unknown;
        if (observed) { deferredCalls++; result = { success: false, errorCode: 'DEFERRED_AFTER_OBSERVATION', workStarted: false,
          message: 'This call did not execute. Inspect the preceding result and issue any still-needed call in a new turn.' }; }
        else {
          const callsBefore = mcpCalls;
          try {
            if (item.type !== 'function') throw new Error('UNSUPPORTED_TOOL_CALL');
            const args = JSON.parse(item.function.arguments);
            if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('INVALID_ARGUMENT');
            if (mode === 'hybrid') {
              if (item.function.name !== 'run_readonly_workflow' || Object.keys(args).some(key => key !== 'recipe')) throw new Error('UNSUPPORTED_TOOL');
              const recipe = modelTasks.find(candidate => candidate.id === args.recipe);
              if (!recipe) throw new Error('UNKNOWN_RECIPE');
              const value = await runReadonlyUiWorkflow<unknown>(tracked, target, recipe.run, { signal });
              recordObservations(value.report);
              result = { content: value.content, isError: value.isError };
            } else {
              if (!['wincode_ui_inspect', 'wincode_ui_review'].includes(item.function.name)) throw new Error('UNSUPPORTED_TOOL');
              if ((args.pid !== undefined && args.pid !== target.pid) || (args.hwnd !== undefined && BigInt(args.hwnd) !== BigInt(target.hwnd))) throw new Error('TARGET_CHANGED');
              if ((args.backgroundOnly !== undefined && args.backgroundOnly !== true) || (args.capture !== undefined && args.capture !== 'none') ||
                (args.responseFormat !== undefined && args.responseFormat !== 'compact')) throw new Error('UNSUPPORTED_CAPTURE_OR_FORMAT');
              if (args.candidateFiles && JSON.stringify(args.candidateFiles) !== JSON.stringify([sourceFile])) throw new Error('UNSUPPORTED_SOURCE_FILE');
              if (args.candidateCodeFiles || args.textQueries) throw new Error('UNSUPPORTED_SOURCE_FILE');
              if (task.id === 'T3' && observedSummary === 'Off' && args.query?.automationId !== 'hybridSummary')
                throw new Error('DEPENDENT_READ_NOT_REQUIRED');
              if (task.id === 'T3' && args.query?.automationId === 'hybridChecks' && observedSummary !== 'On')
                throw new Error('DEPENDENT_READ_NOT_REQUIRED');
              const { pid: _pid, hwnd: _hwnd, backgroundOnly: _background, responseFormat: _format, ...input } = args;
              let original: CallToolResult | undefined;
              const checked = await runReadonlyUiWorkflow(async (...params) => { original = await tracked(...params); return original; }, target,
                reader => item.function.name === 'wincode_ui_inspect' ? reader.inspect(input) : reader.review(input), { signal });
              recordObservations(checked.report);
              result = checked.isError ? checked : original;
            }
            observed = true;
          } catch (error) {
            const errorCode = error instanceof SyntaxError ? 'INVALID_TOOL_ARGUMENT_JSON' : error instanceof Error ? error.message : 'HARNESS_ERROR';
            const hints: Record<string, string> = {
              UNSUPPORTED_TOOL: mode === 'hybrid' ? 'Use run_readonly_workflow with an installed T1–T4 recipe.' :
                'Use only wincode_ui_inspect or wincode_ui_review for this readonly task.',
              UNKNOWN_RECIPE: 'Choose the installed T1, T2, T3 or T4 recipe matching the requested task.',
              TARGET_CHANGED: 'Use the fixed PID/HWND in the system instructions; do not select another window.',
              INVALID_ARGUMENT: 'Supply a JSON object matching the advertised tool parameters.',
              INVALID_TOOL_ARGUMENT_JSON: 'Tool arguments must be valid JSON, without Markdown or expression syntax.',
              UNSUPPORTED_CAPTURE_OR_FORMAT: 'Use backgroundOnly:true, capture:"none" and responseFormat:"compact".',
              UNSUPPORTED_SOURCE_FILE: `Use only the advertised candidateFiles:["${sourceFile}"]; omit candidateCodeFiles and textQueries.`,
              DEPENDENT_READ_NOT_REQUIRED: 'For T3, observe hybridSummary first. Read hybridChecks only after accepted On; after Off return {"detailsRequired":false} without reading other regions.',
            };
            result = { success: false, errorCode, workStarted: mcpCalls > callsBefore,
              ...(hints[errorCode] ? { message: hints[errorCode] } : {}) };
          }
        }
        toolResults.push({ id: item.id, name: item.function.name, result });
        const text = JSON.stringify(result);
        deliveredTextBytes += Buffer.byteLength(text);
        messages.push({ role: 'tool', tool_call_id: item.id, content: text });
      }
    }
    if (findings === undefined) throw new Error('MODEL_ROUND_BUDGET_EXCEEDED');
    const required = task.id === 'T1' ? ['hybridSummary'] : task.id === 'T2' ? ['hybridChecks'] :
      task.id === 'T3' ? (observedSummary === 'Off' ? ['hybridSummary'] : ['hybridSummary', 'hybridChecks']) : ['btnNormalAction'];
    let cursor = 0;
    for (const observed of observations) if (observed === required[cursor]) cursor++;
    if (cursor !== required.length) throw new Error('FINAL_WITHOUT_REQUIRED_EVIDENCE');
    // Compare JSON structurally; model key order is irrelevant, while array order is part of the task.
    const canonical = (value: any): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
    if (canonical(findings) !== canonical(task.expected)) throw new Error('INCORRECT_FINDINGS');
  } catch (error) { failure = signal.aborted ? 'TASK_CANCELLED_OR_TIMED_OUT' : error instanceof Error ? error.message : 'HARNESS_ERROR'; }
  const measuredUsage = turns.length && modelRequests === turns.length && turns.every(turn => turn.response.usage && ['prompt_tokens', 'completion_tokens', 'total_tokens'].every(key =>
    Number.isSafeInteger(turn.response.usage![key]) && (turn.response.usage![key] as number) >= 0)) ? {
      promptTokens: turns.reduce((sum, turn) => sum + turn.response.usage!.prompt_tokens, 0),
      completionTokens: turns.reduce((sum, turn) => sum + turn.response.usage!.completion_tokens, 0),
      totalTokens: turns.reduce((sum, turn) => sum + turn.response.usage!.total_tokens, 0),
    } : null;
  const measuredCacheUsage = measuredUsage && turns.every(({ response: { usage } }) =>
    Number.isSafeInteger(usage!.prompt_cache_hit_tokens) && (usage!.prompt_cache_hit_tokens as number) >= 0 &&
    (usage!.prompt_cache_hit_tokens as number) <= usage!.prompt_tokens) ? {
      hitTokens: turns.reduce((sum, { response: { usage } }) => sum + (usage!.prompt_cache_hit_tokens as number), 0),
      missTokens: turns.reduce((sum, { response: { usage } }) => sum + usage!.prompt_tokens - (usage!.prompt_cache_hit_tokens as number), 0),
    } : null;
  return { task: task.id, mode, success: !failure, failure, findings, elapsedMs: performance.now() - started,
    modelRequests, completedModelRequests: turns.length, returnedModels: [...new Set(turns.map(turn => turn.response.model).filter(Boolean))],
    systemFingerprints: [...new Set(turns.map(turn => turn.response.system_fingerprint).filter(Boolean))],
    modelToolRounds: turns.filter(turn => turn.response.choices?.[0]?.message.tool_calls?.length).length,
    modelLatencyMs, mcpCalls, intermediateTextBytes, deliveredTextBytes, deferredCalls,
    measuredUsage, measuredCacheUsage, turns, toolResults };
}

/** Existing Chat Completions endpoint. No installation, credentials discovery, retries or redirects. */
export function httpCompletion(baseUrl: string, apiKey: string): Completion {
  const url = new URL(baseUrl.replace(/\/$/, '') + '/chat/completions');
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(url.hostname)))
    throw new Error('Use an HTTPS endpoint or explicit local test endpoint without URL credentials.');
  if (!apiKey) throw new Error('Supply WINCODE_MODEL_API_KEY through the environment.');
  return async (request, signal) => {
    const response = await fetch(url, { method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify(request) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`MODEL_HTTP_${response.status}`); }
    const reader = response.body!.getReader(); let bytes = 0; const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.length; if (bytes > 1024 * 1024) throw new Error('MODEL_RESPONSE_BUDGET_EXCEEDED');
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as ModelReply;
    } finally { await reader.cancel().catch(() => {}); }
  };
}
