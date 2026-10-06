import type { UiInspectResult, UiNode, UiQuery } from '../Core/UiContracts.js';
import { validateUiQuery } from '../Core/UiContracts.js';
import type { UiReadCaller, UiTarget } from './ReadonlyUiWorkflow.js';

export type ExpandUiParameters = { parentQuery: UiQuery; childQuery: UiQuery };

class NavigationStop extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** One caller-supplied navigation candidate, not recursive menu discovery or a readonly recipe. */
export async function runExpandUiWorkflow(call: UiReadCaller, target: UiTarget, parameters: ExpandUiParameters,
  options: { timeoutMs?: number; signal?: AbortSignal } = {}) {
  if (!target || !Number.isSafeInteger(target.pid) || target.pid < 1 || typeof target.hwnd !== 'string' ||
    target.hwnd.length > 32 || !/^(0x[\da-f]+|\d+)$/i.test(target.hwnd) || BigInt(target.hwnd) <= 0n)
    throw new Error('Supply an explicit positive PID and HWND.');
  if (!parameters || Object.keys(parameters).some(key => !['parentQuery', 'childQuery'].includes(key)) ||
    !parameters.parentQuery || !parameters.childQuery) throw new Error('Supply exactly parentQuery and childQuery.');
  validateUiQuery(parameters.parentQuery, true);
  validateUiQuery(parameters.childQuery, true);
  const fixed = { ...target }, input = structuredClone(parameters);
  const timeoutMs = options.timeoutMs ?? 15000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('timeoutMs must be 1–30000.');
  const started = performance.now(), deadline = Date.now() + timeoutMs;
  const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(options.signal ? [options.signal] : [])]);
  const steps: Array<{ tool: string; value: UiInspectResult }> = [];
  let actionAttempted = false, bytes = 0, dispatchedCalls = 0;
  const diagnosis: { initialQuery?: string; parentState?: string; cause: string; nextAction: string; relationshipVerified?: boolean } =
    { cause: 'unknown', nextAction: 'Inspect the authorized parent candidate; do not infer a collapsed parent from a missing child.' };
  let findings: { automationId?: string; state: string; states: UiNode['states'] } | undefined;
  let failure: NavigationStop | undefined;
  const stop = (code: string, message: string): never => { throw new NavigationStop(code, message); };
  const checkDeadline = () => {
    if (signal.aborted || Date.now() >= deadline) stop('INTERRUPTED', 'Navigation interrupted; action outcome may be unknown. Inspect state before any further action; never replay automatically.');
  };
  const invoke = async (tool: string, args: Record<string, unknown>) => {
    checkDeadline();
    if (dispatchedCalls >= 5) stop('STEP_BUDGET_EXCEEDED', 'Navigation permits at most five calls.');
    dispatchedCalls++;
    if (tool === 'wincode_ui_set_expanded') actionAttempted = true;
    const result = await call(tool, { ...args, ...fixed }, { signal, timeoutMs: Math.max(1, deadline - Date.now()) });
    const texts = result.content.filter(item => item.type === 'text');
    if (texts.length !== 1) stop('INVALID_RESPONSE', 'Expected one JSON result.');
    bytes += Buffer.byteLength(texts[0].text);
    if (bytes > 512 * 1024) stop('EVIDENCE_BUDGET_EXCEEDED', 'Navigation evidence exceeded 512 KiB.');
    const value = JSON.parse(texts[0].text) as UiInspectResult;
    steps.push({ tool, value: structuredClone(value) });
    checkDeadline();
    if (result.isError || value.success !== true) stop(value.errorCode ?? 'TOOL_ERROR', value.errorMessage ?? 'Tool failed; do not replay the action.');
    if (value.pid !== fixed.pid || !value.hwnd || BigInt(value.hwnd) !== BigInt(fixed.hwnd)) stop('TARGET_CHANGED', 'Response does not belong to the fixed target.');
    return value;
  };
  const inspect = (query: UiQuery, rootOnly = false) => invoke('wincode_ui_inspect', {
    query, readStates: true, backgroundOnly: true, capture: 'none', responseFormat: 'compact',
    maxDepth: rootOnly ? 1 : 8, maxNodes: rootOnly ? 1 : 128,
  });
  const unique = (value: UiInspectResult) => {
    const query = value.queryResult;
    if (!query) return stop('INVALID_RESPONSE', 'Missing scoped query evidence.');
    if (query?.status === 'ambiguous') stop('QUERY_AMBIGUOUS', 'Selector is ambiguous. Add an observed exact identifier; no navigation is permitted.');
    if (!query?.searchComplete || query.status === 'incomplete') stop('QUERY_INCOMPLETE', 'Search is incomplete. Missing controls cannot be inferred; no navigation is permitted.');
    if (query.status === 'not-found') stop('QUERY_NOT_FOUND', 'Complete search found no match. Check the page or selector; the cause remains unknown.');
    if (query.status !== 'unique' || query.matches.length !== 1 || !value.tree) stop('INVALID_RESPONSE', 'A complete unique target is required.');
    return value.tree!;
  };
  const complete = (value: UiInspectResult) => {
    const issues = (node: UiNode): boolean => Boolean(node.propertyIssues?.length) || node.children.some(issues);
    if (!value.tree || value.treeComplete !== true || value.truncated || value.traversalErrors || value.propertyIssueCount || issues(value.tree))
      stop('INCOMPLETE_OBSERVATION', 'Required subtree or state evidence is incomplete.');
  };
  const matches = (node: UiNode, query: UiQuery): boolean =>
    (!query.automationId || node.automationId === query.automationId) && (!query.name || node.name === query.name) &&
    (!query.controlType || node.controlType === query.controlType);
  try {
    const initial = await inspect(input.childQuery);
    diagnosis.initialQuery = initial.queryResult?.status;
    // Missing child is evidence, not permission to guess the parent or retry the same query.
    if (initial.queryResult?.status !== 'not-found' || !initial.queryResult.searchComplete) unique(initial);
    const parent = await inspect(input.parentQuery, true);
    const node = unique(parent);
    if (parent.propertyIssueCount || parent.traversalErrors || node.propertyIssues?.length ||
      (parent.truncated && parent.truncateReason !== 'maxDepth')) stop('INCOMPLETE_OBSERVATION', 'Parent identity/state evidence is incomplete.');
    diagnosis.parentState = node.states?.expandCollapse;
    if (node.isEnabled !== true) stop('TARGET_DISABLED', 'Parent is disabled or enabled state is unknown; no navigation was attempted.');
    if (!['Collapsed', 'Expanded'].includes(node.states?.expandCollapse ?? ''))
      stop('NO_EXPAND_COLLAPSE_PATTERN', 'Parent has no proven actionable expand state. Do not substitute a click.');
    if (node.states?.expandCollapse === 'Collapsed') {
      diagnosis.cause = 'observed-collapsed-navigation-candidate';
      diagnosis.nextAction = 'Set this unique parent to Expanded once, then verify the parent and child relationship.';
      await invoke('wincode_ui_set_expanded', { targetAutomationId: input.parentQuery.automationId,
        targetName: input.parentQuery.name, targetControlType: input.parentQuery.controlType, expanded: true });
    }
    const verified = await inspect(input.parentQuery);
    const expanded = unique(verified);
    complete(verified);
    if (expanded.states?.expandCollapse !== 'Expanded') stop('EXPANSION_UNCONFIRMED', 'Parent was not observed Expanded. Stop; do not repeat the action.');
    const children: UiNode[] = [];
    const visit = (n: UiNode) => { for (const child of n.children) { if (matches(child, input.childQuery)) children.push(child); visit(child); } };
    visit(expanded);
    if (children.length !== 1) stop('CHILD_RELATIONSHIP_UNCONFIRMED', 'Expanded parent does not contain exactly one matching child; check the navigation candidate.');
    diagnosis.relationshipVerified = true;
    const final = await inspect(input.childQuery);
    const child = unique(final);
    complete(final);
    if (!child.states || !['On', 'Off', 'Indeterminate'].includes(child.states.toggle))
      stop('STATE_UNAVAILABLE', 'Child toggle state is not known; do not infer Off.');
    findings = { automationId: child.automationId, state: child.states!.toggle, states: child.states };
    diagnosis.nextAction = 'Use the observed child state. No further navigation is needed.';
  } catch (error) {
    failure = error instanceof NavigationStop ? error : new NavigationStop('NAVIGATION_ERROR',
      (error instanceof Error ? error.message : String(error)).slice(0, 2048));
    diagnosis.nextAction = actionAttempted ? 'Stop. Inspect the actual state before deciding on further work; no automatic action replay.' :
      'Correct the reported selector, search or parent evidence before proposing an action.';
  }
  const report = { version: 1, success: !failure, status: failure ? 'stopped' : 'completed', target: fixed,
    errorCode: failure?.code, errorMessage: failure?.message, diagnosis, actionAttempted, findings: failure ? undefined : findings,
    steps, metrics: { elapsedMs: performance.now() - started, dispatchedCalls },
    observationSemantics: 'Ordered live observations; caller supplied parent is a candidate until child containment is verified.' };
  let text = JSON.stringify(report);
  if (Buffer.byteLength(text) > 128 * 1024) {
    report.success = false; report.status = 'stopped'; report.errorCode = 'OUTPUT_BUDGET_EXCEEDED'; report.findings = undefined;
    report.steps = []; report.errorMessage = 'Evidence omitted because output exceeded 128 KiB; completion is unproven.';
    text = JSON.stringify(report);
  }
  return { report, content: [{ type: 'text' as const, text }], isError: !report.success };
}
