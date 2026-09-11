/** Ten real Roslyn release/reload cycles in generated projects; does not touch the active Codex connection. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ToolRouter } from '../src/Core/ToolRouter.js';
import { getDefaultConfig, WINCODE_VERSION } from '../src/Core/Config.js';
import { CodeQueryError, type FindSymbolsResult, type FindReferencesResult } from '../src/Core/CodeQueries.js';

const repo = path.resolve(import.meta.dirname, '..');
const { resolveDotnet, runDotnet } = await import(pathToFileURL(path.join(repo, 'scripts/lib/dotnet.mjs')).href);
const { ownedProcesses, observedSurvivors, terminateObserved } = await import(pathToFileURL(path.join(repo, 'scripts/lib/owned-processes.mjs')).href);
const toolchain = resolveDotnet(repo);
const parent = path.join(repo, 'test-tmp/manual-release');
await fs.mkdir(parent, { recursive: true });
const root = await fs.mkdtemp(path.join(parent, 'run-'));
const report: any = { version: WINCODE_VERSION, root, success: false, cycles: [], scenarios: [], observedProcesses: [],
  limitations: ['Generated small C# project, source Router and actual published Roslyn Host on this Windows 11 computer. Working sets include shared pages and do not equal uniquely reclaimed RAM.'] };
let router: ToolRouter | undefined;
const project = '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><EnableNETAnalyzers>false</EnableNETAnalyzers></PropertyGroup></Project>';
function memory(pids: number[]) {
  assert.ok(pids.every(pid => Number.isSafeInteger(pid) && pid > 0));
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', `@(${pids.join(',')}) | ForEach-Object { $p = Get-Process -Id $_ -ErrorAction SilentlyContinue; if ($p) { try { [PSCustomObject]@{pid=$p.Id;workingSetBytes=$p.WorkingSet64;privateBytes=$p.PrivateMemorySize64;cpuSeconds=$p.TotalProcessorTime.TotalSeconds} } finally {$p.Dispose()} } } | ConvertTo-Json -Compress`],
    { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout || '[]'); return Array.isArray(value) ? value : [value];
}
try {
  for (const name of ['A', 'B']) {
    const workspace = path.join(root, name); await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, 'App.csproj'), project);
    await fs.writeFile(path.join(workspace, 'Api.cs'), `namespace ${name}; public class Api { public static void Save() {} } public class Use { public void Run() { Api.Save(); } }`);
    runDotnet(toolchain, ['restore', path.join(workspace, 'App.csproj'), '--ignore-failed-sources', '--nologo'], repo, 60000);
  }
  const config = getDefaultConfig(path.join(root, 'A'));
  config.cacheDir = path.join(root, 'cache');
  config.adapters.roslyn = { enabled: true, allowProjectEvaluation: true, project: 'App.csproj', configuration: 'Debug', targetFramework: 'net10.0',
    hostPath: path.join(repo, 'tools/WinCode.Code.Host/bin/Release/net10.0/publish/WinCode.Code.Host.dll'), dotnetPath: toolchain.dotnet, loadTimeoutMs: 15000, queryTimeoutMs: 10000 };
  router = new ToolRouter(config); await router.initialize();
  const resourcesBefore = router.resources.list().length;
  const watchBefore = (router as any).watch.getStatus();
  const namespace = router.cache.currentNamespace;
  await router.cache.set('manual-release-marker', { retained: true });
  assert.equal(router.getMemoryControlStatus().roslynLoaded, false);
  const snapshots = new Set<string>();
  for (let cycle = 1; cycle <= 10; cycle++) {
    const started = performance.now();
    const result: FindSymbolsResult = await router.findCodeSymbols('Save', 'method');
    const coldMs = performance.now() - started;
    assert.equal(result.source, 'roslyn'); assert.equal(result.symbols.length, 1);
    const location = result.symbols[0].location!;
    assert.ok(location); assert.ok(!snapshots.has(location.snapshotId)); snapshots.add(location.snapshotId);
    const warmStart = performance.now(); await router.findCodeSymbols('Save', 'method');
    const warmMs = performance.now() - warmStart;
    const references: FindReferencesResult = await router.findCodeReferences('Save', undefined, undefined, location);
    assert.equal(references.totalReferences, 1);
    const pid: number = (router.roslyn as any).client.child.pid;
    const owned: any[] = ownedProcesses(pid); assert.ok(owned.length >= 2, 'Actual Code Host and BuildHost must be observed');
    report.observedProcesses.push(...owned);
    const before = memory([process.pid, ...owned.map((p: any) => p.ProcessId)]);
    const releaseStart = performance.now();
    assert.equal((await router.releaseRoslynMemory()).status, 'released');
    const releaseMs = performance.now() - releaseStart;
    assert.equal(router.getMemoryControlStatus().roslynLoaded, false);
    assert.equal(router.getMemoryControlStatus().automaticRelease, false);
    assert.equal(router.resources.childProcessCount(), 0);
    assert.deepEqual(observedSurvivors(owned), []);
    assert.equal((await router.releaseRoslynMemory()).status, 'already-cold');
    await assert.rejects(router.findCodeReferences('Save', undefined, undefined, location), (error: unknown) => error instanceof CodeQueryError && error.errorCode === 'SNAPSHOT_STALE');
    assert.equal(router.resources.childProcessCount(), 0, 'Stale location must not start a Host');
    assert.equal(router.resources.list().length, resourcesBefore);
    assert.equal(router.cache.currentNamespace, namespace);
    assert.deepEqual(await router.cache.get('manual-release-marker'), { retained: true });
    assert.deepEqual((router as any).watch.getStatus(), watchBefore);
    report.cycles.push({ cycle, coldMs, warmMs, releaseMs, before, after: memory([process.pid]), resourceCount: router.resources.list().length, survivors: [] });
    console.log(`[manual-release] ${cycle}/10 cold=${Math.round(coldMs)}ms warm=${Math.round(warmMs)}ms release=${Math.round(releaseMs)}ms`);
  }
  await fs.writeFile(path.join(root, 'A/Added.cs'), 'namespace A; public class AddedWhileCold {}');
  const changed = await router.findCodeSymbols('AddedWhileCold', 'class'); assert.equal(changed.symbols.length, 1);
  await router.releaseRoslynMemory();
  report.scenarios.push('Ten cycles: re-created snapshots, correct references, actual Host/BuildHost exit, stale locations rejected without warming, stable resource count, preserved cache and watcher');
  await assert.rejects(router.openWorkspace(path.join(root, 'B')), (error: any) => error.errorCode === 'WORKSPACE_MISMATCH');
  const peerConfig = getDefaultConfig(path.join(root, 'B'));
  peerConfig.adapters.roslyn = config.adapters.roslyn;
  peerConfig.adapters.flaui.enabled = false; peerConfig.adapters.repomix.useCli = false;
  const peer = new ToolRouter(peerConfig);
  try {
    await peer.initialize();
    assert.equal((await peer.findCodeSymbols('Save', 'method')).symbols[0].signature, 'B.Api.Save()');
    report.observedProcesses.push(...ownedProcesses((peer.roslyn as any).client.child.pid));
    assert.equal((await peer.releaseRoslynMemory()).status, 'released');
  } finally { await peer.dispose(); }
  await router.openWorkspace(path.join(root, 'A'));
  assert.equal((await router.findCodeSymbols('Save', 'method')).symbols[0].signature, 'A.Api.Save()');
  await router.releaseRoslynMemory();
  report.scenarios.push('Editing while cold is seen on the next search; wrong-root open is rejected and independent A/B connections remain releasable and reusable');
  report.success = true;
} catch (error) { report.error = error instanceof Error ? error.stack : String(error); process.exitCode = 1; }
finally {
  try { await router?.dispose(); } catch (error) { report.cleanupError = String(error); report.success = false; process.exitCode = 1; }
  const survivors = observedSurvivors(report.observedProcesses);
  report.survivors = survivors;
  if (survivors.length) { report.success = false; process.exitCode = 1; for (const item of survivors) terminateObserved(item); }
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`[manual-release] ${report.success ? 'passed' : 'failed'}: ${path.join(root, 'report.json')}`);
}
