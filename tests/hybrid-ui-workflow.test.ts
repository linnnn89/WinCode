import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runReadonlyUiWorkflow, type UiReadCaller } from '../src/Client/ReadonlyUiWorkflow.js';
import type { UiInspectResult } from '../src/Core/UiContracts.js';
import { createReadonlyUiRecipe } from '../src/Client/ReadonlyUiRecipes.js';
import { runExpandUiWorkflow } from '../src/Client/ExpandUiWorkflow.js';

const target = { pid: 42, hwnd: '0x123' };

const rangeParameters = { containerQuery: { name: 'library', controlType: 'Table' },
  startAfter: { name: '2024', controlType: 'DataItem' }, endBefore: { name: '2023', controlType: 'DataItem' } };
function flatLibrary(): UiInspectResult {
  const row = (id: number, name: string) => ({ id, parentId: 2, name, controlType: 'DataItem',
    propertyIssues: ['automationId:unsupported'], children: [] });
  return { ...observation(), propertyIssueCount: 6, tree: { id: 1, parentId: null, name: 'library', controlType: 'Table', children: [
    { id: 2, parentId: 1, propertyIssues: ['controlType:unsupported'], children: [
      row(3, '2025'), row(4, '2024'), row(5, 'Game A'), row(6, 'Game B'), row(7, '2023'),
    ] },
  ] } };
}

test('sibling range reads named rows without AutomationIds and preserves logical boundaries and native identities', async () => {
  let calls = 0;
  const checked = await runReadonlyUiWorkflow(async (tool, args) => {
    calls++;
    assert.equal(tool, 'wincode_ui_inspect');
    assert.equal(args.backgroundOnly, true);
    assert.equal(args.readStates, false);
    assert.equal('allowPropertyGaps' in args, false);
    assert.deepEqual(args.query, rangeParameters.containerQuery);
    return result(flatLibrary());
  }, target, createReadonlyUiRecipe('sibling-range', rangeParameters));
  assert.equal(checked.report.success, true, JSON.stringify(checked.report));
  const findings = checked.report.findings as any;
  assert.equal(calls, 1);
  assert.equal(findings.kind, 'logical-group');
  assert.equal(findings.basis, 'sibling-order');
  assert.equal(findings.coverage, 'observed-range-only');
  assert.equal(findings.businessGroupComplete, 'unknown');
  assert.deepEqual(findings.items.map((n: any) => [n.id, n.parentId, n.name]), [[5, 2, 'Game A'], [6, 2, 'Game B']]);
  assert.equal(findings.startAfter.id, 4); assert.equal(findings.endBefore.id, 7);
  assert.equal(findings.observedCount, 2);
  assert.equal(checked.report.steps[0].evidence!.propertyIssueCount, 6);
  const strict = await runReadonlyUiWorkflow(async () => result(flatLibrary()), target, reader => reader.inspect({}));
  assert.equal(strict.report.errorCode, 'INCOMPLETE_OBSERVATION');
});

test('sibling range rejects uncertain boundaries, unreadable names and incomplete observations without guessing an empty group', async () => {
  for (const scenario of ['missing', 'duplicate', 'reversed', 'different-parent', 'unreadable-name', 'name-error', 'truncated', 'search-incomplete']) {
    const value = flatLibrary(), rows = value.tree!.children[0].children;
    if (scenario === 'missing') rows.pop();
    if (scenario === 'duplicate') rows.push({ ...rows[1], id: 8 });
    if (scenario === 'reversed') rows.reverse();
    if (scenario === 'different-parent') { const end = rows.pop()!; end.parentId = 1; value.tree!.children.push(end); }
    if (scenario === 'unreadable-name') delete rows[2].name;
    if (scenario === 'name-error') rows[2].propertyIssues!.push('name:error');
    if (scenario === 'truncated') { value.treeComplete = false; value.truncated = true; }
    if (scenario === 'search-incomplete') value.queryResult!.searchComplete = false;
    value.propertyIssueCount = 1 + rows.reduce((n, row) => n + row.propertyIssues!.length, 0) + (scenario === 'different-parent' ? 1 : 0);
    const checked = await runReadonlyUiWorkflow(async () => result(value), target, createReadonlyUiRecipe('sibling-range', rangeParameters));
    assert.equal(checked.report.success, false, scenario);
    assert.equal(checked.report.findings, undefined, scenario);
    assert.ok(checked.report.steps[0].evidence, scenario);
  }
  for (const parameters of [{ ...rangeParameters, startAfter: {} }, { ...rangeParameters, endBefore: rangeParameters.startAfter },
    { ...rangeParameters, maxNodes: 0 }, { ...rangeParameters, scopePath: [] }, { ...rangeParameters, unexpected: true }]) {
    assert.throws(() => createReadonlyUiRecipe('sibling-range', parameters), (e: any) => e.code === 'INVALID_RECIPE_PARAMETERS' && e.workStarted === false);
  }
});
const observation = (requestId = 'read-1'): UiInspectResult => ({ schemaVersion: '1.0', protocolVersion: '1.0',
  requestId, success: true, ...target, treeComplete: true, truncated: false,
  queryResult: { status: 'unique', searchComplete: true, visitedNodes: 1, matches: [] },
  tree: { id: 1, parentId: null, automationId: 'check', isEnabled: false,
    states: { toggle: 'On', selection: 'unsupported', expandCollapse: 'unsupported' }, children: [] } });
const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });

