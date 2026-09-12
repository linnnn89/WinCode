/** Production N4 acceptance. Every selected scenario must pass against the verified published Host. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { RoslynHostClient } from '../dist/Adapters/RoslynHostClient.js';
import { ResourceManager } from '../dist/Core/ResourceManager.js';
import { codeHostDirectory, verifyDelivery } from './delivery-manifest.mjs';
import { resolveDotnet, runDotnet } from './lib/dotnet.mjs';
import { ownedProcesses, observedSurvivors, terminateObserved } from './lib/owned-processes.mjs';
import { fixture, sourceIdentity, installBlocker, privateOutputs, hash } from './roslyn/design-time-prototypes.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const sdk = resolveDotnet(repo);
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  assert.ok(['--phase', '--filter'].includes(process.argv[i]) && process.argv[i + 1], 'Production acceptance supports only --phase and --filter.');
  options[process.argv[i].slice(2)] = process.argv[i + 1];
}
const phase = options.phase ?? 'all'; assert.ok(['all', 'semantics', 'concurrency', 'interference', 'inputs'].includes(phase));
const modes = ['production'];
const parent = path.join(repo, 'test-tmp/design-time-production'); await fs.mkdir(parent, { recursive: true });
const root = await fs.mkdtemp(path.join(parent, 'run-'));
const before = await sourceIdentity(repo);
const report = { root, phase, filter: options.filter, startedAt: new Date().toISOString(), completed: false, success: false, productionChanged: false,
  build: null, cases: [], observed: [], cleanupFailures: [], limitations: [
    'Verified published Host and production RoslynHostClient with generated projects; not an active consumer connection.',
    'Generated projects, existing locked SDK/packages, no new dependencies or model calls.',
    'No large-project, arbitrary custom target, live Visual Studio or power-loss recovery proof.'
  ] };
const live = new Set(), auxiliaries = new Set();
let currentCase;
let deliveryManifest;
const remember = items => { for (const p of items) if (!report.observed.some(x => x.ProcessId === p.ProcessId && x.CreationDate === p.CreationDate)) report.observed.push(p); };
const save = () => fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n');
function start(mode, project, extra = {}) {
  assert.equal(mode, 'production');
  const vars = { ...extra.env };
  const previous = Object.fromEntries(Object.keys(vars).map(key => [key, process.env[key]]));
  Object.assign(process.env, vars);
  const resources = new ResourceManager();
  let client;
  try { client = new RoslynHostClient(sdk.dotnet, [report.build.host, '--allow-project-evaluation', extra.root ?? project.root,
    path.join(project.root, extra.project ?? project.project), extra.configuration ?? 'Debug', project.framework, '[]'], repo, resources); }
  finally {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  const value = { client, resources, identity: client.buildInstance, project, workspaceRoot: extra.root ?? project.root, started: performance.now() }; live.add(value);
  currentCase?.hosts.push(value);
  return value;
}
async function ready(c, signal) {
  // Match RoslynAdapter's production load budget; this matrix verifies semantics, not a 20-second cold-start target.
  const loadBudgetMs = 120000;
  const result = await c.client.waitReady(loadBudgetMs, { signal, deadline: Date.now() + loadBudgetMs });
  c.ready = result; c.readyMs = performance.now() - c.started;
  remember(ownedProcesses(c.client.child.pid));
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.inputPolicy?.version, 2);
  assert.equal(result.hostIdentity?.version, report.build.version);
  assert.equal(result.hostIdentity?.configuration, 'Release');
  const owner = JSON.parse(await fs.readFile(path.join(c.workspaceRoot, '.cache/wincode-build', c.identity, 'owner.json'), 'utf8'));
  assert.equal(owner.instance, c.identity);
  assert.ok(owner.paths.length >= 1);
  for (const directory of owner.paths) assert.ok(directory.replaceAll('\\', '/').endsWith(`.cache/wincode-msbuild/${c.identity}`));
  c.owner = owner;
  return result;
}
async function semantics(c) {
  const request = (value, ms = 10000) => c.client.request(value, ms, { deadline: Date.now() + ms });
  const result = await request({ operation: 'symbols', snapshot: c.ready.snapshot, query: 'Save', kind: 'method' });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.snapshot, c.ready.snapshot);
  const targets = result.symbols.filter(s => s.name === 'Save' && s.signature === 'Probe.Api.Save(int)');
  assert.equal(targets.length, 1, JSON.stringify(result));
  const target = targets[0], location = target.location;
  const references = await request({ operation: 'references', snapshot: c.ready.snapshot,
    project: location.project, file: location.file, position: location.position, symbolName: 'Save' });
  assert.equal(references.success, true, JSON.stringify(references));
  assert.equal(references.snapshot, c.ready.snapshot);
  const evidence = { projects: c.ready.projects, compilationErrors: c.ready.compilationErrors, loadDiagnostics: c.ready.loadDiagnostics,
    signature: target.signature, project: location.project, file: location.file, position: location.position,
    snapshot: references.snapshot, references: references.references, totalReferences: references.totalReferences,
    workingSetBytes: references.workingSetBytes, queryMs: references.queryMs, readyMs: c.readyMs, owner: c.owner };
  c.lastSemantics = evidence;
  assert.equal(references.totalReferences, c.project.references, JSON.stringify(evidence));
  return evidence;
}
async function close(c) {
  if (!live.delete(c)) return;
  let ownership;
  try {
    remember(ownedProcesses(c.client.child.pid));
    ownership = await fs.readFile(path.join(c.workspaceRoot, '.cache/wincode-build', c.identity, 'owner.json'), 'utf8')
      .then(JSON.parse, error => { if (error.code === 'ENOENT') return undefined; throw error; });
  } finally {
    try { await c.client.close(); }
    finally { await c.resources.dispose(); }
  }
  assert.equal((await privateOutputs(c.project, c.identity)).files, 0, 'production close must reclaim its own outputs');
  if (ownership) {
    assert.equal(ownership.instance, c.identity);
    for (const directory of ownership.paths)
      assert.equal(await exists(path.resolve(c.workspaceRoot, directory)), false, 'every recorded project output must be reclaimed');
  }
  assert.equal(await exists(path.join(c.workspaceRoot, '.cache/wincode-build', c.identity)), false, 'production close must reclaim its manifest');
}
async function trial(label, work) {
  if (options.filter && !label.includes(options.filter)) return { label, status: 'not-selected' };
  const item = { label, status: 'running' }; currentCase = { hosts: [] };
  report.cases.push(item); console.log(`[design-time] ${label}`);
  try { Object.assign(item, await work(item), { status: 'passed' }); }
  catch (error) { item.status = 'failed'; item.error = error.stack ?? String(error); }
  finally {
    for (const c of [...live]) try { await close(c); } catch (error) { report.cleanupFailures.push(String(error)); }
    for (const auxiliary of [...auxiliaries]) try { await closeAuxiliary(auxiliary); } catch (error) { report.cleanupFailures.push(String(error)); }
    item.hosts = currentCase.hosts.map(c => ({ identity: c.identity, pid: c.client.child.pid, snapshot: c.ready?.snapshot, owner: c.owner, lastSemantics: c.lastSemantics }));
    currentCase = null;
    await save();
  }
  return item;
}

const settle = promise => promise.then(value => ({ value }), error => ({ error: String(error) }));
async function until(check, message, ms = 10000) {
  const deadline = Date.now() + ms;
  while (!await check()) { if (Date.now() >= deadline) throw new Error(message); await new Promise(r => setTimeout(r, 20)); }
}
const exists = file => fs.access(file).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; });

function auxiliary(command, args, env) {
  const child = spawn(command, args, { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const value = { child, output: '', release: null, owned: [] }; auxiliaries.add(value);
  child.stdin.on('error', () => {}); // Cleanup may race a process that has already closed stdin.
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { value.output = (value.output + data).slice(-65536); });
  value.done = new Promise(resolve => {
    child.once('error', error => resolve({ error: String(error) }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  if (child.pid) { value.owned = ownedProcesses(child.pid); remember(value.owned); }
  return value;
}
async function closeAuxiliary(value) {
  if (!auxiliaries.delete(value)) return;
  if (value.release) await value.release();
  if (!value.child.stdin.destroyed) value.child.stdin.end('\n');
  let timer;
  const outcome = await Promise.race([value.done, new Promise(resolve => { timer = setTimeout(() => resolve(null), 5000); })]);
  clearTimeout(timer);
  if (!outcome) {
    const owned = value.child.pid ? ownedProcesses(value.child.pid) : [];
    remember(owned);
    for (const process of observedSurvivors([...value.owned, ...owned]).reverse()) terminateObserved(process);
    await value.done;
    throw new Error('Owned test helper exceeded its cleanup deadline.');
  }
}
const request = (c, value, ms = 20000) => c.client.request(value, ms, { deadline: Date.now() + ms });
const probe = c => request(c, { operation: 'symbols', snapshot: c.ready.snapshot, query: 'Save', kind: 'method' });
async function assertExpired(c, response) {
  assert.equal(response.success, false);
  // A watcher event during capture reports INPUTS_CHANGED and permanently expires the snapshot too.
  assert.ok(['SNAPSHOT_STALE', 'INPUTS_CHANGED'].includes(response.errorCode), JSON.stringify(response));
  assert.equal(response.symbols, undefined); assert.equal(response.references, undefined);
  const confirmed = await probe(c);
  assert.equal(confirmed.errorCode, 'SNAPSHOT_STALE');
  assert.equal(confirmed.symbols, undefined); assert.equal(confirmed.references, undefined);
  return confirmed;
}
async function reload(c) {
  const result = await request(c, { operation: 'reload' });
  assert.equal(result.success, true, JSON.stringify(result));
  c.owner = JSON.parse(await fs.readFile(path.join(c.workspaceRoot, '.cache/wincode-build', c.identity, 'owner.json'), 'utf8'));
  assert.equal(c.owner.instance, c.identity);
  c.ready = result; return result;
}
/** Diagnostic file deltas only; the Host's own unchanged fingerprint remains authoritative. */
async function inventory(project) {
  const result = {};
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      assert.equal(entry.isSymbolicLink(), false);
      if (entry.isDirectory() && ['.cache', 'bin'].includes(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (/\.(cs|csproj|props|targets|xaml|json|editorconfig)$/i.test(file)) {
        assert.ok(Object.keys(result).length < 1000);
        result[path.relative(project.root, file)] = hash(await fs.readFile(file));
      }
    }
  }
  await walk(project.root); return result;
}
const delta = (before, after) => ({
  added: Object.keys(after).filter(file => !(file in before)),
  changed: Object.keys(after).filter(file => file in before && before[file] !== after[file]),
  removed: Object.keys(before).filter(file => !(file in after))
});

