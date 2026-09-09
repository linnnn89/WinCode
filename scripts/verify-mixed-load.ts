import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { ToolRouter } from '../src/Core/ToolRouter.js';
import { getDefaultConfig } from '../src/Core/Config.js';
import { withTimeout } from '../src/Core/ResourceManager.js';

const intervalArg = process.argv.slice(2);
assert.ok(intervalArg.length <= 1 && (!intervalArg.length || /^--sample-interval-ms=\d+$/.test(intervalArg[0])),
  'Usage: verify-mixed-load.ts [--sample-interval-ms=0..15000]');
const sampleIntervalMs = intervalArg.length ? Number(intervalArg[0].split('=')[1]) : 0;
assert.ok(sampleIntervalMs <= 15000, 'sample interval must preserve the five-minute budget');

// Only inspect this Gateway fixture and its directly owned upstream PIDs. The
// sampler is synchronous so every PowerShell process has exited before returning.
function processMetrics(pids: number[]) {
  if (process.platform !== 'win32') return { available: false, reason: 'Windows Get-Process unavailable' };
  assert.ok(pids.every(pid => Number.isSafeInteger(pid) && pid > 0));
  try {
    const output = cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `@(Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | Select-Object Id,HandleCount,WorkingSet64,PrivateMemorySize64) | ConvertTo-Json -Compress`],
    { windowsHide: true, timeout: 5000, maxBuffer: 65536, encoding: 'utf8' });
    const parsed = output.trim() ? JSON.parse(output) : [];
    const processes = Array.isArray(parsed) ? parsed : [parsed];
    return { available: true, processes, missingPids: pids.filter(pid => !processes.some(item => item.Id === pid)) };
  } catch (error) { return { available: false, reason: String(error) }; }
}

const parent = path.resolve('test-tmp/mixed-load');
await fs.mkdir(parent, { recursive: true });
const root = await fs.mkdtemp(path.join(parent, 'run-'));
const roots = [path.join(root, 'a'), path.join(root, 'b')];
for (const [index, directory] of roots.entries()) {
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, `Only${index}.cs`), [`class Only${index} {}`,
    ...Array.from({ length: 10 }, (_, round) => `class Probe${round}Only${index} {}`)].join('\n'));
}
const config = getDefaultConfig(roots[0]);