test('readonly scopes reach inspect, review and both conditional recipe reads without extra calls', async () => {
  const scopePath = [{ automationId: 'voice' }];
  const scoped = () => ({ ...observation(), inspectionVersion: 5,
    scopeResult: { status: 'resolved' as const, resolvedCount: 1, visitedNodes: 3 } });
  const calls: any[] = [];
  const read = await runReadonlyUiWorkflow(async (tool, args) => {
    calls.push({ tool, args });
    return result({ ...scoped(), ...(tool === 'wincode_ui_review' ? { sourceEvidence: { fileScanComplete: true, truncated: false } } : {}) });
  }, target, async reader => {
    await reader.inspect({ scopePath, query: { automationId: 'check' } });
    await reader.review({ scopePath, candidateFiles: ['MainWindow.xaml'] });
  });
  assert.equal(read.report.success, true, JSON.stringify(read.report));
  assert.deepEqual(calls.map(call => call.tool), ['wincode_ui_inspect', 'wincode_ui_review']);
  assert.ok(calls.every(call => JSON.stringify(call.args.scopePath) === JSON.stringify(scopePath)));
  assert.deepEqual(read.report.steps[0].evidence?.scopeResult, scoped().scopeResult);
  for (const mode of ['on', 'off', 'unconditional', 'unscoped']) {
    const path = structuredClone(scopePath);
    const recipe = createReadonlyUiRecipe('checkbox-audit', { regionAutomationId: 'region', checkboxAutomationIds: ['check'],
      ...(mode === 'unconditional' ? {} : { summaryAutomationId: 'summary' }), ...(mode === 'unscoped' ? {} : { scopePath: path }) });
    path[0].automationId = 'changed-after-validation';
    const queries: string[] = [];
    const checked = await runReadonlyUiWorkflow(async (tool, args) => {
      assert.equal(tool, 'wincode_ui_inspect');
      assert.deepEqual(args.scopePath, mode === 'unscoped' ? undefined : scopePath);
      const id = (args.query as any).automationId; queries.push(id);
      const value = mode === 'unscoped' ? observation() : scoped();
      value.tree = { ...value.tree!, automationId: id, children: id === 'region'
        ? [{ ...observation().tree!, id: 2, parentId: 1, controlType: 'CheckBox' }] : [] };
      if (mode === 'off') value.tree.states!.toggle = 'Off';
      return result(value);
    }, target, recipe);
    assert.equal(checked.report.success, true, JSON.stringify(checked.report));
    assert.deepEqual(queries, mode === 'off' ? ['summary'] : mode === 'unconditional' ? ['region'] : ['summary', 'region']);
    assert.deepEqual(checked.report.findings, mode === 'off' ? { detailsRequired: false } : mode === 'unconditional'
      ? { checkedCount: 1, unchecked: [], disabled: ['check'] }
      : { detailsRequired: true, details: { checkedCount: 1, unchecked: [], disabled: ['check'] } });
  }
});

test('readonly scopes reject invalid paths, lost scope evidence and unsupported tools before producing findings', async () => {
  let dispatched = 0;
  for (const scopePath of [[], [{}], [{ name: '' }], [{ name: 'private', maxMatches: 1 }], Array(51).fill({ name: 'x' })]) {
    assert.throws(() => createReadonlyUiRecipe('checkbox-audit', { scopePath, regionAutomationId: 'region', checkboxAutomationIds: ['check'] }),
      (error: any) => error.code === 'INVALID_RECIPE_PARAMETERS' && error.field === 'scopePath' && error.workStarted === false && !error.message.includes('private'));
    const rejected = await runReadonlyUiWorkflow(async () => { dispatched++; return result(observation()); }, target,
      reader => reader.inspect({ scopePath } as any));
    assert.equal(rejected.report.success, false); assert.equal(rejected.report.steps[0].status, 'not_started');
  }
  assert.equal(dispatched, 0);
  const scopePath = [{ automationId: 'voice' }];
  const cases = [
    ...['SCOPE_NOT_FOUND', 'SCOPE_AMBIGUOUS', 'SCOPE_SEARCH_INCOMPLETE'].map(errorCode => ({ errorCode,
      payload: { ...observation(), success: false, errorCode, scopeResult: { resolvedCount: 0, failedIndex: 0, status: 'incomplete', visitedNodes: 3 } } })),
    ...[undefined, 4].map(inspectionVersion => ({ errorCode: 'VERSION_MISMATCH', payload: { ...observation(), inspectionVersion } })),
    { errorCode: 'INCOMPLETE_OBSERVATION', payload: { ...observation(), inspectionVersion: 5 } },
    { errorCode: 'INCOMPLETE_OBSERVATION', payload: { ...observation(), inspectionVersion: 5,
      scopeResult: { resolvedCount: 0, status: 'resolved', visitedNodes: 3 } } },
  ];
  for (const { errorCode, payload } of cases) {
    let calls = 0;
    const rejected = await runReadonlyUiWorkflow(async () => { calls++; return result(payload); }, target, async reader => {
      await reader.inspect({ scopePath });
      return reader.inspect({});
    });
    assert.equal(rejected.report.errorCode, errorCode, JSON.stringify(rejected.report));
    assert.equal(rejected.report.findings, undefined); assert.equal(calls, 1);
    assert.deepEqual(rejected.report.steps[0].evidence?.scopeResult, (payload as any).scopeResult);
  }
});