async function interference() {
  // A deterministic external handle is fault injection, not a Visual Studio integration test.
  for (const mode of modes) await trial(`external-handle/${mode}`, async item => {
    const p = await fixture(root, sdk, `external-handle-${mode}`, 'basic');
    runDotnet(sdk, ['build', path.join(p.root, p.project), '--no-restore', '--nologo', '-p:UseSharedCompilation=false', '-nodeReuse:false'], repo);
    const file = path.join(p.root, 'obj/Debug/net10.0/App.GeneratedMSBuildEditorConfig.editorconfig');
    assert.ok(await exists(file));
    const holder = auxiliary('powershell.exe', ['-NoProfile', '-Command',
      "$ErrorActionPreference='Stop'; $stream=[IO.File]::Open($env:WINCODE_N4_LOCK_FILE,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None); try { [Console]::WriteLine('LOCKED'); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null } finally { $stream.Dispose() }"],
      { ...process.env, WINCODE_N4_LOCK_FILE: file });
    await until(() => holder.output.includes('LOCKED'), 'external helper must hold the exact generated editorconfig');
    const c = start(mode, p); item.load = await settle(ready(c));
    if (item.load.value) item.result = await semantics(c);
    await closeAuxiliary(holder); item.holderExit = await holder.done;
    assert.equal(item.holderExit.code, 0, holder.output);
    assert.ok(item.load.value, 'candidate cannot load while an external process owns the shared generated file');
    assert.deepEqual(item.result.compilationErrors, []);
  });
  for (const mode of modes) await trial(`external-build/${mode}`, async item => {
    const p = await fixture(root, sdk, `external-build-${mode}`, 'basic'), block = await installBlocker(p);
    const identity = randomUUID().replaceAll('-', '');
    const build = auxiliary(sdk.dotnet, ['build', path.join(p.root, p.project), '--no-restore', '--nologo',
      '-p:UseSharedCompilation=false', '-nodeReuse:false'], { ...sdk.env, WINCODE_N4_EXTERNAL_HOLD: '1', WINCODE_BUILD_INSTANCE: identity });
    build.release = () => block.release(identity);
    await until(() => exists(block.marker(identity)), 'real external dotnet build must reach its MSBuild target');
    const owned = ownedProcesses(build.child.pid); build.owned.push(...owned); remember(owned);
    const c = start(mode, p); item.load = await settle(ready(c));
    if (item.load.value) item.beforeBuildFinishes = await semantics(c);
    const beforeBuild = await inventory(p);
    await block.release(identity);
    await until(() => build.child.exitCode !== null || build.child.signalCode !== null, 'external build must finish', 15000);
    item.buildExit = await build.done;
    await fs.writeFile(path.join(p.root, 'external-build.log'), build.output);
    assert.equal(item.buildExit.code, 0, build.output);
    item.fileDelta = delta(beforeBuild, await inventory(p));
    assert.ok(item.load.value, JSON.stringify(item.load));
    item.afterBuild = await probe(c);
    if (!item.afterBuild.success) { await reload(c); item.recovery = await semantics(c); }
    assert.equal(item.afterBuild.success, true, 'external build invalidated the otherwise unchanged warm Host snapshot');
  });
  // A second entry can share a referenced project without invalidating the first snapshot.
  for (const mode of modes) await trial(`sequential-peer/${mode}`, async item => {
    const p = await fixture(root, sdk, `sequential-peer-${mode}`, 'graph');
    const a = start(mode, p); await ready(a); item.first = await semantics(a);
    const beforePeer = await inventory(p);
    const b = start(mode, p, { project: 'Peer/Peer.csproj' }); await ready(b); item.second = await semantics(b);
    item.fileDelta = delta(beforePeer, await inventory(p)); item.firstAfterPeerLoad = await probe(a);
    if (!item.firstAfterPeerLoad.success) { await reload(a); item.recovery = await semantics(a); }
    assert.equal(item.firstAfterPeerLoad.success, true, 'peer project evaluation invalidated the first Host snapshot');
    assert.equal(item.firstAfterPeerLoad.snapshot, item.first.snapshot);
  });
  for (const mode of modes) await trial(`different-config/${mode}`, async item => {
    const p = await fixture(root, sdk, `different-config-${mode}`, 'basic');
    const a = start(mode, p); await ready(a); item.debug = await semantics(a);
    const beforePeer = await inventory(p);
    const b = start(mode, p, { configuration: 'Release' }); await ready(b); item.release = await semantics(b);
    item.fileDelta = delta(beforePeer, await inventory(p)); item.debugAfterRelease = await probe(a);
    if (!item.debugAfterRelease.success) { await reload(a); item.recovery = await semantics(a); }
    assert.equal(item.debugAfterRelease.success, true, 'another configuration invalidated the first Host snapshot');
    assert.deepEqual(item.release.compilationErrors, []);
  });
  for (const mode of modes) await trial(`source-edit/${mode}`, async item => {
    const p = await fixture(root, sdk, `source-edit-${mode}`, 'basic');
    const c = start(mode, p); await ready(c); item.before = await semantics(c);
    const oldLocator = { operation: 'references', snapshot: item.before.snapshot, project: item.before.project,
      file: item.before.file, position: item.before.position, symbolName: 'Save' };
    await fs.writeFile(path.join(p.root, 'Use.cs'), 'namespace Probe; public class Use { public void Run() { Api.Save(1); Api.Save(2); } }');
    item.stale = await request(c, oldLocator); item.confirmedStale = await assertExpired(c, item.stale);
    await reload(c); p.references = 2; item.after = await semantics(c);
    assert.notEqual(item.after.snapshot, item.before.snapshot); assert.deepEqual(item.after.compilationErrors, []);
    item.oldLocatorAfterReload = await request(c, oldLocator);
    assert.equal(item.oldLocatorAfterReload.errorCode, 'SNAPSHOT_STALE');
  });
  for (const mode of modes) await trial(`query-during-reload/${mode}`, async item => {
    const p = await fixture(root, sdk, `query-during-reload-${mode}`, 'basic'), block = await installBlocker(p);
    const a = start(mode, p); await ready(a);
    const b = start(mode, p, { env: { WINCODE_N4_BLOCK: '1' } });
    await block.release(b.identity); await ready(b); item.before = await semantics(a);
    // Remove only this fixture's marker and release signal; the next real reload must block.
    await fs.rm(block.marker(b.identity)); await fs.rm(path.join(block.directory, b.identity + '.release'));
    const reloading = settle(reload(b));
    await until(() => exists(block.marker(b.identity)), 'peer must reach actual MSBuild reload');
    remember(ownedProcesses(b.client.child.pid));
    item.whilePeerBlocked = await semantics(a);
    assert.equal(item.whilePeerBlocked.snapshot, item.before.snapshot);
    await block.release(b.identity); item.reload = await reloading; assert.ok(item.reload.value);
    item.afterPeerReload = await semantics(a); assert.equal(item.afterPeerReload.snapshot, item.before.snapshot);
  });
}

