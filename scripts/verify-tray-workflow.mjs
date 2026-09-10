/** Real compiled MCP components + secured native Tray + real Roslyn, isolated from the active Codex connection. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { resolveDotnet, runDotnet } from './lib/dotnet.mjs';
import { ownedProcesses, observedSurvivors, terminateObserved } from './lib/owned-processes.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const sdk = resolveDotnet(repo);
const parent = path.join(repo, 'test-tmp/tray-workflow'); await fs.mkdir(parent, { recursive: true });
const root = await fs.mkdtemp(path.join(parent, 'run-'));
const report = { root, success: false, scenarios: [], samples: [], timings: [], observed: [],
  limitations: ['Compiled Gateway components with an isolated stdio SDK client and test-only pipe namespace; not the active Codex connection. Generated small C# projects; short residency observation is not a long-term leak proof. Working set sums may count shared pages more than once.'] };
let tray, exited, sequence = 0, stderr = '';
const clients = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function command(operation, instanceId = '') {
  const n = ++sequence, file = path.join(root, `command-${n}.json`);
  await fs.writeFile(file + '.tmp', JSON.stringify({ operation, instanceId })); await fs.rename(file + '.tmp', file);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { return JSON.parse(await fs.readFile(path.join(root, `reply-${n}.json`), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (tray.exitCode != null) throw new Error(`Tray exited: ${await fs.readFile(path.join(root, 'workflow-error.txt'), 'utf8').catch(() => stderr)}`);
    await delay(25);
  }
  throw new Error(`Tray ${operation} deadline exceeded`);
}
async function call(client, name, args = {}, expectedError = false) {
  const started = performance.now();
  const response = await client.callTool({ name, arguments: args }, { timeout: 60000 });
  const data = JSON.parse(response.content[0].text);
  assert.equal(response.isError === true, expectedError, JSON.stringify(data));
  report.timings.push({ tool: name, ms: performance.now() - started });
  return data;
}
const search = client => call(client, 'wincode_find_code_symbol', { query: 'Save', kind: 'method' });
function remember(items) { for (const item of items) if (!report.observed.some(old => old.ProcessId === item.ProcessId && old.CreationDate === item.CreationDate)) report.observed.push(item); }
function processSample(label) {
  const ids = [...new Set([...(tray.exitCode == null ? [tray.pid] : []), ...clients.flatMap(({ transport }) => transport.pid ? ownedProcesses(transport.pid).map(p => p.ProcessId) : [])])];
  assert.ok(ids.every(id => Number.isSafeInteger(id) && id > 0));
  const output = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    `@(${ids.join(',')}) | ForEach-Object { $p=Get-Process -Id $_ -ErrorAction SilentlyContinue; if($p){ try{[PSCustomObject]@{pid=$p.Id;workingSetBytes=$p.WorkingSet64;privateBytes=$p.PrivateMemorySize64;cpuSeconds=$p.TotalProcessorTime.TotalSeconds;handles=$p.HandleCount}}finally{$p.Dispose()}} } | ConvertTo-Json -Compress`],
    { encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(output.status, 0, output.stderr);
  const value = JSON.parse(output.stdout || '[]'); report.samples.push({ label, at: new Date().toISOString(), processes: Array.isArray(value) ? value : [value] });
}
try {
  const host = path.join(repo, 'tools/WinCode.Code.Host/bin/Release/net10.0/publish/WinCode.Code.Host.dll');
  for (const tag of ['A', 'B']) {
    const workspace = path.join(root, tag); await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, 'NuGet.Config'), '<configuration><packageSources><clear /></packageSources></configuration>');
    await fs.writeFile(path.join(workspace, 'App.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><EnableNETAnalyzers>false</EnableNETAnalyzers></PropertyGroup></Project>');
    await fs.writeFile(path.join(workspace, 'Api.cs'), `namespace ${tag}; public class Api { public static void Save(int x) {} public static void Save(string x) {} } public class Use { public void Run() { Api.Save(1); Api.Save("x"); } }`);
    runDotnet(sdk, ['restore', path.join(workspace, 'App.csproj'), '--nologo'], repo, 60000);
  }
  tray = spawn(path.join(repo, 'tools/WinCode.Tray/bin/Release/net10.0-windows/win-x64/publish/WinCode.Tray.exe'), ['--workflow-test', root],
    { cwd: repo, env: sdk.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  exited = once(tray, 'exit');
  tray.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
  const ready = await new Promise((resolve, reject) => {
    let text = ''; const timer = setTimeout(() => reject(new Error('Tray startup timed out')), 10000);
    tray.stdout.on('data', chunk => { text += chunk; if (text.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(text.split('\n')[0])); } catch (error) { reject(error); } } });
    exited.then(([code]) => { clearTimeout(timer); reject(new Error(`Tray exited at startup: ${code}`)); }, reject);
  });
  assert.equal(ready.pid, tray.pid); remember(ownedProcesses(tray.pid));
  for (const tag of ['A', 'B']) {
    const workspace = path.join(root, tag);
    // Only test wiring differs from main: same compiled Router, MCP server and TrayClient, no lifecycle mocks.
    const bootstrap = `
      import { ToolRouter } from './dist/Core/ToolRouter.js';
      import { getDefaultConfig } from './dist/Core/Config.js';
      import { WinCodeMcpServer } from './dist/Gateway/McpServer.js';
      import { TrayClient } from './dist/Gateway/TrayClient.js';
      const config=getDefaultConfig(${JSON.stringify(workspace)}); config.cacheDir=${JSON.stringify(path.join(workspace, '.cache'))};
      config.adapters.roslyn={enabled:true,allowProjectEvaluation:true,project:'App.csproj',configuration:'Debug',targetFramework:'net10.0',dotnetPath:${JSON.stringify(sdk.dotnet)},hostPath:${JSON.stringify(host)},loadTimeoutMs:15000,queryTimeoutMs:10000};
      const router=new ToolRouter(config),server=new WinCodeMcpServer(router); await server.start();
      let stopping=false; const control=new TrayClient(${JSON.stringify(ready.pipeName)},router,()=>void stop());
      async function stop(){if(stopping)return;stopping=true;control.dispose();await server.stop();}
      server.onDisconnect=()=>void stop();process.stdin.once('end',()=>void stop());control.start();
    `;
    const client = new Client({ name: `tray-workflow-${tag}`, version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--input-type=module', '--eval', bootstrap], cwd: repo, env: sdk.env, stderr: 'pipe' });
    clients.push({ client, transport }); await client.connect(transport);
    transport.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
  }
  const [a, b] = clients;
  for (const c of clients) {
    const hello = await call(c.client, 'wincode_hello_world'); c.id = hello.runtime.instanceId;
    assert.equal(hello.codeProvider, 'roslyn'); assert.equal(hello.health.roslyn.processAlive, false);
    c.build = hello.runtime.build; assert.equal(c.build.status, 'verified');
  }
  let state = await command('refresh'); assert.equal(state.peers.filter(p => p.connected).length, 2);
  processSample('tray-open-both-cold');
  const symbolsA = await search(a.client), symbolsB = await search(b.client);
  const target = symbolsA.symbols.find(s => s.signature === 'A.Api.Save(int)'); assert.ok(target?.location);
  const snapshotB = symbolsB.symbols[0].location.snapshotId;
  const refs = await call(a.client, 'wincode_find_references', { symbolName: 'Save', symbolLocation: target.location }); assert.equal(refs.totalReferences, 1);
  const beforeA = ownedProcesses(a.transport.pid), beforeB = ownedProcesses(b.transport.pid); remember(beforeA); remember(beforeB);
  const codeA = beforeA.find(p => p.ParentProcessId === a.transport.pid && p.CommandLine?.includes(host));
  assert.ok(codeA, 'The actual owned Code Host must be present');
  // MSBuild's temporary evaluation host may already be gone; track the observed Code Host subtree by identity.
  const hostsA = ownedProcesses(codeA.ProcessId); remember(hostsA); processSample('tray-open-both-warm');
  // Actual semantic MCP requests remain queued/running; no fake busy counters or timer-triggered release.
  const burst = Promise.all(Array.from({ length: 24 }, () => search(a.client)));
  const during = await command('release', a.id);
  assert.match(during.result, /工作/); await burst;
  assert.equal((await search(a.client)).symbols[0].location.snapshotId, target.location.snapshotId);
  assert.equal(observedSurvivors(hostsA).length, hostsA.length);
  report.scenarios.push('Actual concurrent semantic MCP work rejects the native Settings release command; draining work does not trigger a deferred release');
  await command('hide');
  // Cross the UI observation lifetime twice while keeping genuine queries and both Host identities warm.
  for (let sample = 0; sample < 7; sample++) {
    await delay(10000);
    assert.equal((await search(a.client)).symbols[0].location.snapshotId, target.location.snapshotId);
    assert.equal((await search(b.client)).symbols[0].location.snapshotId, snapshotB);
    assert.equal(observedSurvivors(hostsA).length, hostsA.length);
    processSample(`hidden-warm-${sample + 1}`);
    console.log(`[tray-workflow] warm residency ${sample + 1}/7: snapshots and Host identities retained`);
  }
  report.scenarios.push('Hidden Tray and repeated semantic work retain the same snapshots and actual Host identities across seven spaced observations; no automatic stop/start');
  await command('show');
  state = await command('release', a.id); assert.match(state.result, /已释放/);
  assert.equal(state.peers.find(p => p.instanceId === a.id).status.roslynLoaded, false);
  assert.equal(state.peers.find(p => p.instanceId === b.id).status.snapshotId, snapshotB);
  assert.deepEqual(observedSurvivors(hostsA), []); processSample('manual-release-a-only');
  state = await command('release', a.id); assert.match(state.result, /无需释放/);
  const stale = await call(a.client, 'wincode_find_references', { symbolName: 'Save', symbolLocation: target.location }, true);
  assert.equal(stale.errorCode, 'SNAPSHOT_STALE');
  assert.equal((await call(a.client, 'wincode_hello_world')).health.roslyn.processAlive, false);
  const fresh = (await search(a.client)).symbols.find(s => s.signature === 'A.Api.Save(int)');
  assert.notEqual(fresh.location.snapshotId, target.location.snapshotId);
  assert.equal((await call(a.client, 'wincode_find_references', { symbolName: 'Save', symbolLocation: fresh.location })).totalReferences, 1);
  remember(ownedProcesses(a.transport.pid));
  assert.equal((await search(b.client)).symbols[0].location.snapshotId, snapshotB);
  report.scenarios.push('Native Settings releases only A; old locations fail without warming; explicit new search reloads once and restores precise references; B remains warm');
  await command('exit'); assert.equal((await exited)[0], 0);
  assert.equal((await search(a.client)).symbols[0].location.snapshotId, fresh.location.snapshotId);
  assert.equal((await search(b.client)).symbols[0].location.snapshotId, snapshotB);
  processSample('tray-exited-both-warm');
  report.scenarios.push('Exiting native Tray preserves both live MCP connections, semantic snapshots and successful queries');
  report.success = true;
} catch (error) { report.error = error.stack ?? String(error); process.exitCode = 1; }
finally {
  for (const { client } of clients) await client.close().catch(error => { report.cleanupError = String(error); report.success = false; process.exitCode = 1; });
  if (tray && tray.exitCode == null && tray.signalCode == null) { tray.kill(); await exited.catch(() => {}); }
  report.survivors = observedSurvivors(report.observed);
  if (report.survivors.length) { report.success = false; process.exitCode = 1; for (const p of report.survivors) terminateObserved(p); }
  report.stderr = stderr;
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`[tray-workflow] ${report.success ? 'passed' : 'failed'}: ${path.join(root, 'report.json')}`);
}