test('navigation keeps the observed parent path through selection, expansion and the final child read', async () => {
  const scopePath = [{ automationId: 'voiceRegion' }];
  const parentQuery = { automationId: 'advanced', controlType: 'Group' };
  const childQuery = { automationId: 'check' };
  for (const [selected, parentIsScope] of [[false, false], [true, false], [false, true]]) {
    const scopedPath = parentIsScope ? [parentQuery] : scopePath;
    const childPath = parentIsScope ? scopedPath : [...scopedPath, parentQuery];
    const calls: Array<{ tool: string; args: any }> = [];
    let expanded = selected;
    const checked = await runExpandUiWorkflow(async (tool, args) => {
      calls.push({ tool, args });
      const value = observation();
      if (tool === 'wincode_ui_set_expanded') {
        assert.deepEqual(args.scopePath, scopedPath);
        expanded = true; delete value.tree;
      } else if ((args.query as any).automationId === 'check') {
        assert.deepEqual(args.scopePath, childPath);
        if (!expanded) {
          delete value.tree; value.queryResult = { status: 'not-found', searchComplete: true, visitedNodes: 4, matches: [] };
        } else value.queryResult!.matches = [value.tree!];
      } else {
        assert.deepEqual(args.scopePath, scopedPath);
        value.tree = { ...observation().tree!, automationId: 'advanced', controlType: 'Group', isEnabled: true,
          states: { toggle: 'unsupported', selection: 'unsupported', expandCollapse: expanded ? 'Expanded' : 'Collapsed' },
          children: expanded && args.maxDepth !== 1 ? [{ ...observation().tree!, id: 2, parentId: 1 }] : [] };
        value.queryResult!.matches = [value.tree];
      }
      return result(value);
    }, target, { scopePath: scopedPath, childQuery, ...(selected ? { candidateQuery: parentQuery } : { parentQuery }) });
    assert.equal(checked.report.success, true, JSON.stringify(checked.report));
    assert.equal(checked.report.findings?.state, 'On');
    assert.equal(checked.report.diagnosis.relationshipVerified, true);
    assert.equal(calls.filter(c => c.tool === 'wincode_ui_set_expanded').length, selected ? 0 : 1);
  }
  let dispatched = 0;
  for (const invalid of [[], [{ automationId: 'region', maxMatches: 1 }], Array(50).fill({ automationId: 'region' })]) {
    await assert.rejects(runExpandUiWorkflow(async () => { dispatched++; return result(observation()); }, target,
      { scopePath: invalid, parentQuery, childQuery } as any), /scopePath/);
  }
  assert.equal(dispatched, 0);
  const choices = await runExpandUiWorkflow(async (_tool, args) => {
    assert.deepEqual(args.scopePath, scopePath);
    const value = observation();
    delete value.tree;
    value.queryResult = (args.query as any).controlType === 'Group'
      ? { status: 'ambiguous', searchComplete: true, visitedNodes: 4, matches: ['advanced', 'other'].map(automationId =>
        ({ ...observation().tree!, automationId, controlType: 'Group', isEnabled: true,
          states: { toggle: 'unsupported', selection: 'unsupported', expandCollapse: 'Collapsed' } })) }
      : { status: 'not-found', searchComplete: true, visitedNodes: 4, matches: [] };
    return result(value);
  }, target, { scopePath, childQuery } as any);
  assert.equal(choices.report.status, 'selection-required');
  for (const candidate of choices.report.diagnosis.candidates ?? []) {
    assert.deepEqual((candidate.nextRequest?.parameters as any).scopePath, scopePath);
    assert.deepEqual(candidate.nextRequest?.target, target);
    assert.deepEqual(candidate.nextRequest?.parameters.childQuery, childQuery);
  }
  const missing = await runExpandUiWorkflow(async () => result({ ...observation(), success: false,
    errorCode: 'SCOPE_NOT_FOUND', errorMessage: 'The observed region disappeared.' }), target,
    { scopePath, parentQuery, childQuery } as any);
  assert.equal(missing.report.errorCode, 'SCOPE_NOT_FOUND');
  assert.equal(missing.report.actionAttempted, false);
  assert.equal(missing.report.findings, undefined);
  for (const [code, expected] of [['SCOPE_AMBIGUOUS', 'QUERY_AMBIGUOUS'], ['SCOPE_NOT_FOUND', 'QUERY_NOT_FOUND'],
    ['SCOPE_SEARCH_INCOMPLETE', 'QUERY_INCOMPLETE']] as const) {
    const failedParent = await runExpandUiWorkflow(async () => result({ ...observation(), success: false, errorCode: code,
      scopeResult: { resolvedCount: 1, failedIndex: 1, status: 'not-found', visitedNodes: 4 } }), target,
      { scopePath, parentQuery, childQuery });
    assert.equal(failedParent.report.errorCode, expected);
    assert.equal(failedParent.report.actionAttempted, false);
    assert.equal(failedParent.report.steps[0].value.errorCode, code);
  }
  const staleSelection = await runExpandUiWorkflow(async () => result({ ...observation(), success: false,
    errorCode: 'SCOPE_NOT_FOUND', scopeResult: { resolvedCount: 1, failedIndex: 1, status: 'not-found', visitedNodes: 4 } }), target,
    { scopePath, candidateQuery: parentQuery, childQuery });
  assert.equal(staleSelection.report.errorCode, 'NAVIGATION_SELECTION_STALE');
  assert.equal(staleSelection.report.actionAttempted, false);
});

test('selected expanded parents resume with local evidence instead of rediscovering unrelated groups', async () => {
  for (const hidden of [false, true]) {
    const calls: string[] = [];
    const checked = await runExpandUiWorkflow(async (tool, args) => {
      calls.push(tool);
      const value = observation();
      if (calls.length === 1) {
        delete value.tree; value.queryResult = { status: 'not-found', searchComplete: true, visitedNodes: 8, matches: [] };
      } else if (calls.length === 2 || calls.length === 3) {
        assert.deepEqual(args.query, { automationId: 'outer', controlType: 'Group' });
        const child = { ...observation().tree!, id: 2, parentId: 1, controlType: hidden ? 'Group' : 'CheckBox',
          automationId: hidden ? 'inner' : 'check', isEnabled: true,
          states: { toggle: hidden ? 'unsupported' : 'On', selection: 'unsupported', expandCollapse: hidden ? 'Collapsed' : 'unsupported' } };
        value.tree = { ...observation().tree!, automationId: 'outer', controlType: 'Group', isEnabled: true,
          states: { toggle: 'unsupported', selection: 'unsupported', expandCollapse: 'Expanded' },
          children: calls.length === 3 ? [child] : [] };
        value.queryResult!.matches = [value.tree];
      } else value.queryResult!.matches = [value.tree!];
      return result(value);
    }, target, { childQuery: { automationId: 'check' }, candidateQuery: { automationId: 'outer', controlType: 'Group' } });
    assert.equal(checked.report.actionAttempted, false);
    assert.equal(checked.report.diagnosis.parentState, 'Expanded');
    assert.equal(checked.report.success, !hidden, JSON.stringify(checked.report));
    assert.equal(checked.report.diagnosis.cause, hidden ? 'observed-inner-collapsed-candidates' : 'parent-already-expanded');
    assert.equal(checked.report.findings?.state, hidden ? undefined : 'On');
    assert.equal(calls.length, hidden ? 3 : 4);
  }
});