async function inputCounterexamples() {
  await trial('inputs/peer-source-edit', async item => {
    const p = await fixture(root, sdk, 'peer-source-edit', 'basic');
    const a = start('production', p), b = start('production', p);
    await Promise.all([ready(a), ready(b)]);
    item.before = await Promise.all([semantics(a), semantics(b)]);
    const locators = item.before.map(value => ({ operation: 'references', snapshot: value.snapshot,
      project: value.project, file: value.file, position: value.position, symbolName: 'Save' }));
    await fs.writeFile(path.join(p.root, 'Use.cs'), 'namespace Probe; public class Use { public void Run() { Api.Save(1); Api.Save(2); } }');
    item.expired = await Promise.all([a, b].map(async (peer, index) => assertExpired(peer, await request(peer, locators[index]))));
    await Promise.all([reload(a), reload(b)]); p.references = 2;
    item.after = await Promise.all([semantics(a), semantics(b)]);
    assert.ok(item.after.every(value => value.compilationErrors.length === 0 && value.totalReferences === 2));
    for (let index = 0; index < 2; index++) {
      assert.notEqual(item.before[index].snapshot, item.after[index].snapshot);
      assert.equal((await request([a, b][index], locators[index])).errorCode, 'SNAPSHOT_STALE');
    }
    await close(b); item.survivingPeer = await semantics(a);
    assert.equal(item.survivingPeer.snapshot, item.after[0].snapshot);
  });
  await trial('inputs/loaded-generated', async item => {
    const p = await fixture(root, sdk, 'loaded-generated', 'basic');
    const c = start('production', p); await ready(c); item.before = await semantics(c);
    const file = path.join(p.root, '.cache/wincode-msbuild', c.identity, 'Debug/net10.0/App.AssemblyInfo.cs');
    await fs.appendFile(file, '\n// Generated input changed after snapshot.\n');
    item.changed = await probe(c); item.confirmedStale = await assertExpired(c, item.changed);
    await reload(c); item.after = await semantics(c); assert.notEqual(item.before.snapshot, item.after.snapshot);
  });
  await trial('inputs/new-explicit-glob', async item => {
    const p = await fixture(root, sdk, 'explicit-glob', 'basic');
    const project = path.join(p.root, p.project);
    await fs.writeFile(project, (await fs.readFile(project, 'utf8')).replace('</Project>',
      '<ItemGroup><Compile Include="obj/Manual/*.cs" /></ItemGroup></Project>'));
    const c = start('production', p); await ready(c); item.before = await semantics(c);
    await fs.mkdir(path.join(p.root, 'obj/Manual'), { recursive: true });
    await fs.writeFile(path.join(p.root, 'obj/Manual/Extra.cs'), 'namespace Probe; class Extra { void Run() { Api.Save(2); } }');
    item.changed = await probe(c); item.confirmedStale = await assertExpired(c, item.changed);
    await reload(c); p.references = 2; item.after = await semantics(c); assert.deepEqual(item.after.compilationErrors, []);
  });
  await trial('inputs/original-import-hook', async item => {
    const p = await fixture(root, sdk, 'original-hook', 'basic');
    await fs.writeFile(path.join(p.root, 'original.targets'), '<Project><PropertyGroup><DefineConstants>$(DefineConstants);N4_ORIGINAL_HOOK</DefineConstants></PropertyGroup></Project>');
    const project = path.join(p.root, p.project);
    await fs.writeFile(project, (await fs.readFile(project, 'utf8')).replace('</Project>',
      '<PropertyGroup><CustomBeforeMicrosoftCommonTargets>$(MSBuildProjectDirectory)/original.targets</CustomBeforeMicrosoftCommonTargets></PropertyGroup></Project>'));
    await fs.writeFile(path.join(p.root, 'Use.cs'), '#if N4_ORIGINAL_HOOK\nnamespace Probe; class Use { void Run() { Api.Save(1); } }\n#endif');
    const c = start('production', p); await ready(c); item.result = await semantics(c); assert.deepEqual(item.result.compilationErrors, []);
  });
  await trial('inputs/project-reference-change', async item => {
    const p = await fixture(root, sdk, 'reference-change', 'graph');
    const c = start('production', p); await ready(c); item.before = await semantics(c);
    const project = path.join(p.root, p.project);
    await fs.writeFile(project, (await fs.readFile(project, 'utf8')).replace('../Lib/Lib.csproj', '../Peer/Peer.csproj'));
    item.changed = await probe(c); item.confirmedStale = await assertExpired(c, item.changed);
    item.fixtureRestore = runDotnet(sdk, ['restore', project, '--configfile', path.join(root, 'NuGet.Config'), '--nologo'], root, 30000);
    await reload(c); p.references = 2; p.projects = 3;
    item.after = await semantics(c);
    assert.equal(item.after.projects, p.projects); assert.deepEqual(item.after.compilationErrors, []);
    assert.ok(c.owner.paths.some(directory => directory.replaceAll('\\', '/') === `Peer/.cache/wincode-msbuild/${c.identity}`));
  });
}