config.adapters.flaui.enabled = false;
config.adapters.repomix.useCli = false;
const router = new ToolRouter(config);
const children: cp.ChildProcess[] = [];
const originalSpawn = cp.spawn;
cp.spawn = ((...args: any[]) => {
  const child = (originalSpawn as any)(...args) as cp.ChildProcess;
  children.push(child); return child;
}) as typeof cp.spawn;
syncBuiltinESMExports();
const started = Date.now(), deadline = started + 300000;
const samples: Record<string, unknown>[] = [], calls: Record<string, unknown>[] = [];
const interleavings: Record<string, unknown>[] = [];
let error: string | undefined;
async function call<T>(name: string, work: () => Promise<T>): Promise<T> {
  assert.ok(Date.now() < deadline && calls.length < 100, 'bounded run budget');
  const begin = Date.now();
  const result = await work();
  calls.push({ name, durationMs: Date.now() - begin, outputChars: JSON.stringify(result)?.length ?? 0 });
  return result;
}
async function query(index: number) {
  await router.acquireRequestSlot();
  try {
    const result = await router.findCodeSymbols(`Only${index}`);
    assert.ok(result.symbols.some(symbol => symbol.name === `Only${index}`));
    assert.ok(result.symbols.every(symbol => !symbol.file.includes(`Only${1 - index}`)));
    return result;
  } finally { router.endRequest(); }
}
try {
  await router.initialize();
  for (let round = 0; round < 10; round++) {
    if (round && sampleIntervalMs) await new Promise(resolve => setTimeout(resolve, sampleIntervalMs));
    const index = round % 2;
    await call('switch', () => router.openWorkspace(roots[index]));
    await call('query-before-interleaving', () => query(index));
    // 调度门只控制文本查询开始时刻；保留真实扫描及工作区排空逻辑。
    const cancel = round % 2 === 0;
    const upstreamMetrics = processMetrics([process.pid]);
    const controller = new AbortController();
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const adapter = router.text as any;
    const originalCall = adapter.findSymbolsDetailed;
    adapter.findSymbolsDetailed = async (...args: unknown[]) => {
      entered();
      await gate;
      return originalCall.apply(adapter, args);
    };
    const queryWork = call(cancel ? 'cancel-in-flight' : 'query-in-flight', async () => {
      await router.acquireRequestSlot();
      try {
        const pending = router.findCodeSymbols(`Probe${round}`, undefined, controller.signal);
        if (cancel) {
          await assert.rejects(pending, /abort|cancel/i);
          return { cancelled: true };
        }
        const result = await pending;
        assert.notEqual(result.source, 'roslyn');
        assert.ok(result.symbols.some(symbol => symbol.name === `Probe${round}Only${index}`));
        return result;
      } finally { router.endRequest(); }
    });
    let switching: Promise<unknown> | undefined;
    // Attach handlers immediately: even setup assertion failures must settle owned work.
    void queryWork.catch(() => {});
    try {
      await withTimeout(ready, 5000, 'mixed-load-query-entry');
      switching = call('switch-during-query', () => router.openWorkspace(roots[1 - index]));
      void switching.catch(() => {});
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(router.isSwitchingWorkspace, true);
      assert.equal(router.inFlightRequests, 1);
      assert.equal(router.config.workspaceRoot, roots[index], 'root cannot change while the old query owns its slot');
      interleavings.push({ round, mode: cancel ? 'cancel' : 'text-completion',
        queryStarted: true, switchWaiting: true, oldRootPreserved: true });
      if (cancel) controller.abort();
      release();
      await Promise.all([queryWork, switching]);
    } finally {
      controller.abort(); release();
      await Promise.allSettled([queryWork, ...(switching ? [switching] : [])]);
      adapter.findSymbolsDetailed = originalCall;
    }

    await router.text.initialize();
    await Promise.all([call('query-after-interleaving-1', () => query(1 - index)),
      call('query-after-interleaving-2', () => query(1 - index))]);
    const health = await call('health', () => router.getRuntimeHealth());
    assert.equal(health.inFlightRequests, 0);
    assert.equal(health.workspaceRecovery, null);
    assert.equal(health.session?.workspaceRoot, roots[1 - index]);
    assert.equal(health.workspaceWatch.root, roots[1 - index]);
    samples.push({ round, elapsedMs: Date.now() - started, gatewayPid: process.pid,
      upstreamMetrics, settledMetrics: processMetrics([process.pid]),
      memory: process.memoryUsage(), activeResources: process.getActiveResourcesInfo(),
      spawnedPids: children.map(child => child.pid),
      liveOwnedChildren: children.filter(child => child.exitCode === null && child.signalCode === null).length });
    console.log(JSON.stringify({ round, calls: calls.length, elapsedMs: Date.now() - started }));
  }
} catch (caught) {
  error = caught instanceof Error ? caught.stack : String(caught);
} finally {
  try { await router.dispose(); }
  catch (caught) { error = `${error ?? ''}\nCleanup: ${String(caught)}`; }
  cp.spawn = originalSpawn;
  syncBuiltinESMExports();
}
const liveOwnedPids = children.filter(child => child.exitCode === null && child.signalCode === null).map(child => child.pid);
if (liveOwnedPids.length) error = `${error ?? ''}\nOwned child processes still live: ${liveOwnedPids.join(',')}`;
const report = { success: !error, node: process.version, elapsedMs: Date.now() - started, callCount: calls.length,
  sampleIntervalMs, finalMetrics: processMetrics([process.pid]),
  budget: { maxCalls: 100, maxMs: 300000 }, calls, samples, interleavings, liveOwnedPids, error,
  limitations: ['Generated workspaces and real local text scans; Roslyn process faults are covered by the separate real Host/Gateway suites.',
    'Bounded paced sample is not an endurance or leak proof; no forced GC or continuous high-load claim.',
    'Windows WorkingSet64 is a point-in-time working set, not peak RSS. Metrics availability/missing PIDs are recorded explicitly.',
    'outputChars are serialized UTF-16 characters, not model tokens.'],
};
const reportFile = path.join(root, 'report.json');
await fs.writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ reportFile, success: report.success, elapsedMs: report.elapsedMs, callCount: calls.length,
  spawnedProcesses: children.length, liveOwnedPids, error }, null, 2));
if (error) process.exitCode = 1;