test('post-expansion diagnostics preserve local candidates, absence, ambiguity and incomplete evidence without another action', async () => {
  for (const scenario of ['inner', 'absent', 'ambiguous', 'truncated', 'traversal']) {
    const calls: string[] = [];
    const checked = await runExpandUiWorkflow(async (tool, args) => {
      calls.push(tool);
      const value = observation();
      if (calls.length === 1) {
        delete value.tree; value.queryResult = { status: 'not-found', searchComplete: true, visitedNodes: 8, matches: [] };
      } else {
        const child = { ...observation().tree!, id: 2, parentId: 1, automationId: 'check', controlType: 'CheckBox' };
        const inner = { ...child, automationId: 'inner', name: 'More options', controlType: 'Group', isEnabled: true,
          states: { toggle: 'unsupported', selection: 'unsupported', expandCollapse: 'Collapsed' } };
        value.tree = { ...child, id: 1, parentId: null, automationId: 'outer', controlType: 'Group', isEnabled: true,
          states: { toggle: 'unsupported', selection: 'unsupported', expandCollapse: calls.length >= 4 ? 'Expanded' : 'Collapsed' },
          children: calls.length < 4 || scenario === 'absent' ? [] : scenario === 'ambiguous'
            ? [child, { ...child, id: 3 }] : [inner] };
        value.queryResult!.matches = [value.tree];
        if (calls.length >= 4 && scenario === 'truncated') { value.treeComplete = false; value.truncated = true; value.truncateReason = 'maxDepth'; }
        if (calls.length >= 4 && scenario === 'traversal') { value.treeComplete = false; value.traversalErrors = 1; }
      }
      return result(value);
    }, target, { parentQuery: { automationId: 'outer' }, childQuery: { automationId: 'check' } });
    const diagnostic = checked.report.diagnosis as any;
    const incomplete = ['truncated', 'traversal'].includes(scenario);
    assert.equal(checked.report.status, 'stopped');
    assert.equal(checked.report.findings, undefined);
    assert.equal(checked.report.errorCode, incomplete ? 'INCOMPLETE_OBSERVATION' : 'CHILD_RELATIONSHIP_UNCONFIRMED');
    assert.equal(diagnostic.parentState, 'Expanded');
    assert.equal(diagnostic.localObservation.treeComplete, !incomplete);
    assert.deepEqual(diagnostic.localObservation.query, { automationId: 'outer' });
    assert.equal(diagnostic.localObservation.matchCount, scenario === 'ambiguous' ? 2 : 0);
    assert.equal(diagnostic.localObservation.candidates.length, ['inner', 'truncated', 'traversal'].includes(scenario) ? 1 : 0);
    if (diagnostic.localObservation.candidates.length) {
      const candidate = diagnostic.localObservation.candidates[0];
      assert.equal(candidate.automationId, 'inner'); assert.equal(candidate.parentId, 1);
      assert.equal(candidate.state, 'Collapsed'); assert.equal(candidate.nextRequest, undefined);
    }
    assert.equal(diagnostic.cause, incomplete ? 'local-observation-incomplete' : scenario === 'inner'
      ? 'observed-inner-collapsed-candidates' : scenario === 'ambiguous' ? 'child-ambiguous-in-parent' : 'child-not-found-in-parent');
    assert.notEqual(diagnostic.nextAction, 'Stop. Inspect the actual state before deciding on further work; no automatic action replay.');
    assert.equal(calls.filter(tool => tool === 'wincode_ui_set_expanded').length, 1);
    assert.equal(calls.length, 4);
  }
});

test('navigation retains auxiliary property gaps while proving the parent and actual child state', async () => {
  const calls: string[] = [];
  const checked = await runExpandUiWorkflow(async tool => {
    calls.push(tool);
    const value = observation();
    const child = { ...value.tree!, automationId: 'check', controlType: 'CheckBox', propertyIssues: ['bounds:error'] };
    const parent = { ...value.tree!, automationId: 'advanced', controlType: 'Group', isEnabled: true,
      propertyIssues: ['className:error', 'isOffscreen:unsupported'],
      states: { toggle: 'unsupported', selection: 'unsupported', expandCollapse: calls.length >= 5 ? 'Expanded' : 'Collapsed' } };
    if (calls.length === 1) {
      delete value.tree;
      value.queryResult = { status: 'not-found', searchComplete: true, visitedNodes: 8, matches: [] };
    } else if (calls.length === 2) {
      value.tree = parent; value.propertyIssueCount = 2;
      value.queryResult = { status: 'unique', searchComplete: true, visitedNodes: 8, matches: [parent] };
    } else if (tool === 'wincode_ui_set_expanded') {
      delete value.tree; value.actionTarget = parent;
    } else {
      value.tree = calls.length === 6 ? child : parent;
      if (calls.length === 5) value.tree.children = [child];
      value.propertyIssueCount = calls.length === 6 ? 1 : calls.length === 5 ? 3 : 2;
      value.queryResult!.matches = [value.tree];
    }
    return result(value);
  }, target, { childQuery: { automationId: 'check' } });
  assert.equal(checked.report.success, true, JSON.stringify(checked.report));
  assert.equal(checked.report.diagnosis.relationshipVerified, true);
  assert.equal(checked.report.findings?.state, 'On');
  assert.equal(calls.filter(tool => tool === 'wincode_ui_set_expanded').length, 1);
  assert.equal(calls.length, 6);
  assert.deepEqual(checked.report.steps[2].value.tree?.propertyIssues, ['className:error', 'isOffscreen:unsupported']);
  assert.deepEqual(checked.report.steps[5].value.tree?.propertyIssues, ['bounds:error']);
});

