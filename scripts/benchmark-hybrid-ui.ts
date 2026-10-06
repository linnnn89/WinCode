/** Live, disposable Windows fixture. This measures client orchestration, not an LLM or native UIA parallelism. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { WinCodeSession } from '../src/Client/SkillSession.js';
import { runReadonlyUiWorkflow, type UiReader, type UiTarget } from '../src/Client/ReadonlyUiWorkflow.js';
import { createReadonlyUiRecipe } from '../src/Client/ReadonlyUiRecipes.js';
import type { UiNode } from '../src/Core/UiContracts.js';
import type { UiReviewResult } from '../src/CompositeTools/UiReview.js';
import { killProcessTree, withTimeout } from '../src/Core/ResourceManager.js';
import { FlaUiAdapter } from '../src/Adapters/FlaUiAdapter.js';
import { getDefaultConfig } from '../src/Core/Config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32') throw new Error('Hybrid UI benchmark requires Windows.');
const repetitions = Number(process.argv[2] ?? 20);
if (process.argv.length > 3 || !Number.isInteger(repetitions) || repetitions < 1 || repetitions > 100)
  throw new Error('Usage: npm run benchmark:hybrid -- [1–100 repetitions; default 20]');
const output = path.join(root, 'test-tmp', 'hybrid-ui-' + Date.now());
await fs.mkdir(output, { recursive: true });
const session = new WinCodeSession({ workspace: root });
const fixtures: ChildProcess[] = [];
const fixtureExits = new Map<ChildProcess, Promise<void>>();
const verifiedFixtureExits = new Set<ChildProcess>();
const foreground: string[] = [];
const samples: Array<{ task: string; mode: string; repeat: number; elapsedMs: number; calls: number;
  intermediateTextBytes: number; deliveredTextBytes: number; scriptedObservationBatches: number; findings: unknown }> = [];
const faults: Array<{ name: string; success: boolean; errorCode?: string; dispatchedCalls: number; helperExited: boolean }> = [];
let failure: string | undefined;
let discovery: unknown;
let connectMs = 0;
let gatewayExited = false;
let schemaBytes = 0;
let runtime: unknown;
const auditPath = path.join(process.env.LOCALAPPDATA!, 'WinCode', 'logs', 'ui-audit', 'access.jsonl');
const auditBefore = await fs.readFile(auditPath, 'utf8').catch(() => '');
const fixturePids = new Set<number>();
const parse = (response: Awaited<ReturnType<WinCodeSession['call']>>) => {
  const text = response.content.find(block => block.type === 'text');
  assert.ok(text?.type === 'text', 'expected JSON text');
  return { value: JSON.parse(text.text), bytes: Buffer.byteLength(text.text) };
};

async function startFixture(extra: string[] = [], env: NodeJS.ProcessEnv = process.env) {
  const fixture = spawn(path.join(root, 'tests/fixtures/wpf-ui-review/bin/Release/net10.0-windows/win-x64/publish/wpf-ui-review.exe'),
    ['--background-fixture', '--hybrid-fixture', '--auto-close=600000', ...extra],
    { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  fixtures.push(fixture);
  fixtureExits.set(fixture, new Promise(resolve => fixture.once('close', () => resolve())));
  let stderr = '';
  let stateChanged = false;
  fixture.stderr!.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2048); });
  const target = await new Promise<UiTarget>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Fixture readiness timeout: ' + stderr)), 10000);
    let buffer = '';
    fixture.stdout!.on('data', chunk => {
      buffer += chunk.toString();
      let boundary: number;
      while ((boundary = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, boundary).trim(); buffer = buffer.slice(boundary + 1);
        if (line.startsWith('FOREGROUND ')) foreground.push(line);
        if (line === 'STATE_CHANGED') stateChanged = true;
        const match = line.match(/^READY (\d+) (0x[\dA-F]+)$/);
        if (match) { clearTimeout(timer); resolve({ pid: Number(match[1]), hwnd: match[2] }); }
      }
    });
    fixture.once('error', error => { clearTimeout(timer); reject(error); });
    fixture.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${stderr}`)); });
  });
  fixturePids.add(target.pid);
  return { fixture, target, stateChanged: () => stateChanged };
}

async function stopFixture(fixture: ChildProcess) {
  await killProcessTree(fixture);
  await withTimeout(fixtureExits.get(fixture)!, 5000, 'Benchmark fixture close');
  if (fixture.pid) assert.throws(() => process.kill(fixture.pid!, 0), { code: 'ESRCH' });
  verifiedFixtureExits.add(fixture);
}

function nodes(value: UiReviewResult): UiNode[] {
  const found: UiNode[] = [];
  const visit = (node: UiNode) => { found.push(node); node.children.forEach(visit); };
  if (value.tree) visit(value.tree);
  return found;
}
const summaryOptions = { query: { automationId: 'hybridSummary' }, readStates: true, maxDepth: 2, maxNodes: 8 };
const checksOptions = { query: { automationId: 'hybridChecks' }, readStates: true, maxDepth: 4, maxNodes: 40 };
const checkboxParameters = { regionAutomationId: 'hybridChecks',
  checkboxAutomationIds: Array.from({ length: 8 }, (_, i) => 'hybridCheck' + i), maxDepth: 4, maxNodes: 40 };
const tasks: Array<{ id: string; batches: number; run: (reader: UiReader) => Promise<unknown>; expected: unknown }> = [
  { id: 'T1', batches: 1, run: async reader => {
    const state = (await reader.inspect(summaryOptions)).tree?.states?.toggle;
    assert.ok(state === 'On' || state === 'Off', 'unknown state is not false');
    return { detailsRequired: state === 'On' };
  },
    expected: { detailsRequired: true } },
  // Native baseline already reads the common parent once, rather than issuing eight redundant queries.
  { id: 'T2', batches: 1, run: createReadonlyUiRecipe('checkbox-audit', checkboxParameters),
    expected: { checkedCount: 7, unchecked: ['hybridCheck3'], disabled: ['hybridCheck6'] } },
  { id: 'T3', batches: 2, run: createReadonlyUiRecipe('checkbox-audit', { ...checkboxParameters, summaryAutomationId: 'hybridSummary' }),
    expected: { detailsRequired: true, details: { checkedCount: 7, unchecked: ['hybridCheck3'], disabled: ['hybridCheck6'] } } },
  { id: 'T4', batches: 1, run: async reader => {
    const value = await reader.review({ query: { automationId: 'btnNormalAction' }, maxDepth: 2, maxNodes: 8,
      candidateFiles: ['tests/fixtures/wpf-ui-review/MainWindow.xaml'] });
    return { disabled: value.tree?.isEnabled === false, sourceCandidates: value.sourceEvidence?.nodes.flatMap(node =>
      node.candidates.map(candidate => ({ file: candidate.file, automationId: candidate.automationId }))),
      runtimeSourceVerified: value.sourceEvidence?.runtimeSourceVerified };
  }, expected: { disabled: true, sourceCandidates: [{ file: 'tests/fixtures/wpf-ui-review/MainWindow.xaml', automationId: 'btnNormalAction' }], runtimeSourceVerified: false } },
];

async function health() { return parse(await session.call('wincode_hello_world')).value.health; }
async function assertHelperExited(pid?: number | null) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const status = await health();
    if (status.flaui.runtime.activePid === null && !status.flaui.runtime.isRunning && status.inFlightRequests === 0) {
      if (pid) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Helper cleanup did not finish within five seconds.');
}

try {
  const { target } = await startFixture();
  const connectStarted = performance.now();
  const hello = parse(await session.call('wincode_hello_world')).value;
  connectMs = performance.now() - connectStarted;
  runtime = hello.runtime;
  const listed = parse(await session.call('wincode_ui_list_windows', { pid: target.pid, maxWindows: 8 })).value;
  assert.equal(listed.success, true);
  assert.ok(listed.windows.some((window: UiTarget) => window.pid === target.pid && BigInt(window.hwnd) === BigInt(target.hwnd)));
  discovery = { target, enumerationComplete: listed.enumerationComplete };
  const { WINCODE_TOOLS } = await import('../src/Gateway/ToolRegistry.js');
  schemaBytes = Buffer.byteLength(JSON.stringify(WINCODE_TOOLS));

  for (let repeat = 0; repeat < repetitions; repeat++) {
    for (const task of tasks) {
      for (const mode of repeat % 2 ? ['hybrid', 'native'] : ['native', 'hybrid']) {
        const start = performance.now();
        let calls = 0, intermediateTextBytes = 0, deliveredTextBytes = 0;
        const call: Parameters<typeof runReadonlyUiWorkflow>[0] = async (name, args, options) => {
          calls++;
          const response = await session.call(name, args, options);
          intermediateTextBytes += response.content.filter(block => block.type === 'text').reduce((sum, block) => sum + Buffer.byteLength(block.text), 0);
          return response;
        };
        let findings: unknown;
        if (mode === 'hybrid') {
          const result = await runReadonlyUiWorkflow(call, target, task.run);
          assert.equal(result.isError, false, result.content[0].text);
          findings = result.report.findings;
          deliveredTextBytes = Buffer.byteLength(result.content[0].text);
        } else {
          const read = async (name: string, args: Record<string, unknown>) => {
            const response = await call(name, { ...args, ...target, backgroundOnly: true, capture: 'none', responseFormat: 'compact' },
              { signal: AbortSignal.timeout(15000), timeoutMs: 15000 });
            const parsed = parse(response);
            assert.equal(response.isError ?? false, false);
            assert.equal(parsed.value.success, true);
            assert.equal(parsed.value.treeComplete, true);
            deliveredTextBytes += parsed.bytes;
            return parsed.value;
          };
          findings = await task.run({ inspect: args => read('wincode_ui_inspect', args), review: args => read('wincode_ui_review', args) });
        }
        assert.deepEqual(findings, task.expected);
        samples.push({ task: task.id, mode, repeat, elapsedMs: performance.now() - start, calls, intermediateTextBytes,
          deliveredTextBytes, scriptedObservationBatches: mode === 'hybrid' ? 1 : task.batches, findings });
      }
    }
    console.log(`[hybrid-ui] ${repeat + 1}/${repetitions}: T1–T4 native/hybrid verified`);
  }

  for (const [name, query, expected] of [
    ['selector-ambiguity', { automationId: 'hybridDuplicate' }, 'QUERY_AMBIGUOUS'],
    ['incomplete-query', { automationId: 'hybridChecks', maxSearchNodes: 1 }, 'QUERY_INCOMPLETE'],
  ] as const) {
    const result = await runReadonlyUiWorkflow(session.call.bind(session), target, async reader => {
      await reader.inspect(summaryOptions); await reader.inspect({ query }); await reader.inspect(checksOptions);
    });
    assert.equal(result.report.errorCode, expected);
    assert.equal(result.report.steps[0].status, 'completed');
    assert.equal(result.report.metrics.dispatchedCalls, 2);
    faults.push({ name, success: true, errorCode: result.report.errorCode, dispatchedCalls: 2, helperExited: await assertHelperExited() });
  }

  const changeFile = path.join(output, 'change-state');
  const changed = await startFixture(['--hybrid-state-file=' + changeFile]);
  await fs.writeFile(changeFile, 'change');
  const changeDeadline = Date.now() + 2000;
  while (!changed.stateChanged() && Date.now() < changeDeadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(changed.stateChanged(), 'fixture must acknowledge its real state change');
  const changedResult = await runReadonlyUiWorkflow(session.call.bind(session), changed.target, tasks[2].run);
  assert.equal(changedResult.isError, false, changedResult.content[0].text);
  assert.deepEqual(changedResult.report.findings, { detailsRequired: false });
  assert.equal(changedResult.report.metrics.dispatchedCalls, 1);
  faults.push({ name: 'changed-control-state', success: true, dispatchedCalls: 1, helperExited: await assertHelperExited() });
  await stopFixture(changed.fixture);

  const image = await runReadonlyUiWorkflow(session.call.bind(session), target,
    reader => reader.inspect({ ...summaryOptions, capture: 'original' }));
  assert.equal(image.isError, false, image.content[0].text);
  const block = image.content.find(item => item.type === 'image');
  assert.ok(block?.type === 'image');
  await fs.writeFile(path.join(output, 'fixture.png'), Buffer.from(block.data, 'base64'));
  await fs.writeFile(path.join(output, 'image-observation.json'), image.content[0].text);

  // Both cases wait for the real target UIA provider to enter before interrupting it.
  for (const mode of ['client-cancel', 'deadline'] as const) {
    const marker = path.join(output, mode + '-entered');
    const held = await startFixture([], { ...process.env, WINCODE_TEST_UI_HOLD_MARKER: marker });
    await fs.writeFile(marker + '.armed', 'armed');
    const controller = new AbortController();
    const pending = runReadonlyUiWorkflow(session.call.bind(session), held.target, async reader => {
      await reader.inspect({}); await reader.inspect(checksOptions);
    }, { timeoutMs: 4000, signal: controller.signal });
    const enteredDeadline = Date.now() + 3000;
    while (!(await fs.stat(marker).catch(() => null)) && Date.now() < enteredDeadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(await fs.stat(marker).catch(() => null), 'real provider must enter before fault injection');
    const helperPid = (await health()).flaui.runtime.activePid;
    assert.ok(helperPid);
    if (mode === 'client-cancel') controller.abort();
    const result = await pending;
    // Preserve the actual failure before asserting; timer ordering must be diagnosable from the record.
    await fs.writeFile(path.join(output, mode + '-observation.json'), result.content[0].text);
    assert.equal(result.isError, true);
    assert.equal(result.report.errorCode, mode === 'client-cancel' ? 'CANCELLED' : 'DEADLINE_EXCEEDED');
    assert.equal(result.report.metrics.dispatchedCalls, 1);
    faults.push({ name: mode, success: true, errorCode: result.report.errorCode, dispatchedCalls: 1, helperExited: await assertHelperExited(helperPid) });
    await fs.writeFile(marker + '.release', 'release');
    await stopFixture(held.fixture);
  }

  const marker = path.join(output, 'helper-timeout-entered');
  const timed = await startFixture([], { ...process.env, WINCODE_TEST_UI_HOLD_MARKER: marker });
  await fs.writeFile(marker + '.armed', 'armed');
  const adapter = new FlaUiAdapter(getDefaultConfig(root));
  try {
    const pending = adapter.inspect({ ...timed.target, backgroundOnly: true, timeoutMs: 4000 });
    const enterDeadline = Date.now() + 3000;
    while (!(await fs.stat(marker).catch(() => null)) && Date.now() < enterDeadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(await fs.stat(marker).catch(() => null));
    const helperPid = adapter.getRuntimeStatus().activePid;
    assert.ok(helperPid);
    const result = await pending;
    assert.equal(result.errorCode, 'TIMEOUT');
    assert.equal(adapter.isRunning, false);
    assert.throws(() => process.kill(helperPid, 0), { code: 'ESRCH' });
    faults.push({ name: 'native-helper-timeout', success: true, errorCode: result.errorCode, dispatchedCalls: 1, helperExited: true });
  } finally { await adapter.dispose(); await fs.writeFile(marker + '.release', 'release'); await stopFixture(timed.fixture); }

  const closed = await startFixture();
  await stopFixture(closed.fixture);
  const gone = await runReadonlyUiWorkflow(session.call.bind(session), closed.target, async reader => {
    await reader.inspect(summaryOptions); await reader.inspect(checksOptions);
  });
  assert.equal(gone.isError, true);
  assert.equal(gone.report.metrics.dispatchedCalls, 1);
  faults.push({ name: 'closed-window', success: true, errorCode: gone.report.errorCode, dispatchedCalls: 1, helperExited: await assertHelperExited() });
  process.kill(target.pid, 0);
} catch (error) { failure = error instanceof Error ? error.stack : String(error); process.exitCode = 1; }
finally {
  const gatewayPid = session.status.pid;
  try { await session.close(); if (gatewayPid) assert.throws(() => process.kill(gatewayPid, 0), { code: 'ESRCH' }); gatewayExited = true; }
  catch (error) { failure ??= String(error); process.exitCode = 1; }
  for (const fixture of fixtures) await stopFixture(fixture).catch(error => { failure ??= String(error); process.exitCode = 1; });
  const auditAfter = await fs.readFile(auditPath, 'utf8').catch(() => '');
  let auditStarts: number | null = null;
  try {
    if (auditAfter.startsWith(auditBefore)) auditStarts = auditAfter.slice(auditBefore.length).trim().split('\n').filter(Boolean)
      .map(line => JSON.parse(line)).filter(line => line.phase === 'start' && fixturePids.has(line.target)).length;
  } catch { /* Concurrent/incomplete audit data cannot establish a helper-start count. */ }
  const percentile = (values: number[], fraction: number) => values.sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)];
  const comparisons = tasks.map(task => {
    const statistics = (mode: string) => {
      const rows = samples.filter(row => row.task === task.id && row.mode === mode);
      return { samples: rows.length, p50Ms: percentile(rows.map(row => row.elapsedMs), .5) ?? null,
        p95Ms: percentile(rows.map(row => row.elapsedMs), .95) ?? null,
        calls: rows[0]?.calls ?? null, deliveredTextBytes: rows.length ? rows.reduce((sum, row) => sum + row.deliveredTextBytes, 0) / rows.length : null,
        scriptedObservationBatches: rows[0]?.scriptedObservationBatches ?? null };
    };
    const native = statistics('native'), hybrid = statistics('hybrid');
    return { task: task.id, native, hybrid, textByteReduction: native.deliveredTextBytes && hybrid.deliveredTextBytes ?
      1 - hybrid.deliveredTextBytes / native.deliveredTextBytes : null };
  });
  let revision: string | null = null;
  try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(); } catch {}
  const report = { formatVersion: 1, branch: 'codex/hybrid-readonly-orchestration', revision, repetitions,
    success: !failure, failure, plannedSamples: repetitions * tasks.length * 2, completedSamples: samples.length,
    runtime, discovery, coldConnectionMs: connectMs, schemaJsonBytes: schemaBytes,
    measuredModelTokens: null, measuredModelDecisionRounds: null, measuredModelLatencyMs: null,
    samples, comparisons, faults, observedAuditHelperStarts: auditStarts, gatewayExited,
    ownedFixturePids: [...fixturePids], fixtureProcessesExited: fixtures.every(fixture => verifiedFixtureExits.has(fixture)),
    foregroundSamples: foreground.length, fixtureForegroundObserved: foreground.some(line => fixturePids.has(Number(line.split(' ')[1]))),
    decision: 'Client-only PoC; model token/latency evidence is still required before proposing server batch.',
    limitations: ['No LLM was invoked: scripted observation batches are not measured model turns.',
      'Elapsed time covers tool execution and local projection, excluding model inference and generated-code costs.',
      'One Gateway connection; all UIA calls are serial. First native task includes a cold helper path; results are not a cold-start study.',
      'Audit starts are observed for owned fixture PIDs, not attributed to individual benchmark samples.',
      'Foreground sampling cannot prove that no brief foreground change occurred.'] };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ output, success: report.success, failure, comparisons, faults, observedAuditHelperStarts: auditStarts, gatewayExited }, null, 2));
}
