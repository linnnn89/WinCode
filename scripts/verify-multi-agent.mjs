/** Bounded multi-client diagnosis using production stdio and disposable C# projects. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { resolveDotnet, runDotnet } from './lib/dotnet.mjs';
import { ownedProcesses, observedSurvivors, terminateObserved } from './lib/owned-processes.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const version = JSON.parse(await fs.readFile(path.join(repo, 'package.json'), 'utf8')).version;
const sdk = resolveDotnet(repo);
const parent = path.join(repo, 'test-tmp/multi-agent');
await fs.mkdir(parent, { recursive: true });
const root = await fs.mkdtemp(path.join(parent, 'run-'));
const report = { root, success: false, scenarios: [], findings: [], timings: [], samples: [], observed: [], warnings: [],
  limitations: ['Three fresh SDK clients model separate software processes; not the active Codex connection or a real third-party client integration.',
    'Shared-instance agents are multiplexed through one supported stdio client; stdio itself does not accept multiple client connections.',
    'Generated small projects and bounded bursts; no unlimited-load, long-term leak, concurrent source editing or native UI automation proof.'] };
const clients = [];
let auxiliaryTray;
report.mode = process.argv.includes('--boundaries-only') ? 'boundaries-only' : 'full';
const serialSameRoot = process.argv.includes('--serialize-same-root-startup');
report.startupMode = serialSameRoot ? 'different roots parallel; second same-root host starts afterward' : 'all three hosts parallel';
if (serialSameRoot) report.limitations.push('Same-project parallel cold startup is excluded in this mode: run-zJc2aM observed an MSBuild obj/editorconfig write collision. This run cannot close that N4 finding.');
let stage = 'setup';
const warningEmitters = [];
process.on('warning', warning => {
  const record = { stage, name: warning.name, message: warning.message, stack: warning.stack,
    event: warning.type, count: warning.count };
  report.warnings.push(record);
  if (warning.emitter) warningEmitters.push({ emitter: warning.emitter, record });
});
const remember = items => { for (const item of items) if (!report.observed.some(p => p.ProcessId === item.ProcessId && p.CreationDate === item.CreationDate)) report.observed.push(item); };
async function call(c, name, args = {}, options = {}) {
  const start = performance.now();
  const response = await c.client.callTool({ name, arguments: args }, { timeout: 60000, ...options });
  const data = JSON.parse(response.content[0].text);
  report.timings.push({ stage, client: c.name, tool: name, ms: performance.now() - start, errorCode: data.errorCode });
  return { error: response.isError === true, data };
}
async function ok(c, name, args = {}) {
  const r = await call(c, name, args); assert.equal(r.error, false, JSON.stringify(r.data)); return r.data;
}
async function search(c, tag = c.tag) {
  const data = await ok(c, 'wincode_find_code_symbol', { query: 'Save', kind: 'method' });
  assert.equal(data.source, 'roslyn'); assert.equal(data.symbols.length, 1);
  assert.equal(data.symbols[0].signature, `${tag}.Api.Save(int)`);
  return data.symbols[0];
}
async function references(c, target, expected) {
  const data = await ok(c, 'wincode_find_references', { symbolName: 'Save', symbolLocation: target.location });
  assert.equal(data.totalReferences, expected); return data;
}
async function sample(label) {
  const values = await Promise.all(clients.filter(c => !c.closed).map(async c => {
    const h = await ok(c, 'wincode_hello_world');
    return { name: c.name, pid: c.transport.pid, instanceId: h.runtime.instanceId, health: h.health };
  }));
  report.samples.push({ label, values });
}
async function scenario(name, work) {
  stage = name;
  console.log(`[multi-agent] ${name}`);
  const detail = await work(); report.scenarios.push({ name, passed: true, ...detail });
  for (const { emitter, record } of warningEmitters) record.listenersAfterStage = emitter.listenerCount(record.event);
  await fs.writeFile(path.join(root, 'progress.json'), JSON.stringify(report, null, 2));
}
try {
  if (report.mode === 'full') {
  const host = path.join(repo, 'tools/WinCode.Code.Host/bin/Release/net10.0/publish/WinCode.Code.Host.dll');
  for (const tag of ['A', 'B']) {
    const workspace = path.join(root, tag); await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, 'NuGet.Config'), '<configuration><packageSources><clear /></packageSources></configuration>');
    await fs.writeFile(path.join(workspace, 'App.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><EnableNETAnalyzers>false</EnableNETAnalyzers></PropertyGroup></Project>');
    await fs.writeFile(path.join(workspace, 'Api.cs'), `namespace ${tag}; public class Api { public static void Save(int x) {} } public class Use { public void Run() { Api.Save(1); ${tag === 'B' ? 'Api.Save(2);' : ''} } }`);
    await fs.writeFile(path.join(workspace, `only-${tag}.txt`), tag);
    runDotnet(sdk, ['restore', path.join(workspace, 'App.csproj'), '--nologo'], repo, 60000);
  }
  const config = path.join(root, 'roslyn.json');
  await fs.writeFile(config, JSON.stringify({ enabled: true, allowProjectEvaluation: true, project: 'App.csproj',
    configuration: 'Debug', targetFramework: 'net10.0', dotnetPath: sdk.dotnet, hostPath: host, loadTimeoutMs: 15000, queryTimeoutMs: 10000 }));
  for (const [name, tag] of [['software-one-A', 'A'], ['software-two-B', 'B'], ['software-three-A', 'A']]) {
    const c = { name, tag, stderr: '', client: new Client({ name, version: '1' }) };
    c.transport = new StdioClientTransport({ command: process.execPath,
      args: ['--trace-warnings', path.join(repo, 'dist/index.js'), '--workspace', path.join(root, tag), '--roslyn-config', config], cwd: root, env: sdk.env, stderr: 'pipe' });
    clients.push(c); await c.client.connect(c.transport);
    c.transport.stderr?.on('data', chunk => { c.stderr = (c.stderr + chunk).slice(-16384); });
  }
  const [a, b, a2] = clients;
  await scenario(serialSameRoot ? 'A/B cold bursts in parallel, then second A host; exact references in all three' : 'three independent processes: parallel cold load and exact references', async () => {
    await sample('cold');
    const cold = c => Promise.all(Array.from({ length: 4 }, () => search(c)));
    const coldBursts = serialSameRoot
      ? [...await Promise.all(clients.slice(0, 2).map(cold)), await cold(clients[2])]
      : await Promise.all(clients.map(cold));
    const targets = coldBursts.map(values => values[0]);
    for (const values of coldBursts) assert.equal(new Set(values.map(t => t.location.snapshotId)).size, 1);
    assert.equal(new Set(targets.map(t => t.location.snapshotId)).size, 3);
    await Promise.all(clients.map((c, i) => references(c, targets[i], c.tag === 'A' ? 1 : 2)));
    clients.forEach((c, i) => { c.target = targets[i]; c.tree = ownedProcesses(c.transport.pid); remember(c.tree); });
    await sample('warm');
    assert.equal(new Set(report.samples.at(-1).values.map(v => v.instanceId)).size, 3);
  });
  await scenario('cross-instance snapshot rejection, including two processes on the same project', async () => {
    const codes = [];
    for (const c of [b, a2]) {
      const result = await call(c, 'wincode_find_references', { symbolName: 'Save', symbolLocation: a.target.location });
      assert.equal(result.error, true); assert.equal(result.data.errorCode, 'SNAPSHOT_STALE'); codes.push(result.data.errorCode);
      assert.equal((await search(c)).location.snapshotId, c.target.location.snapshotId);
    }
    return { codes };
  });
  await scenario('96 interleaved exact reference requests across three processes', async () => {
    await Promise.all(Array.from({ length: 32 }, () => Promise.all(clients.map(c => references(c, c.target, c.tag === 'A' ? 1 : 2)))));
    await sample('after-96');
    for (const c of clients) assert.equal((await search(c)).location.snapshotId, c.target.location.snapshotId);
  });
  await scenario('ordinary 4/8/16 bursts preserve FIFO capacity and the warm semantic snapshot', async () => {
    for (const count of [4, 8, 16]) {
      const values = await Promise.all(Array.from({ length: count }, () => search(a)));
      assert.ok(values.every(value => value.location.snapshotId === a.target.location.snapshotId));
    }
    const health = (await ok(a, 'wincode_hello_world')).health;
    assert.equal(health.admission.business.active, 0); assert.equal(health.admission.business.rejected, 0);
    return { bursts: [4, 8, 16], admission: health.admission };
  });
  await scenario('128 semantic calls have bounded admission while sibling traffic remains usable', async () => {
    const work = Promise.all(Array.from({ length: 128 }, () => call(a, 'wincode_find_code_symbol', { query: 'Save', kind: 'method' })));
    const health = await ok(a, 'wincode_hello_world');
    const [values] = await Promise.all([work, search(b), search(a2)]);
    const accepted = values.filter(value => !value.error), busy = values.filter(value => value.error);
    assert.equal(accepted.length, 32); assert.equal(busy.length, 96);
    for (const value of accepted) assert.equal(value.data.symbols[0].location.snapshotId, a.target.location.snapshotId);
    for (const value of busy) {
      assert.equal(value.data.errorCode, 'SERVER_BUSY'); assert.equal(value.data.workStarted, false); assert.equal(value.data.retryable, true);
    }
    assert.ok(health.health.admission.business.active <= 32);
    await sample('after-128');
    const after = (await ok(a, 'wincode_hello_world')).health.admission;
    assert.equal(after.business.active, 0); assert.equal(after.business.waiting, 0); assert.equal(after.business.peakActive, 32);
    return { sampledInFlight: health.health.inFlightRequests, accepted: accepted.length, busy: busy.length, admission: after };
  });
  await scenario('64-request burst with 16 cancellations preserves sibling work and warm snapshots', async () => {
    const controls = Array.from({ length: 64 }, () => new AbortController());
    // Attach rejection handlers before issuing cancellation to avoid harness-level unhandled promises.
    const pending = controls.map((ctl, i) => call(a, 'wincode_find_code_symbol', { query: 'Save', kind: 'method' }, { signal: ctl.signal })
      .then(r => ({ index: i, response: r }), e => ({ index: i, rejected: String(e) })));
    controls.forEach((ctl, i) => { if (i % 4 === 0) ctl.abort(); });
    const values = await Promise.all(pending);
    for (const v of values.filter(v => v.index % 4 !== 0)) {
      assert.ok(v.response, JSON.stringify(v));
      if (v.response.error) { assert.equal(v.response.data.errorCode, 'SERVER_BUSY'); assert.equal(v.response.data.workStarted, false); }
      else assert.equal(v.response.data.symbols[0].signature, 'A.Api.Save(int)');
    }
    for (const c of clients) assert.equal((await search(c)).location.snapshotId, c.target.location.snapshotId);
    return { requestedCancellations: 16, clientCancellations: values.filter(v => v.rejected).length,
      completed: values.filter(v => v.response && !v.response.error).length,
      busy: values.filter(v => v.response?.data.errorCode === 'SERVER_BUSY').length };
  });
  await scenario('shared-instance interleaving: wrong-root open is rejected and A still queries A', async () => {
    await ok(a, 'workspace_open', { path: path.join(root, 'A') });
    const before = await search(a);
    const rejected = await call(a, 'workspace_open', { path: path.join(root, 'B') });
    assert.equal(rejected.error, true); assert.equal(rejected.data.errorCode, 'WORKSPACE_MISMATCH');
    const after = await ok(a, 'wincode_find_code_symbol', { query: 'Save', kind: 'method' });
    assert.equal(after.symbols[0].signature, 'A.Api.Save(int)');
    assert.equal(after.symbols[0].location.snapshotId, before.location.snapshotId);
    await references(a, before, 1);
    const directory = await ok(a, 'wincode_list_directory', { path: '.' });
    assert.ok(JSON.stringify(directory).includes('only-A.txt'));
    assert.ok(!JSON.stringify(directory).includes('only-B.txt'));
    assert.equal((await search(a2)).location.snapshotId, a2.target.location.snapshotId);
    report.findings.push({ id: 'shared-workspace-context', observed: false, expectedAgentProject: 'A', actualSignature: after.symbols[0].signature,
      rejection: rejected.data.errorCode, description: 'Fixed startup binding rejects the other project before mutation; names, relative paths and existing A locations remain in A.' });
    return { directory };
  });
  await scenario('same-path workspace_open preserves a healthy warm Host', async () => {
    const target = await search(a);
    const before = ownedProcesses(a.transport.pid); remember(before);
    const oldHost = before.filter(p => p.ParentProcessId === a.transport.pid && p.CommandLine?.includes(host));
    assert.equal(oldHost.length, 1);
    await ok(a, 'workspace_open', { path: path.join(root, 'A') });
    const hello = await ok(a, 'wincode_hello_world');
    assert.equal(hello.health.roslyn.processAlive, true);
    assert.equal(observedSurvivors(oldHost).length, 1);
    const next = await search(a); remember(ownedProcesses(a.transport.pid));
    assert.equal(next.location.snapshotId, target.location.snapshotId);
    report.findings.push({ id: 'same-workspace-reopen', observed: false, oldHostPid: oldHost[0].ProcessId,
      beforeSnapshot: target.location.snapshotId, afterSnapshot: next.location.snapshotId,
      description: 'Repeated opening of the same healthy workspace preserves its live Host and snapshot.' });
  });
  await scenario('closing one client leaves the other processes and snapshots usable', async () => {
    await a.client.close(); a.closed = true;
    for (const c of [b, a2]) {
      assert.equal((await search(c)).location.snapshotId, c.target.location.snapshotId);
      await references(c, c.target, c.tag === 'A' ? 1 : 2);
    }
    await sample('one-client-closed');
  });
  }
  await scenario('installed SDK transport rejects an oversized unfinished frame and closes the channel', async () => {
    const input = new PassThrough(), output = new PassThrough();
    const transport = new StdioServerTransport(input, output);
    const errors = [], messages = []; let closed = false;
    transport.onerror = e => errors.push(String(e)); transport.onmessage = m => messages.push(m);
    transport.onclose = () => { closed = true; };
    await transport.start();
    try {
      // 10 MiB + 64 KiB, streamed in bounded chunks; isolates framing from application and actual clients.
      const chunk = Buffer.alloc(65536, 120);
      for (let i = 0; i < 161; i++) if (!input.write(chunk)) await once(input, 'drain');
      input.write('\n' + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(errors.length, 1); assert.match(errors[0], /maximum size of 10485760 bytes/);
      assert.equal(messages.length, 0); assert.equal(closed, true);
      return { layer: 'installed SDK transport with in-memory streams', submittedBytes: 161 * chunk.length, closed, errors };
    } finally { await transport.close(); input.destroy(); output.destroy(); }
  });
  await scenario('native Tray accepts eight registrations, rejects the ninth, and recovers a freed slot', async () => {
    const folder = path.join(root, 'tray-capacity'); await fs.mkdir(folder);
    const tray = spawn(path.join(repo, 'tools/WinCode.Tray/bin/Release/net10.0-windows/win-x64/publish/WinCode.Tray.exe'), ['--workflow-test', folder],
      { cwd: repo, env: sdk.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    auxiliaryTray = tray;
    const exit = once(tray, 'exit'), sockets = [];
    let stderr = '';
    tray.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
    const start = await new Promise((resolve, reject) => {
      let text = ''; const timer = setTimeout(() => reject(new Error('Capacity Tray startup timeout')), 10000);
      tray.stdout.on('data', chunk => { text += chunk; if (text.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(text.split('\n')[0])); } catch (e) { reject(e); } } });
      exit.then(([code]) => { clearTimeout(timer); reject(new Error(`Capacity Tray exited: ${code}: ${stderr}`)); }, reject);
    });
    remember(ownedProcesses(tray.pid));
    async function peer(show = false) {
      const id = randomUUID();
      const socket = net.createConnection(`\\\\.\\pipe\\${start.pipeName}`); sockets.push(socket);
      const ack = await new Promise((resolve, reject) => {
        let text = ''; const timer = setTimeout(() => { socket.destroy(); reject(new Error('Capacity handshake timeout')); }, 5000);
        socket.on('error', e => { clearTimeout(timer); reject(e); });
        socket.on('connect', () => socket.write(JSON.stringify(show ? { v: 1, type: 'show' } : {
          v: 1, type: 'register', instanceId: id, pid: process.pid, version, buildId: 'capacity-fixture',
          status: { workspace: folder, provider: 'local-text', state: 'idle', automaticRelease: false, roslynLoaded: false },
        }) + '\n'));
        socket.on('data', chunk => {
          text += chunk;
          let line;
          while ((line = text.indexOf('\n')) >= 0) {
            const value = JSON.parse(text.slice(0, line)); text = text.slice(line + 1);
            if (value.type === 'request') socket.write(JSON.stringify({ v: 1, type: 'response', id: value.id, instanceId: id,
              result: { workspace: folder, provider: 'local-text', state: 'idle', automaticRelease: false, roslynLoaded: false } }) + '\n');
            else { clearTimeout(timer); resolve(value); }
          }
        });
      });
      return { socket, ack };
    }
    try {
      const peers = [];
      for (let i = 0; i < 8; i++) { const p = await peer(); assert.equal(p.ack.type, 'register-accepted', JSON.stringify(p.ack)); peers.push(p); }
      const ninth = await peer(); assert.equal(ninth.ack.type, 'register-rejected'); assert.match(ninth.ack.message, /八/); ninth.socket.destroy();
      const show = await peer(true); assert.equal(show.ack.type, 'show-accepted'); show.socket.destroy();
      const closed = once(peers[0].socket, 'close'); peers[0].socket.destroy(); await closed;
      // Barrier: a file-driven native refresh sees the disconnected peer before re-registering.
      await fs.writeFile(path.join(folder, 'command-1.json.tmp'), JSON.stringify({ operation: 'refresh' }));
      await fs.rename(path.join(folder, 'command-1.json.tmp'), path.join(folder, 'command-1.json'));
      const deadline = Date.now() + 12000;
      while (true) {
        try { await fs.readFile(path.join(folder, 'reply-1.json')); break; }
        catch (e) { if (e.code !== 'ENOENT' || Date.now() > deadline) throw e; await new Promise(resolve => setTimeout(resolve, 25)); }
      }
      const replacement = await peer(); assert.equal(replacement.ack.type, 'register-accepted');
      return { layer: 'real native secured pipe; nine channels from one test process, not nine actual MCPs', accepted: 8,
        ninth: ninth.ack, fullCapacityShow: show.ack.type, replacement: replacement.ack.type };
    } finally {
      sockets.forEach(s => s.destroy());
      if (tray.exitCode == null && tray.signalCode == null) tray.kill(); await exit;
    }
  });
  report.success = true;
} catch (error) { report.error = error.stack ?? String(error); process.exitCode = 1; }
finally {
  if (auxiliaryTray && auxiliaryTray.exitCode == null && auxiliaryTray.signalCode == null) {
    const exit = once(auxiliaryTray, 'exit'); auxiliaryTray.kill(); await exit;
  }
  for (const c of clients) {
    if (c.transport.pid) remember(ownedProcesses(c.transport.pid));
    if (!c.closed) await c.client.close().catch(error => { report.cleanupError = String(error); report.success = false; process.exitCode = 1; });
  }
  report.survivors = observedSurvivors(report.observed);
  if (report.survivors.length) { report.success = false; process.exitCode = 1; report.survivors.forEach(terminateObserved); }
  report.stderr = clients.map(c => ({ name: c.name, text: c.stderr }));
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`[multi-agent] ${report.success ? 'diagnosis completed' : 'failed'}: ${path.join(root, 'report.json')}`);
}