test('auxiliary gaps never override missing required navigation evidence or incomplete searches', async () => {
  for (const scenario of ['identity', 'unclassified-issue', 'unexplained-count', 'enabled', 'disabled', 'search', 'tree', 'state']) {
    const calls: string[] = [];
    const checked = await runExpandUiWorkflow(async tool => {
      calls.push(tool);
      const value = observation();
      value.tree!.propertyIssues = ['className:error']; value.propertyIssueCount = 1;
      value.queryResult!.matches = [value.tree!];
      if (scenario === 'enabled' || scenario === 'disabled') {
        if (calls.length === 1) {
          delete value.tree; value.propertyIssueCount = 0;
          value.queryResult = { status: 'not-found', searchComplete: true, visitedNodes: 8, matches: [] };
        } else {
          value.tree!.automationId = 'advanced'; value.tree!.controlType = 'Group';
          value.tree!.states!.expandCollapse = 'Collapsed';
          if (scenario === 'enabled') {
            delete value.tree!.isEnabled;
            value.tree!.propertyIssues.push('isEnabled:unsupported'); value.propertyIssueCount = 2;
          }
        }
      } else if (scenario === 'identity') { value.tree!.propertyIssues.push('automationId:error'); value.propertyIssueCount = 2; }
      else if (scenario === 'unclassified-issue') { value.tree!.propertyIssues.push('newField:error'); value.propertyIssueCount = 2; }
      else if (scenario === 'unexplained-count') value.propertyIssueCount = 2;
      else if (scenario === 'search') { value.queryResult!.searchComplete = false; value.queryResult!.status = 'incomplete'; }
      else if (scenario === 'tree') { value.treeComplete = false; value.truncated = true; }
      else if (scenario === 'state') value.tree!.states!.toggle = 'unknown';
      return result(value);
    }, target, { ...(scenario === 'enabled' || scenario === 'disabled' ? { parentQuery: { automationId: 'advanced' } } : {}),
      childQuery: { automationId: 'check' } });
    assert.equal(checked.report.success, false, scenario);
    assert.equal(checked.report.errorCode, scenario === 'enabled' ? 'TARGET_EVIDENCE_INCOMPLETE' :
      scenario === 'disabled' ? 'TARGET_DISABLED' : scenario === 'search' ? 'QUERY_INCOMPLETE' :
      scenario === 'state' ? 'STATE_UNAVAILABLE' : 'INCOMPLETE_OBSERVATION', scenario);
    assert.equal(checked.report.actionAttempted, false, scenario);
    assert.equal(checked.report.findings, undefined, scenario);
    assert.ok(calls.every(tool => tool === 'wincode_ui_inspect'), scenario);
  }
});

test('automatic expansion reports multiple or absent candidates without performing an action', async () => {
  for (const count of [0, 2]) {
    const calls: string[] = [];
    const checked = await runExpandUiWorkflow(async (tool, args) => {
      calls.push(tool);
      const value = observation(); delete value.tree;
      const discovery = calls.length === 2;
      if (discovery) assert.deepEqual(args.query, { controlType: 'Group', maxSearchNodes: 1000, maxMatches: 20 });
      value.queryResult = { status: discovery && count ? 'ambiguous' : 'not-found', searchComplete: true,
        visitedNodes: 8, matches: discovery ? Array.from({ length: count }, (_, i) => ({ ...observation().tree!,
          automationId: `group${i}`, controlType: 'Group', isEnabled: true,
          states: { toggle: 'unsupported', selection: 'unsupported', expandCollapse: 'Collapsed' } })) : [] };
      return result(value);
    }, target, { childQuery: { automationId: 'check' } });
    assert.equal(checked.report.errorCode, count ? 'NAVIGATION_CANDIDATE_AMBIGUOUS' : 'NAVIGATION_CANDIDATE_NOT_FOUND');
    assert.equal(checked.report.diagnosis.candidates?.length, count);
    if (count) {
      assert.equal(checked.report.status, 'selection-required');
      assert.equal(checked.isError, false);
      assert.equal(checked.report.success, false);
      assert.deepEqual(checked.report.diagnosis.candidates?.[0].nextRequest, { action: 'expand-ui', target,
        parameters: { childQuery: { automationId: 'check' }, candidateQuery: { controlType: 'Group', automationId: 'group0' } }, timeoutMs: 15000 });
    }
    assert.equal(checked.report.actionAttempted, false);
    assert.deepEqual(calls, ['wincode_ui_inspect', 'wincode_ui_inspect']);
  }
});

test('candidate selection is checked against fresh discovery before any action', async () => {
  for (const scenario of ['disappeared', 'renamed', 'disabled', 'incomplete', 'duplicate']) {
    const calls: string[] = [];
    const checked = await runExpandUiWorkflow(async (tool, args) => {
      calls.push(tool);
      const value = observation(); delete value.tree;
      const group = { ...observation().tree!, automationId: 'speech', name: scenario === 'renamed' ? 'Other' : 'Speech',
        controlType: 'Group', isEnabled: scenario !== 'disabled',
        states: { toggle: 'unsupported', selection: 'unsupported', expandCollapse: 'Collapsed' } };
      const groups = ['disappeared', 'renamed'].includes(scenario) ? [] : scenario === 'duplicate' ? [group, structuredClone(group)] : [group];
      value.queryResult = calls.length === 1 ? { status: 'not-found', searchComplete: true, visitedNodes: 8, matches: [] }
        : { status: scenario === 'incomplete' ? 'incomplete' : groups.length > 1 ? 'ambiguous' : groups.length ? 'unique' : 'not-found',
          searchComplete: scenario !== 'incomplete', visitedNodes: 8, matches: groups };
      if (calls.length > 1) { assert.deepEqual(args.query, { automationId: 'speech', name: 'Speech', controlType: 'Group' }); value.tree = group; }
      return result(value);
    }, target, { childQuery: { automationId: 'check' }, candidateQuery: { automationId: 'speech', name: 'Speech', controlType: 'Group' } });
    assert.equal(checked.report.errorCode, scenario === 'incomplete' ? 'QUERY_INCOMPLETE' : scenario === 'disabled'
      ? 'TARGET_DISABLED' : 'NAVIGATION_SELECTION_STALE', scenario);
    assert.equal(checked.report.actionAttempted, false);
    assert.deepEqual(calls, ['wincode_ui_inspect', 'wincode_ui_inspect']);
  }
});

test('selected navigation preserves failed actions and missing child evidence without replay', async () => {
  for (const scenario of ['action-failed', 'wrong-parent']) {
    const calls: string[] = [];
    const checked = await runExpandUiWorkflow(async tool => {
      calls.push(tool);
      const value = observation();
      const group = { ...value.tree!, automationId: 'speech', controlType: 'Group', isEnabled: true,
        states: { toggle: 'unsupported', selection: 'unsupported', expandCollapse: calls.length >= 4 ? 'Expanded' : 'Collapsed' } };
      if (calls.length === 1) { delete value.tree; value.queryResult = { status: 'not-found', searchComplete: true, visitedNodes: 8, matches: [] }; }
      else { value.tree = group; value.queryResult!.matches = [group]; }
      if (tool === 'wincode_ui_set_expanded' && scenario === 'action-failed') {
        value.success = false; value.errorCode = 'UI_ACTION_FAILED'; value.errorMessage = 'Action outcome unknown.';
      }
      return result(value);
    }, target, { childQuery: { automationId: 'check' }, candidateQuery: { automationId: 'speech', controlType: 'Group' } });
    assert.equal(checked.report.errorCode, scenario === 'action-failed' ? 'UI_ACTION_FAILED' : 'CHILD_RELATIONSHIP_UNCONFIRMED');
    assert.equal(checked.report.actionAttempted, true);
    assert.equal(checked.report.findings, undefined);
    assert.equal(calls.filter(tool => tool === 'wincode_ui_set_expanded').length, 1);
    assert.equal(calls.length, scenario === 'action-failed' ? 3 : 4);
  }
});