async function concurrency() {
  for (const type of ['basic', 'graph']) for (const mode of modes) {
    await trial(`parallel/${type}/${mode}`, async () => {
      const p = await fixture(root, sdk, `parallel-${type}-${mode}`, type);
      const a = start(mode, p), b = start(mode, p, type === 'graph' ? { project: 'Peer/Peer.csproj' } : {});
      const loads = await Promise.all([settle(ready(a)), settle(ready(b))]);
      assert.ok(loads.every(x => x.value), JSON.stringify(loads));
      const values = await Promise.all([semantics(a), semantics(b)]);
      assert.ok(values.every(v => v.compilationErrors.length === 0));
      assert.notEqual(a.ready.snapshot, b.ready.snapshot);
      const first = values[0];
      await close(b);
      const after = await semantics(a);
      assert.deepEqual(after.references, first.references); assert.equal(after.snapshot, first.snapshot);
      return { values, survivingPeerReferences: after.totalReferences, survivingPeerSnapshot: after.snapshot };
    });
  }
  for (const mode of modes) await trial(`nested-root/${mode}`, async () => {
    const p = await fixture(root, sdk, `nested-${mode}/Project`, 'basic'), block = await installBlocker(p);
    const a = start(mode, p, { root: path.dirname(p.root), env: { WINCODE_N4_BLOCK: '1' } });
    const loading = settle(ready(a));
    await until(() => exists(block.marker(a.identity)), 'first Host must reach the actual MSBuild blocker');
    remember(ownedProcesses(a.client.child.pid));
    const b = start(mode, p); const second = await settle(ready(b));
    await block.release(a.identity); const first = await loading;
    assert.ok(first.value && second.value, JSON.stringify({ first, second }));
    return { values: await Promise.all([semantics(a), semantics(b)]), secondReadyWhileFirstBlocked: true };
  });
  for (const mode of modes) for (const failure of ['cancel', 'crash']) await trial(`owner-${failure}/${mode}`, async () => {
    const p = await fixture(root, sdk, `${mode}-${failure}`, 'basic'), block = await installBlocker(p);
    const controller = new AbortController();
    const a = start(mode, p, { env: { WINCODE_N4_BLOCK: '1' } }), first = settle(ready(a, controller.signal));
    await until(() => exists(block.marker(a.identity)), 'owner must have an actual MSBuild descendant');
    const owned = ownedProcesses(a.client.child.pid); remember(owned);
    assert.ok(owned.some(p => p.CommandLine?.includes('block.mjs')));
    const b = start(mode, p), second = settle(ready(b));
    assert.ok((await second).value, 'private peer should load while the owner is blocked');
    if (failure === 'cancel') controller.abort(); else a.client.child.kill('SIGKILL');
    const failed = await first; assert.ok(failed.error);
    assert.ok((await second).value); assert.deepEqual(observedSurvivors(owned), []);
    await close(a);
    return { failed, descendantSurvivors: [], peer: await semantics(b) };
  });
}

