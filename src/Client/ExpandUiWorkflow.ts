import type { UiInspectResult, UiNode, UiQuery } from '../Core/UiContracts.js';
import { validateUiQuery } from '../Core/UiContracts.js';
import type { UiReadCaller, UiTarget } from './ReadonlyUiWorkflow.js';

export type ExpandUiParameters = { parentQuery?: UiQuery; childQuery: UiQuery; candidateQuery?: UiQuery };
type NavigationCandidate = { query: UiQuery; state: string;
  nextRequest?: { action: 'expand-ui'; target: UiTarget; parameters: ExpandUiParameters; timeoutMs: number } };
type LocalNode = Pick<UiNode, 'id' | 'parentId' | 'automationId' | 'name' | 'controlType' | 'isEnabled' | 'propertyIssues'> & { state?: string };
type LocalObservation = { query: UiQuery; treeComplete: boolean; truncated: boolean; truncateReason?: string;
  traversalErrors: number; propertyIssueCount: number; matchCount: number; matches: LocalNode[];
  candidates: LocalNode[]; candidatesOmitted: number; matchesOmitted: number };

class NavigationStop extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** One explicit parent or one discovered collapsed Group; no recursive exploration. */
export async function runExpandUiWorkflow(call: UiReadCaller, target: UiTarget, parameters: ExpandUiParameters,
  options: { timeoutMs?: number; signal?: AbortSignal } = {}) {
  if (!target || !Number.isSafeInteger(target.pid) || target.pid < 1 || typeof target.hwnd !== 'string' ||
    target.hwnd.length > 32 || !/^(0x[\da-f]+|\d+)$/i.test(target.hwnd) || BigInt(target.hwnd) <= 0n)
    throw new Error('Supply an explicit positive PID and HWND.');
  if (!parameters || Object.keys(parameters).some(key => !['parentQuery', 'childQuery', 'candidateQuery'].includes(key)) ||
    !parameters.childQuery || (parameters.parentQuery !== undefined && parameters.candidateQuery !== undefined))
    throw new Error('Supply childQuery and at most one of parentQuery or candidateQuery; no other parameters are accepted.');
  validateUiQuery(parameters.parentQuery, true);
  validateUiQuery(parameters.childQuery, true);
  validateUiQuery(parameters.candidateQuery, true);
  if (parameters.candidateQuery && (Object.keys(parameters.candidateQuery).some(key => !['automationId', 'name', 'controlType'].includes(key)) ||
    (!parameters.candidateQuery.automationId && !parameters.candidateQuery.name) ||
    (parameters.candidateQuery.controlType !== undefined && parameters.candidateQuery.controlType !== 'Group')))
    throw new Error('candidateQuery requires an observed exact Group name or automationId and no search-budget fields.');
  const fixed = { ...target }, input = structuredClone(parameters);
  const timeoutMs = options.timeoutMs ?? 15000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('timeoutMs must be 1–30000.');
  const started = performance.now(), deadline = Date.now() + timeoutMs;
  const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(options.signal ? [options.signal] : [])]);
  const steps: Array<{ tool: string; value: UiInspectResult }> = [];
  let actionAttempted = false, bytes = 0, dispatchedCalls = 0, preserveLocalDiagnosis = false;
  const diagnosis: { initialQuery?: string; parentState?: string; cause: string; nextAction: string; relationshipVerified?: boolean;
    candidateSource?: 'supplied-parent' | 'discovered-group' | 'selected-group'; candidates?: NavigationCandidate[];
    localObservation?: LocalObservation } =
    { cause: 'unknown', nextAction: 'Inspect the authorized parent candidate; do not infer a collapsed parent from a missing child.' };
  let findings: { automationId?: string; state: string; states: UiNode['states'] } | undefined;
  let failure: NavigationStop | undefined;
  const stop = (code: string, message: string): never => { throw new NavigationStop(code, message); };
  const checkDeadline = () => {
    if (signal.aborted || Date.now() >= deadline) stop('INTERRUPTED', 'Navigation interrupted; action outcome may be unknown. Inspect state before any further action; never replay automatically.');
  };
  const invoke = async (tool: string, args: Record<string, unknown>) => {
    checkDeadline();
    if (dispatchedCalls >= (input.parentQuery ? 5 : 6)) stop('STEP_BUDGET_EXCEEDED', 'Navigation call budget exceeded.');
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
    if (!value.tree || value.treeComplete !== true || value.truncated || value.traversalErrors || blockingPropertyEvidence(value))
      stop('INCOMPLETE_OBSERVATION', 'Required subtree or state evidence is incomplete.');
  };
  // Geometry/class metadata is not needed for semantic expansion or toggle-state reads.
  // Keep all gaps in steps; unclassified issues and unexplained aggregate counts still block.
  const criticalProperties = (node: UiNode) => node.propertyIssues?.some(issue =>
    !['classname', 'bounds', 'isoffscreen'].includes(issue.split(':')[0].toLowerCase())) === true;
  const blockingPropertyEvidence = (value: UiInspectResult) => {
    let count = 0, critical = false;
    const visit = (node: UiNode) => {
      count += node.propertyIssues?.length ?? 0;
      critical ||= criticalProperties(node);
      node.children?.forEach(visit);
    };
    if (value.tree) visit(value.tree);
    return critical || (value.propertyIssueCount ?? 0) > count;
  };
  const matches = (node: UiNode, query: UiQuery): boolean =>
    (!query.automationId || node.automationId === query.automationId) && (!query.name || node.name === query.name) &&
    (!query.controlType || node.controlType === query.controlType);
  const readChild = (value: UiInspectResult) => {
    const child = unique(value);
    complete(value);
    if (!child.states || !['On', 'Off', 'Indeterminate'].includes(child.states.toggle))
      stop('STATE_UNAVAILABLE', 'Child toggle state is not known; do not infer Off.');
    findings = { automationId: child.automationId, state: child.states!.toggle, states: child.states };
    diagnosis.nextAction = 'Use the observed child state. No further navigation is needed.';
  };
  const discoverParent = async (): Promise<UiQuery> => {
    diagnosis.candidateSource = 'discovered-group';
    const value = await inspect({ controlType: 'Group', maxSearchNodes: 1000, maxMatches: 20 }, true);
    const query = value.queryResult;
    // This is match-set evidence: root-only tree truncation does not truncate the query search.
    if (!query?.searchComplete || query.status === 'incomplete' || value.traversalErrors || blockingPropertyEvidence(value) ||
      query.matches.some(node => criticalProperties(node) || node.controlType !== 'Group' ||
        typeof node.isEnabled !== 'boolean' || !['Collapsed', 'Expanded', 'LeafNode', 'PartiallyExpanded', 'unsupported'].includes(node.states?.expandCollapse ?? '')))
      return stop('NAVIGATION_DISCOVERY_INCOMPLETE', 'Group search or candidate state is incomplete. Do not infer uniqueness; inspect the page or supply a proven parentQuery.');
    const candidates = query.matches.filter(node => node.isEnabled === true && node.states?.expandCollapse === 'Collapsed');
    diagnosis.candidates = candidates.map(node => ({ query: { controlType: 'Group',
      ...(node.automationId ? { automationId: node.automationId } : {}), ...(node.name ? { name: node.name } : {}) }, state: 'Collapsed' }));
    for (const candidate of diagnosis.candidates) {
      if (candidate.query.automationId || candidate.query.name) candidate.nextRequest = { action: 'expand-ui', target: { ...fixed },
        parameters: { childQuery: structuredClone(input.childQuery), candidateQuery: { ...candidate.query } }, timeoutMs };
    }
    if (!candidates.length) return stop('NAVIGATION_CANDIDATE_NOT_FOUND', 'No enabled collapsed Group was observed. Other control types and recursive discovery are outside this workflow.');
    if (candidates.length !== 1) return stop('NAVIGATION_CANDIDATE_AMBIGUOUS', 'Multiple collapsed Groups were observed. Select a relevant returned nextRequest using task and page evidence; no action was taken.');
    const selected = diagnosis.candidates[0].query;
    if (!selected.automationId && !selected.name) return stop('NAVIGATION_CANDIDATE_UNADDRESSABLE', 'The candidate has no exact name or automationId. No action was taken.');
    validateUiQuery(selected, true);
    return selected;
  };
  try {
    const initial = await inspect(input.childQuery);
    diagnosis.initialQuery = initial.queryResult?.status;
    // Missing child is evidence, not permission to guess the parent or retry the same query.
    if (initial.queryResult?.status !== 'not-found' || !initial.queryResult.searchComplete) unique(initial);
    if (!input.parentQuery && initial.queryResult?.status === 'unique') {
      readChild(initial);
      diagnosis.cause = 'target-already-visible';
    } else {
      if (input.parentQuery) diagnosis.candidateSource = 'supplied-parent';
      if (input.candidateQuery) diagnosis.candidateSource = 'selected-group';
      // A selected target needs its own unique search, not a new census of unrelated Groups.
      const parentQuery = input.parentQuery ?? (input.candidateQuery
        ? { ...input.candidateQuery, controlType: 'Group' } : await discoverParent());
      const parent = await inspect(parentQuery, true);
      if (input.candidateQuery && parent.queryResult?.searchComplete &&
        ['not-found', 'ambiguous'].includes(parent.queryResult.status))
        stop('NAVIGATION_SELECTION_STALE', 'The selected Group no longer matches a unique current target. Inspect the selector and page; no action was taken.');
      const node = unique(parent);
      if (typeof node.isEnabled !== 'boolean') stop('TARGET_EVIDENCE_INCOMPLETE', 'Parent enabled state is unavailable; inspect enabled-state evidence before navigation. No action was attempted.');
      if (node.isEnabled === false) stop('TARGET_DISABLED', 'Parent is disabled; no navigation was attempted.');
      if (blockingPropertyEvidence(parent) || parent.traversalErrors ||
        (parent.truncated && parent.truncateReason !== 'maxDepth')) stop('INCOMPLETE_OBSERVATION', 'Parent identity/state evidence is incomplete.');
      diagnosis.parentState = node.states?.expandCollapse;
      if (!['Collapsed', 'Expanded'].includes(node.states?.expandCollapse ?? ''))
        stop('NO_EXPAND_COLLAPSE_PATTERN', 'Parent has no proven actionable expand state. Do not substitute a click.');
      if (node.states?.expandCollapse === 'Collapsed') {
        diagnosis.cause = 'observed-collapsed-navigation-candidate';
        diagnosis.nextAction = 'Set this unique parent to Expanded once, then verify the parent and child relationship.';
        await invoke('wincode_ui_set_expanded', { targetAutomationId: parentQuery.automationId,
          targetName: parentQuery.name, targetControlType: parentQuery.controlType, expanded: true });
      } else diagnosis.cause = 'parent-already-expanded';
      const verified = await inspect(parentQuery);
      const expanded = unique(verified);
      diagnosis.parentState = expanded.states?.expandCollapse;
      if (expanded.states?.expandCollapse !== 'Expanded') stop('EXPANSION_UNCONFIRMED', 'Parent was not observed Expanded. Stop; do not repeat the action.');
      const children: UiNode[] = [], innerCandidates: UiNode[] = [];
      const visit = (n: UiNode) => { for (const child of n.children) {
        if (matches(child, input.childQuery)) children.push(child);
        if (child.controlType === 'Group' && child.states?.expandCollapse === 'Collapsed') innerCandidates.push(child);
        visit(child);
      } };
      visit(expanded);
      const describeLocal = (n: UiNode): LocalNode => ({ id: n.id, parentId: n.parentId, automationId: n.automationId,
        name: n.name, controlType: n.controlType, isEnabled: n.isEnabled, propertyIssues: n.propertyIssues,
        state: n.states?.expandCollapse });
      // Observation IDs describe this tree only. Do not turn local matches into global action selectors.
      diagnosis.localObservation = { query: { ...parentQuery }, treeComplete: verified.treeComplete === true,
        truncated: verified.truncated === true, truncateReason: verified.truncateReason,
        traversalErrors: verified.traversalErrors ?? 0, propertyIssueCount: verified.propertyIssueCount ?? 0,
        matchCount: children.length, matches: children.slice(0, 20).map(describeLocal),
        candidates: innerCandidates.slice(0, 20).map(describeLocal), candidatesOmitted: Math.max(0, innerCandidates.length - 20),
        matchesOmitted: Math.max(0, children.length - 20) };
      if (verified.treeComplete !== true || verified.truncated || verified.traversalErrors || blockingPropertyEvidence(verified)) {
        preserveLocalDiagnosis = true;
        diagnosis.cause = 'local-observation-incomplete';
        diagnosis.nextAction = 'Parent is observed Expanded, but local evidence is incomplete. Inspect a narrower observed region or adjust the reported truncation limit; retain gaps and do not repeat expansion.';
      }
      complete(verified);
      if (children.length !== 1) {
        preserveLocalDiagnosis = true;
        diagnosis.cause = children.length > 1 ? 'child-ambiguous-in-parent' : innerCandidates.length
          ? 'observed-inner-collapsed-candidates' : 'child-not-found-in-parent';
        diagnosis.nextAction = children.length > 1
          ? 'Parent is Expanded. Use the observed local matches to refine the child selector; do not choose the first match.'
          : innerCandidates.length
            ? 'Parent is Expanded. Inspect the observed inner collapsed candidates and their relationship to this task. These local nodes are not proven global action targets; do not replay the parent expansion.'
            : 'Parent is Expanded and the complete local tree contains no matching child or inner collapsed Group. Check the child selector or page scope; the missing-target cause remains unknown. Do not repeat expansion.';
        stop('CHILD_RELATIONSHIP_UNCONFIRMED', 'Expanded parent does not contain exactly one matching child; see the local observation and diagnosis.');
      }
      diagnosis.relationshipVerified = true;
      readChild(await inspect(input.childQuery));
    }
  } catch (error) {
    failure = error instanceof NavigationStop ? error : new NavigationStop('NAVIGATION_ERROR',
      (error instanceof Error ? error.message : String(error)).slice(0, 2048));
    if (!preserveLocalDiagnosis) diagnosis.nextAction = actionAttempted
      ? 'Stop. Inspect the actual state before deciding on further work; no automatic action replay.'
      : 'Correct the reported selector, search or parent evidence before proposing an action.';
  }
  const selectionRequired = failure?.code === 'NAVIGATION_CANDIDATE_AMBIGUOUS' && !actionAttempted &&
    diagnosis.candidates?.some(candidate => candidate.nextRequest) === true;
  if (selectionRequired) diagnosis.nextAction = 'Choose a candidate using task and page evidence, add a new request id to its nextRequest, and submit once. If the evidence is insufficient, inspect or ask for clarification.';
  const report = { version: 1, success: !failure, status: selectionRequired ? 'selection-required' : failure ? 'stopped' : 'completed', target: fixed,
    errorCode: failure?.code, errorMessage: failure?.message, diagnosis, actionAttempted, findings: failure ? undefined : findings,
    steps, metrics: { elapsedMs: performance.now() - started, dispatchedCalls },
    observationSemantics: 'Ordered live observations; a supplied or discovered parent is only a candidate until child containment is verified.' };
  let text = JSON.stringify(report);
  if (Buffer.byteLength(text) > 128 * 1024) {
    report.success = false; report.status = 'stopped'; report.errorCode = 'OUTPUT_BUDGET_EXCEEDED'; report.findings = undefined;
    report.steps = []; report.errorMessage = 'Evidence omitted because output exceeded 128 KiB; completion is unproven.';
    text = JSON.stringify(report);
  }
  return { report, content: [{ type: 'text' as const, text }], isError: !report.success && report.status !== 'selection-required' };
}