test('automatic expansion never infers a unique candidate from incomplete or unaddressable evidence', async () => {
  for (const scenario of ['search-limit', 'unknown-state', 'unknown-enabled', 'property-issue', 'no-identity']) {
    const calls: string[] = [];
    const checked = await runExpandUiWorkflow(async tool => {
      calls.push(tool);
      const value = observation(); delete value.tree;
      const group = { ...observation().tree!, controlType: 'Group', isEnabled: true,
        states: { toggle: 'unsupported', selection: 'unsupported', expandCollapse: 'Collapsed' } };
      if (scenario === 'unknown-state') group.states.expandCollapse = 'unknown';
      if (scenario === 'unknown-enabled') delete (group as { isEnabled?: boolean }).isEnabled;
      if (scenario === 'property-issue') group.propertyIssues = ['Name'];
      if (scenario === 'no-identity') delete group.automationId;
      value.queryResult = calls.length === 1
        ? { status: 'not-found', searchComplete: true, visitedNodes: 8, matches: [] }
        : { status: scenario === 'search-limit' ? 'incomplete' : 'unique', searchComplete: scenario !== 'search-limit',
          visitedNodes: 8, matches: [group] };
      return result(value);
    }, target, { childQuery: { automationId: 'check' } });
    assert.equal(checked.report.errorCode, scenario === 'no-identity' ? 'NAVIGATION_CANDIDATE_UNADDRESSABLE' : 'NAVIGATION_DISCOVERY_INCOMPLETE', scenario);
    assert.equal(checked.report.actionAttempted, false);
    assert.deepEqual(calls, ['wincode_ui_inspect', 'wincode_ui_inspect']);
  }
});

test('recipe input errors identify the legal field and correction without echoing rejected values', () => {
  const valid = { regionAutomationId: 'region', checkboxAutomationIds: ['a', 'b'] };
  for (const [recipe, parameters, code, field] of [
    ['synthetic-private-recipe', valid, 'UNSUPPORTED_RECIPE', 'recipe'],
    ['checkbox-audit', { ...valid, checkboxAutomationIds: [] }, 'INVALID_RECIPE_PARAMETERS', 'checkboxAutomationIds'],
    ['checkbox-audit', { ...valid, checkboxAutomationIds: ['a', 'a'] }, 'INVALID_RECIPE_PARAMETERS', 'checkboxAutomationIds'],
    ['checkbox-audit', { ...valid, maxNodes: -1 }, 'INVALID_RECIPE_PARAMETERS', 'maxNodes'],
    ['checkbox-audit', { ...valid, regionAutomationId: 'synthetic-private-id\n' }, 'INVALID_RECIPE_PARAMETERS', 'regionAutomationId'],
    ['checkbox-audit', { ...valid, 'synthetic-private-key': 'synthetic-private-value' }, 'INVALID_RECIPE_PARAMETERS', 'parameters'],
  ] as const) {
    assert.throws(() => createReadonlyUiRecipe(recipe, parameters), (error: any) => {
      assert.equal(error.code, code); assert.equal(error.field, field);
      assert.equal(error.recoveryAction, 'revise_parameters');
      assert.equal(error.workStarted, false); assert.ok(error.message.length);
      assert.equal(JSON.stringify(error).includes('synthetic-private'), false);
      assert.equal(error.message.includes('synthetic-private'), false); return true;
    });
  }
  assert.equal(typeof createReadonlyUiRecipe('checkbox-audit', valid), 'function');
});

test('installed checkbox recipe branches on observed states and rejects ambiguous or incomplete selections', async () => {
  const parameters = { summaryAutomationId: 'summary', regionAutomationId: 'region', checkboxAutomationIds: ['a', 'b'] };
  const selected = [
    { id: 2, parentId: 1, automationId: 'a', controlType: 'CheckBox', isEnabled: false,
      states: { toggle: 'On', selection: 'unsupported', expandCollapse: 'unsupported' }, children: [] },
    { id: 3, parentId: 1, automationId: 'b', controlType: 'CheckBox', isEnabled: true,
      states: { toggle: 'Off', selection: 'unsupported', expandCollapse: 'unsupported' }, children: [] },
  ];
  for (const scenario of ['on', 'off', 'unknown', 'missing', 'duplicate', 'wrong-type', 'unknown-checkbox', 'unknown-enabled']) {
    const calls: string[] = [];
    const call: UiReadCaller = async (_name, args) => {
      const id = (args.query as { automationId: string }).automationId; calls.push(id);
      const value = observation(); value.tree!.automationId = id;
      if (id === 'summary') value.tree!.states!.toggle = scenario === 'off' ? 'Off' : scenario === 'unknown' ? 'unknown' : 'On';
      else {
        value.tree!.children = structuredClone(selected);
        if (scenario === 'missing') value.tree!.children.pop();
        if (scenario === 'duplicate') value.tree!.children.push(structuredClone(selected[0]));
        if (scenario === 'wrong-type') value.tree!.children[0].controlType = 'Text';
        if (scenario === 'unknown-checkbox') value.tree!.children[0].states!.toggle = 'Indeterminate';
        if (scenario === 'unknown-enabled') delete value.tree!.children[0].isEnabled;
      }
      return result(value);
    };
    const checked = await runReadonlyUiWorkflow(call, target, createReadonlyUiRecipe('checkbox-audit', parameters));
    assert.deepEqual(calls, scenario === 'off' || scenario === 'unknown' ? ['summary'] : ['summary', 'region']);
    assert.equal(checked.report.success, scenario === 'on' || scenario === 'off');
    if (scenario === 'on') assert.deepEqual(checked.report.findings,
      { detailsRequired: true, details: { checkedCount: 1, unchecked: ['b'], disabled: ['a'] } });
    if (scenario === 'off') assert.deepEqual(checked.report.findings, { detailsRequired: false });
    if (!checked.report.success) assert.equal(checked.report.findings, undefined);
  }
  const session = createReadonlyUiRecipe('checkbox-audit', { ...parameters, summaryAutomationId: undefined });
  const unconditional = await runReadonlyUiWorkflow(async () => result({ ...observation(),
    tree: { ...observation().tree!, automationId: 'region', children: selected } }), target, session);
  assert.deepEqual(unconditional.report.findings, { checkedCount: 1, unchecked: ['b'], disabled: ['a'] });
});