try {
  console.log('[design-time] verify current production delivery before starting any Host');
  deliveryManifest = JSON.parse(await fs.readFile(path.join(repo, 'dist/delivery-manifest.json'), 'utf8'));
  const delivery = await verifyDelivery(repo, deliveryManifest);
  const gateway = JSON.parse(await fs.readFile(path.join(repo, 'dist/build-manifest.json'), 'utf8'));
  const host = path.join(repo, codeHostDirectory, 'WinCode.Code.Host.dll');
  report.build = { ...delivery, buildId: gateway.buildId, revision: deliveryManifest.revision, host, assemblyHash: hash(await fs.readFile(host)) };
  await fs.copyFile(path.join(repo, 'global.json'), path.join(root, 'global.json'));
  await fs.writeFile(path.join(root, 'NuGet.Config'), '<configuration><packageSources><clear /></packageSources></configuration>');
  if (phase === 'all' || phase === 'semantics') for (const type of ['basic', 'graph', 'wpf', 'custom', 'mixed']) {
    for (const mode of modes) {
    await trial(`semantics/${type}/${mode}`, async item => {
      const project = await fixture(root, sdk, type);
      if (type === 'custom') {
        // Match the Host's global properties: early Directory.Build.props values can otherwise differ.
        const args = ['build', path.join(project.root, project.project), '--no-restore', '--nologo',
          '-p:Configuration=Debug', `-p:TargetFramework=${project.framework}`, '-p:UseSharedCompilation=false', '-nodeReuse:false'];
        item.baselineBuilds = [runDotnet(sdk, args, repo), runDotnet(sdk, args, repo)];
      }
      const c = start(mode, project); await ready(c);
      const result = await semantics(c);
      assert.equal(result.projects, project.projects);
      assert.deepEqual(result.compilationErrors, [], JSON.stringify(result));
      return result;
    });
    }
  }
  if (phase === 'all' || phase === 'semantics') await trial('semantics/multi-framework/production', async item => {
    const p = await fixture(root, sdk, 'multi-framework', 'multi');
    const a = start('production', p), b = start('production', { ...p, framework: 'net10.0-windows', references: 2 });
    await Promise.all([ready(a), ready(b)]);
    item.frameworks = await Promise.all([semantics(a), semantics(b)]);
    assert.ok(item.frameworks.every(value => value.compilationErrors.length === 0));
    await close(b);
    item.afterPeerClose = await semantics(a);
    assert.equal(item.afterPeerClose.snapshot, item.frameworks[0].snapshot);
  });
  if (phase === 'all' || phase === 'concurrency') await concurrency();
  if (phase === 'all' || phase === 'interference') await interference();
  if (phase === 'all' || phase === 'inputs') await inputCounterexamples();
  report.completed = true;
} catch (error) { report.error = error.stack ?? String(error); process.exitCode = 1; }
finally {
  for (const c of [...live]) try { await close(c); } catch (error) { report.cleanupFailures.push(String(error)); }
  for (const auxiliary of [...auxiliaries]) try { await closeAuxiliary(auxiliary); } catch (error) { report.cleanupFailures.push(String(error)); }
  report.survivors = observedSurvivors(report.observed);
  if (report.survivors.length) { for (const p of report.survivors) terminateObserved(p); process.exitCode = 1; }
  report.productionChanged = JSON.stringify(before) !== JSON.stringify(await sourceIdentity(repo));
  try { if (deliveryManifest) await verifyDelivery(repo, deliveryManifest); }
  catch (error) { report.productionChanged = true; report.error ??= String(error); }
  report.success = report.completed && report.cases.length > 0 && report.cases.every(c => c.status === 'passed') &&
    !report.productionChanged && !report.cleanupFailures.length && !report.survivors.length;
  if (!report.success) process.exitCode = 1;
  report.finishedAt = new Date().toISOString(); await save();
  console.log(JSON.stringify({ success: report.success, completed: report.completed, cases: report.cases.map(c => ({ label: c.label, status: c.status })),
    productionChanged: report.productionChanged, report: path.join(root, 'report.json') }));
}
