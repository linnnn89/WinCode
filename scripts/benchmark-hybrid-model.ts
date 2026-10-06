/** Real inference against a disposable fixture; hybrid means preinstalled client recipes, not generated code. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { WinCodeSession } from '../src/Client/SkillSession.js';
import { killProcessTree, withTimeout } from '../src/Core/ResourceManager.js';
import type { UiTarget } from '../src/Client/ReadonlyUiWorkflow.js';
import { httpCompletion, modelTasks, modelTools, runModelUiTask } from './lib/hybrid-model.js';

const root = path.resolve(import.meta.dirname, '..');
const repetitions = Number(process.argv[2] ?? 20);
if (process.argv.length > 3 || !Number.isInteger(repetitions) || repetitions < 1 || repetitions > 20)
  throw new Error('Usage: npm run benchmark:hybrid-model -- [1–20 repetitions; default 20]');
if (process.platform !== 'win32') throw new Error('Real UI model benchmark requires Windows.');
const model = process.env.WINCODE_MODEL_NAME;
if (!model || !process.env.WINCODE_MODEL_BASE_URL || !process.env.WINCODE_MODEL_API_KEY)
  throw new Error('Set WINCODE_MODEL_NAME, WINCODE_MODEL_BASE_URL and WINCODE_MODEL_API_KEY using an existing authorized provider.');
const complete = httpCompletion(process.env.WINCODE_MODEL_BASE_URL, process.env.WINCODE_MODEL_API_KEY);
const output = path.join(root, 'test-tmp', 'hybrid-model-' + Date.now());
await fs.mkdir(output, { recursive: true });
const harnessSources = await Promise.all(['scripts/benchmark-hybrid-model.ts', 'scripts/lib/hybrid-model.ts'].map(async file =>
  ({ file, sha256: createHash('sha256').update(await fs.readFile(path.join(root, file))).digest('hex') })));
const auditPath = path.join(process.env.LOCALAPPDATA!, 'WinCode', 'logs', 'ui-audit', 'access.jsonl');
const auditBefore = await fs.readFile(auditPath, 'utf8').catch(() => '');
const session = new WinCodeSession({ workspace: root });
const child = spawn(path.join(root, 'tests/fixtures/wpf-ui-review/bin/Release/net10.0-windows/win-x64/publish/wpf-ui-review.exe'),
  ['--background-fixture', '--hybrid-fixture', '--auto-close=3600000'],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
const foreground: string[] = []; let stderr = '', target: UiTarget | undefined;
child.stderr!.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2048); });
const ready = new Promise<UiTarget>((resolve, reject) => {
  let buffer = '';
  child.stdout!.on('data', chunk => {
    buffer += chunk.toString();
    let boundary;
    while ((boundary = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, boundary).trim(); buffer = buffer.slice(boundary + 1);
      if (line.startsWith('FOREGROUND ')) foreground.push(line);
      const found = line.match(/^READY (\d+) (0x[\dA-F]+)$/);
      if (found) resolve({ pid: Number(found[1]), hwnd: found[2] });
    }
  });
  child.once('error', reject); child.once('exit', code => reject(new Error(`Fixture exited ${code}: ${stderr}`)));
});
const controller = new AbortController();
const interrupt = () => controller.abort(new Error('Benchmark interrupted.'));
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
const samples: Array<Omit<Awaited<ReturnType<typeof runModelUiTask>>, 'turns' | 'toolResults'> & { repeat: number; transcript: string }> = [];
let runtime: unknown, coldConnectionMs = 0, gatewayExited = false, fixtureExited = false, failure: string | undefined;
const parse = (result: Awaited<ReturnType<WinCodeSession['call']>>) => {
  const text = result.content.find(block => block.type === 'text'); assert.ok(text?.type === 'text'); return JSON.parse(text.text);
};
try {
  target = await withTimeout(ready, 10000, 'Model benchmark fixture readiness');
  const begin = performance.now(); runtime = parse(await session.call('wincode_hello_world')).runtime; coldConnectionMs = performance.now() - begin;
  const listed = parse(await session.call('wincode_ui_list_windows', { pid: target.pid, maxWindows: 8 }));
  assert.ok(listed.windows.some((window: UiTarget) => window.pid === target!.pid && BigInt(window.hwnd) === BigInt(target!.hwnd)));
  for (let repeat = 0; repeat < repetitions; repeat++) {
    for (const task of modelTasks) {
      for (const mode of repeat % 2 ? ['hybrid', 'native'] as const : ['native', 'hybrid'] as const) {
        controller.signal.throwIfAborted();
        const result = await runModelUiTask({ task, mode, target, model, complete, call: session.call.bind(session), signal: controller.signal });
        const transcript = `${repeat}-${task.id}-${mode}.json`;
        await fs.writeFile(path.join(output, transcript), JSON.stringify(result, null, 2));
        const { turns: _turns, toolResults: _results, ...sample } = result;
        samples.push({ ...sample, repeat, transcript });
        console.log(JSON.stringify({ repeat, task: task.id, mode, success: result.success, modelRequests: result.modelRequests,
          mcpCalls: result.mcpCalls, totalTokens: result.measuredUsage?.totalTokens ?? null, elapsedMs: Math.round(result.elapsedMs), failure: result.failure }));
        const health = parse(await session.call('wincode_hello_world')).health;
        assert.equal(health.flaui.runtime.activePid, null); assert.equal(health.inFlightRequests, 0);
        // Provider/contract failure needs diagnosis, not 160 repetitions of an unusable path.
        if (result.failure && /MODEL_HTTP_|INVALID_MODEL_RESPONSE|TASK_CANCELLED/.test(result.failure)) throw new Error(result.failure);
      }
    }
  }
} catch (error) { failure = controller.signal.aborted ? 'BENCHMARK_INTERRUPTED' : error instanceof Error ? error.message : 'BENCHMARK_ERROR'; }
finally {
  const gatewayPid = session.status.pid;
  try { await session.close(); if (gatewayPid) assert.throws(() => process.kill(gatewayPid, 0), { code: 'ESRCH' }); gatewayExited = true; }
  catch { failure ??= 'GATEWAY_CLEANUP_FAILED'; }
  try { await killProcessTree(child); await withTimeout(closed, 5000, 'Model fixture exit'); if (child.pid) assert.throws(() => process.kill(child.pid!, 0), { code: 'ESRCH' }); fixtureExited = true; }
  catch { failure ??= 'FIXTURE_CLEANUP_FAILED'; }
  process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  let observedAuditHelperStarts: number | null = null;
  try {
    const auditAfter = await fs.readFile(auditPath, 'utf8');
    if (auditAfter.startsWith(auditBefore) && target) observedAuditHelperStarts = auditAfter.slice(auditBefore.length).trim().split('\n').filter(Boolean)
      .map(line => JSON.parse(line)).filter(entry => entry.phase === 'start' && entry.target === target!.pid).length;
  } catch { /* Missing/concurrent audit data cannot establish a helper count. */ }
  for (const source of harnessSources) if (source.sha256 !== createHash('sha256').update(await fs.readFile(path.join(root, source.file))).digest('hex'))
    failure ??= 'HARNESS_CHANGED_DURING_MEASUREMENT';
  const percentile = (values: number[], fraction: number) => values.sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)] ?? null;
  const comparisons = modelTasks.map(task => {
    const statistics = (mode: string) => {
      const all = samples.filter(sample => sample.task === task.id && sample.mode === mode), rows = all.filter(sample => sample.success);
      const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
      return { samples: all.length, passed: rows.length, failures: all.filter(sample => !sample.success).map(sample => ({ repeat: sample.repeat, failure: sample.failure })),
        p50Ms: percentile(rows.map(row => row.elapsedMs), .5), p95Ms: percentile(rows.map(row => row.elapsedMs), .95),
        meanModelRequests: mean(rows.map(row => row.modelRequests)), meanModelToolRounds: mean(rows.map(row => row.modelToolRounds)),
        meanMcpCalls: mean(rows.map(row => row.mcpCalls)),
        meanTotalTokens: rows.length && rows.every(row => row.measuredUsage) ? mean(rows.map(row => row.measuredUsage!.totalTokens)) : null };
    };
    const native = statistics('native'), hybrid = statistics('hybrid');
    const valid = native.passed === repetitions && hybrid.passed === repetitions;
    return { task: task.id, native, hybrid, validComparison: valid,
      totalTokenReduction: valid && native.meanTotalTokens && hybrid.meanTotalTokens ? 1 - hybrid.meanTotalTokens / native.meanTotalTokens : null,
      medianLatencyReduction: valid && native.p50Ms && hybrid.p50Ms ? 1 - hybrid.p50Ms / native.p50Ms : null };
  });
  let revision: string | null = null;
  try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(); } catch {}
  const report = { formatVersion: 1, experiment: 'real-model-preinstalled-readonly-recipes', revision, harnessSources, model,
    settings: { temperature: 0, thinking: 'disabled', maxOutputTokens: 2048, maxModelRequestsPerTask: 8, maxTaskTimeMs: 120000, retries: 0 },
    repetitions, formalSampleSize: repetitions >= 20, plannedSamples: repetitions * 8, completedSamples: samples.length,
    success: !failure && samples.length === repetitions * 8 && samples.every(sample => sample.success), failure,
    runtime, target, coldConnectionMs, schemaJsonBytes: { native: Buffer.byteLength(JSON.stringify(modelTools('native'))), hybrid: Buffer.byteLength(JSON.stringify(modelTools('hybrid'))) },
    metricSemantics: 'Usage is summed provider prompt+completion tokens including cached prompt tokens and final answers. Model requests include the final answer. Timings exclude shared cold connection and window discovery. Hybrid recipes are preinstalled; no generated-program cost or production harness overhead is measured. One observation barrier per model turn returns a matching deferred result for every later call ID.',
    comparisons, samples, observedAuditHelperStarts, gatewayExited, fixtureExited, foregroundSamples: foreground.length,
    observedFixtureForeground: target ? foreground.some(line => line.split(' ').at(-1)?.toLowerCase() === target!.hwnd.toLowerCase()) : null };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report: path.join(output, 'report.json'), success: report.success, failure, gatewayExited, fixtureExited }));
  if (!report.success) process.exitCode = 1;
}