test('checkbox audit retains auxiliary gaps without rejecting known states or weakening default readers', async () => {
  for (const scenario of ['on', 'off', 'unconditional']) {
    const calls: string[] = [];
    const call: UiReadCaller = async (_tool, args) => {
      assert.equal('allowAuxiliaryPropertyGaps' in args, false, 'client policy must not reach MCP');
      const id = (args.query as { automationId: string }).automationId; calls.push(id);
      const value = observation();
      value.tree = { ...value.tree!, automationId: id, controlType: 'CheckBox',
        propertyIssues: ['className:error'], children: id === 'region' ? [
          { ...observation().tree!, id: 2, parentId: 1, automationId: 'a', controlType: 'CheckBox', propertyIssues: ['bounds:error'] },
          { ...observation().tree!, id: 3, parentId: 1, automationId: 'b', controlType: 'CheckBox', isEnabled: true,
            propertyIssues: ['isOffscreen:unsupported'], states: { toggle: 'Off', selection: 'unsupported', expandCollapse: 'unsupported' } },
        ] : [] };
      value.tree.states!.toggle = scenario === 'off' ? 'Off' : 'On';
      value.propertyIssueCount = id === 'region' ? 3 : 1;
      return result(value);
    };
    const checked = await runReadonlyUiWorkflow(call, target, createReadonlyUiRecipe('checkbox-audit', {
      ...(scenario !== 'unconditional' ? { summaryAutomationId: 'summary' } : {}),
      regionAutomationId: 'region', checkboxAutomationIds: ['a', 'b'],
    }));
    assert.equal(checked.report.success, true, JSON.stringify(checked.report));
    const details = { checkedCount: 1, unchecked: ['b'], disabled: ['a'] };
    assert.deepEqual(checked.report.findings, scenario === 'off' ? { detailsRequired: false } :
      scenario === 'on' ? { detailsRequired: true, details } : details);
    assert.deepEqual(calls, scenario === 'off' ? ['summary'] : scenario === 'on' ? ['summary', 'region'] : ['region']);
    assert.equal(checked.report.steps.at(-1)!.evidence!.propertyIssueCount, scenario === 'off' ? 1 : 3);
    const nodes = checked.report.steps.at(-1)!.evidence!.nodes as Array<{ propertyIssues: string[] }>;
    assert.deepEqual(nodes[0].propertyIssues, ['className:error']);
    if (scenario !== 'off') assert.deepEqual(nodes.slice(1).map(node => node.propertyIssues), [['bounds:error'], ['isOffscreen:unsupported']]);
    const strict = await runReadonlyUiWorkflow(call, target, reader => reader.inspect({ query: { automationId: 'summary' }, readStates: true }));
    assert.equal(strict.report.errorCode, 'INCOMPLETE_OBSERVATION');
  }
});

test('checkbox audit still rejects required property gaps, incomplete coverage and unknown selected states', async () => {
  for (const scenario of ['identity', 'enabled', 'unknown-property', 'unexplained-count', 'truncated', 'traversal', 'search',
    'ambiguous', 'drift', 'unknown-toggle', 'missing', 'duplicate']) {
    let calls = 0;
    const checked = await runReadonlyUiWorkflow(async () => {
      calls++;
      const value = observation();
      const check = { ...value.tree!, id: 2, parentId: 1, automationId: 'a', controlType: 'CheckBox', propertyIssues: ['className:error'] };
      value.tree = { ...value.tree!, automationId: 'region', children: [check] }; value.propertyIssueCount = 1;
      if (scenario === 'identity') check.propertyIssues.push('automationId:error');
      if (scenario === 'enabled') check.propertyIssues.push('isEnabled:error');
      if (scenario === 'unknown-property') check.propertyIssues.push('newField:error');
      if (scenario === 'unexplained-count') value.propertyIssueCount = 2;
      if (scenario === 'truncated') { value.truncated = true; value.treeComplete = false; }
      if (scenario === 'traversal') value.traversalErrors = 1;
      if (scenario === 'search') value.queryResult!.searchComplete = false;
      if (scenario === 'ambiguous') value.queryResult!.status = 'ambiguous';
      if (scenario === 'drift') value.pid = 99;
      if (scenario === 'unknown-toggle') check.states = { ...check.states!, toggle: 'unknown' };
      if (scenario === 'missing') { value.tree.children = []; value.propertyIssueCount = 0; }
      if (scenario === 'duplicate') { value.tree.children.push(structuredClone(check)); value.propertyIssueCount = 2; }
      return result(value);
    }, target, createReadonlyUiRecipe('checkbox-audit', { regionAutomationId: 'region', checkboxAutomationIds: ['a'] }));
    assert.equal(checked.report.success, false, scenario); assert.equal(checked.report.findings, undefined, scenario);
    assert.equal(calls, 1, scenario);
    assert.equal(checked.report.errorCode, scenario === 'ambiguous' ? 'QUERY_AMBIGUOUS' : scenario === 'drift' ? 'TARGET_CHANGED' :
      ['unknown-toggle', 'missing', 'duplicate'].includes(scenario) ? 'WORKFLOW_ERROR' : 'INCOMPLETE_OBSERVATION', scenario);
  }
});

function namedCheckboxRegion(): UiInspectResult {
  return { ...observation(), tree: { id: 1, parentId: null, automationId: 'region', name: 'Settings',
    propertyIssues: ['controlType:unsupported'], children: [
      { id: 2, parentId: 1, name: 'Clock', controlType: 'Text', propertyIssues: ['automationId:unsupported'], children: [] },
      { id: 3, parentId: 1, name: 'Clock', controlType: 'CheckBox', isEnabled: true,
        states: { toggle: 'Off', selection: 'unsupported', expandCollapse: 'unsupported' }, propertyIssues: ['automationId:unsupported', 'className:unsupported'], children: [] },
      { id: 4, parentId: 1, name: 'Scale', controlType: 'CheckBox', isEnabled: false,
        states: { toggle: 'On', selection: 'unsupported', expandCollapse: 'unsupported' }, propertyIssues: ['automationId:unsupported'], children: [] },
      { id: 5, parentId: 1, name: 'Unrelated', controlType: 'Button', propertyIssues: ['isEnabled:unsupported'], children: [] },
    ] } };
}
const namedCheckboxParameters = { regionAutomationId: 'region', checkboxSelectors: [
  { name: 'Clock', controlType: 'CheckBox' }, { name: 'Scale', controlType: 'CheckBox' },
] };

test('named checkbox audit reads ID-less controls, preserves evidence and keeps conditional and legacy readers bounded', async () => {
  for (const mode of ['unconditional', 'on', 'off']) {
    const calls: string[] = [];
    const checked = await runReadonlyUiWorkflow(async (_tool, args) => {
      const id = (args.query as any).automationId; calls.push(id);
      if (id === 'summary') return result({ ...observation(), tree: { ...observation().tree!, automationId: 'summary',
        states: { toggle: mode === 'off' ? 'Off' : 'On', selection: 'unsupported', expandCollapse: 'unsupported' } } });
      return result(namedCheckboxRegion());
    }, target, createReadonlyUiRecipe('checkbox-audit', { ...namedCheckboxParameters,
      ...(mode === 'unconditional' ? {} : { summaryAutomationId: 'summary' }) }));
    const details = { checkedCount: 1, unchecked: [{ name: 'Clock', controlType: 'CheckBox' }],
      disabled: [{ name: 'Scale', controlType: 'CheckBox' }] };
    assert.equal(checked.report.success, true, JSON.stringify(checked.report));
    assert.deepEqual(checked.report.findings, mode === 'off' ? { detailsRequired: false } :
      mode === 'on' ? { detailsRequired: true, details } : details);
    assert.deepEqual(calls, mode === 'off' ? ['summary'] : mode === 'on' ? ['summary', 'region'] : ['region']);
    if (mode !== 'off') assert.deepEqual((checked.report.steps.at(-1)!.evidence!.nodes as any[])[2].propertyIssues,
      ['automationId:unsupported', 'className:unsupported']);
  }
  const strict = await runReadonlyUiWorkflow(async () => result(namedCheckboxRegion()), target, r => r.inspect({}));
  assert.equal(strict.report.errorCode, 'INCOMPLETE_OBSERVATION');
});

test('named checkbox audit refuses hidden ambiguity, required state gaps and incomplete scope evidence', async () => {
  for (const scenario of ['duplicate', 'missing', 'unknown-name', 'unknown-type', 'name-error', 'enabled-error',
    'unknown-toggle', 'unknown-issue', 'region-id-error', 'unexplained-count', 'truncated', 'search', 'scope']) {
    const value = namedCheckboxRegion(), rows = value.tree!.children;
    if (scenario === 'duplicate') rows.push(structuredClone(rows[1]));
    if (scenario === 'missing') rows.splice(1, 1);
    if (scenario === 'unknown-name') rows.push({ id: 9, parentId: 1, controlType: 'CheckBox', propertyIssues: ['name:unsupported'], children: [] });
    if (scenario === 'unknown-type') rows.push({ id: 9, parentId: 1, name: 'Clock', propertyIssues: ['controlType:unsupported'], children: [] });
    if (scenario === 'name-error') rows[1].propertyIssues!.push('name:error');
    if (scenario === 'enabled-error') rows[1].propertyIssues!.push('isEnabled:error');
    if (scenario === 'unknown-toggle') rows[1].states!.toggle = 'unknown';
    if (scenario === 'unknown-issue') rows[3].propertyIssues!.push('futureField:error');
    if (scenario === 'region-id-error') value.tree!.propertyIssues!.push('automationId:error');
    if (scenario === 'unexplained-count') value.propertyIssueCount = 100;
    if (scenario === 'truncated') { value.treeComplete = false; value.truncated = true; }
    if (scenario === 'search') value.queryResult!.searchComplete = false;
    const checked = await runReadonlyUiWorkflow(async () => result(value), target, createReadonlyUiRecipe('checkbox-audit', {
      ...namedCheckboxParameters, ...(scenario === 'scope' ? { scopePath: [{ name: 'Settings' }] } : {}),
    }));
    assert.equal(checked.report.success, false, scenario);
    assert.equal(checked.report.findings, undefined, scenario);
    assert.equal(checked.report.steps.length, 1, scenario);
    assert.ok(checked.report.steps[0].evidence, scenario);
  }
});

test('named checkbox selectors reject mixed, duplicate and nonexact inputs before reading', () => {
  for (const extra of [ { checkboxAutomationIds: ['a'] }, { checkboxSelectors: [] },
    { checkboxSelectors: [{ name: 'Clock', controlType: 'Button' }] },
    { checkboxSelectors: [{ name: 'Clock' }] },
    { checkboxSelectors: [{ name: 'Clock', controlType: 'CheckBox', automationId: 'a' }] },
    { checkboxSelectors: [namedCheckboxParameters.checkboxSelectors[0], namedCheckboxParameters.checkboxSelectors[0]] },
    { checkboxSelectors: [{ name: 'private\n', controlType: 'CheckBox' }] } ]) {
    assert.throws(() => createReadonlyUiRecipe('checkbox-audit', { ...namedCheckboxParameters, ...extra }),
      (e: any) => e.code === 'INVALID_RECIPE_PARAMETERS' && e.workStarted === false);
  }
});

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

test('cancellation and input/step/data/output budgets prevent further dispatch without automatic retry', async context => {
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
  let clock = Date.now();
  const mockedNow = context.mock.method(Date, 'now', () => clock);
  try {
    const raced = await runReadonlyUiWorkflow(async () => {
      clock += 1000; throw new Error('Request timed out');
    }, target, async reader => { await Promise.all([reader.inspect({}), reader.inspect({})]); }, { timeoutMs: 1000 });
    assert.equal(raced.report.errorCode, 'DEADLINE_EXCEEDED');
    assert.equal(raced.report.metrics.dispatchedCalls, 1);
    assert.deepEqual(raced.report.steps.map(step => step.status), ['failed', 'not_started']);
  } finally { mockedNow.mock.restore(); }
});
