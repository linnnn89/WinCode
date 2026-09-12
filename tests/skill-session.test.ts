import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { WinCodeSession } from '../src/Client/SkillSession.js';
import { withTimeout } from '../src/Core/ResourceManager.js';

const repo = path.resolve(import.meta.dirname, '..'), temporary = path.join(repo, 'test-tmp');
const cli = path.join(repo, 'dist/Client/SkillSessionCli.js');
const { ownedProcesses, observedSurvivors, terminateObserved } = await import(pathToFileURL(path.join(repo, 'scripts/lib/owned-processes.mjs')).href);
const { resolveDotnet, runDotnet } = await import(pathToFileURL(path.join(repo, 'scripts/lib/dotnet.mjs')).href);
const payload = (result: any) => JSON.parse(result.content.find((item: any) => item.type === 'text').text);

async function fixture(roslyn = false) {
  await fs.mkdir(temporary, { recursive: true });
  const root = await fs.mkdtemp(path.join(temporary, 'skill-session-test-'));
  await fs.writeFile(path.join(root, 'Probe.ts'), 'export function coldProbe() { return 7; }\n');
  let config: string | undefined;
  if (roslyn) {
    const sdk = resolveDotnet(repo);
    await fs.writeFile(path.join(root, 'Probe.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><EnableNETAnalyzers>false</EnableNETAnalyzers></PropertyGroup></Project>');
    await fs.writeFile(path.join(root, 'Probe.cs'), 'public static class Api { public static void Save() {} }\nclass Use { void Run() { Api.Save(); } }\n');
    await fs.copyFile(path.join(repo, 'global.json'), path.join(root, 'global.json'));
    const emptySource = path.join(root, 'empty-source'); await fs.mkdir(emptySource);
    runDotnet(sdk, ['restore', path.join(root, 'Probe.csproj'), '--source', emptySource, '--nologo'], root, 30000);
    config = path.join(root, 'roslyn.json');
    await fs.writeFile(config, JSON.stringify({ enabled: true, allowProjectEvaluation: true, project: 'Probe.csproj',
      configuration: 'Debug', targetFramework: 'net10.0', dotnetPath: sdk.dotnet,
      hostPath: path.join(repo, 'tools/WinCode.Code.Host/bin/Release/net10.0/publish/WinCode.Code.Host.dll') }));
  }
  return { root, config, remove: async () => {
    assert.equal(path.dirname(path.resolve(root)), temporary);
    await fs.rm(root, { recursive: true, force: true });
  } };
}

function startCli(root: string, config?: string) {
  const child = spawn(process.execPath, [cli, '--workspace', root, ...(config ? ['--roslyn-config', config] : [])],
    { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const messages: any[] = []; let output = '', error = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    output += chunk;
    let end;
    while ((end = output.indexOf('\n')) >= 0) { messages.push(JSON.parse(output.slice(0, end))); output = output.slice(end + 1); }
  });
  child.stderr.on('data', chunk => { error = (error + chunk.toString()).slice(-8192); });
  const exited = new Promise<number | null>(resolve => child.once('close', code => resolve(code)));
  const wait = async (match: (value: any) => boolean) => {
    const deadline = Date.now() + 30000;
    while (!messages.some(match)) {
      assert.ok(Date.now() < deadline && child.exitCode === null, `Missing response: ${error}\n${JSON.stringify(messages)}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return messages.find(match);
  };
  return { child, exited, wait, send: (value: unknown) => child.stdin.write(JSON.stringify(value) + '\n') };
}

async function stopChild(child: ChildProcessWithoutNullStreams, exited: Promise<number | null>) {
  child.stdin.end();
  try { await withTimeout(exited, 10000, 'Skill CLI exit'); }
  catch (error) { if (child.exitCode === null && child.signalCode === null) child.kill(); throw error; }
}

it('Skill entry stays cold until a call, reuses its Gateway and preserves MCP errors and results', { timeout: 45000 }, async () => {
  const f = await fixture(), driver = startCli(f.root);
  let processes: any[] = [];
  try {
    const ready = await driver.wait(value => value.ready);
    assert.equal(ready.status.state, 'unused'); assert.equal(ready.status.pid, null);
    const unused = ownedProcesses(driver.child.pid);
    // Windows may attach a console host even with redirected pipes; it is not a WinCode runtime.
    assert.deepEqual(unused.filter((p: any) => p.ProcessId !== driver.child.pid && p.Name.toLowerCase() !== 'conhost.exe'), [],
      `merely opening the entry must not spawn a Gateway: ${JSON.stringify(unused)}`);
    assert.equal((await fs.readdir(f.root)).some(file => file === '.cache'), false);
    driver.send({ id: 'status', action: 'status' });
    assert.equal((await driver.wait(value => value.id === 'status')).status.pid, null);
    driver.send({ id: 'find', tool: 'wincode_search_text', arguments: { query: 'coldProbe', scopePaths: ['Probe.ts'] } });
    const found = await driver.wait(value => value.id === 'find');
    assert.equal(payload(JSON.parse(await fs.readFile(found.resultFile, 'utf8'))).returnedItems, 1);
    driver.send({ id: 'identity', action: 'status' });
    const identity = (await driver.wait(value => value.id === 'identity')).status;
    driver.send({ id: 'mismatch', tool: 'workspace_open', arguments: { path: repo } });
    const rejected = await driver.wait(value => value.id === 'mismatch');
    assert.equal(rejected.isError, true);
    assert.equal(payload(JSON.parse(await fs.readFile(rejected.resultFile, 'utf8'))).errorCode, 'WORKSPACE_MISMATCH');
    driver.send({ id: 'again', tool: 'wincode_file_outline', arguments: { file: 'Probe.ts' } });
    const again = await driver.wait(value => value.id === 'again');
    assert.equal(payload(JSON.parse(await fs.readFile(again.resultFile, 'utf8'))).symbols[0].name, 'coldProbe');
    driver.send({ id: 'after', action: 'status' });
    const after = (await driver.wait(value => value.id === 'after')).status;
    assert.equal(after.pid, identity.pid); assert.deepEqual(after.identity, identity.identity);
    processes = ownedProcesses(driver.child.pid);
    driver.send({ id: 'end', action: 'close' });
    assert.equal((await driver.wait(value => value.id === 'end')).closed, true);
    assert.equal(await withTimeout(driver.exited, 8000, 'Skill normal close'), 0);
    assert.deepEqual(observedSurvivors(processes), []);
  } finally { await stopChild(driver.child, driver.exited); await f.remove(); }
});

it('one Skill session preserves a real Roslyn snapshot across calls and rejects expired locations', { timeout: 60000 }, async () => {
  const f = await fixture(true), session = new WinCodeSession({ workspace: f.root, roslynConfig: f.config });
  const preCancelled = AbortSignal.abort(new Error('cancel before use'));
  let processes: any[] = [];
  try {
    await assert.rejects(session.call('wincode_find_code_symbol', { query: 'Save' }, { signal: preCancelled }), /cancel before use/);
    assert.equal(session.status.pid, null);
    const [symbols, hello] = await Promise.all([session.call('wincode_find_code_symbol', { query: 'Save' }), session.call('wincode_hello_world')]);
    const selected = payload(symbols).symbols.find((item: any) => item.name === 'Save');
    assert.ok(selected?.location);
    const before = session.status;
    assert.equal(before.identity?.instanceId, payload(hello).runtime.instanceId);
    const refs = payload(await session.call('wincode_find_references', { symbolName: 'Save', symbolLocation: selected.location }));
    assert.equal(refs.references.length, 1);
    assert.equal(session.status.pid, before.pid);
    await fs.appendFile(path.join(f.root, 'Probe.cs'), 'class Extra { void Run() { Api.Save(); } }\n');
    const stale = await session.call('wincode_find_references', { symbolName: 'Save', symbolLocation: selected.location });
    assert.equal(stale.isError, true); assert.equal(payload(stale).errorCode, 'SNAPSHOT_STALE');
    const refreshed = payload(await session.call('wincode_find_code_symbol', { query: 'Save' })).symbols.find((item: any) => item.name === 'Save');
    assert.equal(payload(await session.call('wincode_find_references', { symbolName: 'Save', symbolLocation: refreshed.location })).references.length, 2);
    assert.notEqual(refreshed.location.snapshotId, selected.location.snapshotId);
    processes = ownedProcesses(session.status.pid);
    await session.close(); await session.close();
    assert.deepEqual(observedSurvivors(processes), []);
    await assert.rejects(session.call('wincode_find_references', { symbolName: 'Save', symbolLocation: refreshed.location }), /closed/);
  } finally { await session.close(); await f.remove(); }
});

it('cancelling real MSBuild work and killing the Skill owner reclaim the observed process tree', { timeout: 90000 }, async () => {
  const f = await fixture(true), driver = startCli(f.root, f.config);
  let observed: any[] = [];
  try {
    await driver.wait(value => value.ready);
    const blocker = path.join(f.root, '.cache', 'blocker.mjs'), marker = path.join(f.root, '.cache', 'blocked');
    await fs.mkdir(path.dirname(blocker), { recursive: true });
    await fs.writeFile(blocker, "import fs from 'node:fs'; fs.writeFileSync(process.argv[2], String(process.pid)); setInterval(()=>{},1000);\n");
    const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
    const project = path.join(f.root, 'Probe.csproj');
    const original = await fs.readFile(project, 'utf8');
    const target = `<Target Name="SkillBlock" BeforeTargets="CoreCompile" Condition="'$(DesignTimeBuild)' == 'true'"><Exec Command="${escape(`"${process.execPath}" "${blocker}" "${marker}"`)}" /></Target>`;
    await fs.writeFile(project, original.replace('</Project>', target + '</Project>'));
    driver.send({ id: 'blocked', tool: 'wincode_find_code_symbol', arguments: { query: 'Save' } });
    const deadline = Date.now() + 30000;
    while (!(await fs.stat(marker).catch(() => null))) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 25)); }
    observed = ownedProcesses(driver.child.pid);
    assert.ok(observed.some((p: any) => p.CommandLine?.includes('BuildHost')));
    assert.ok(observed.some((p: any) => p.CommandLine?.includes(blocker)));
    driver.send({ id: 'cancel', action: 'cancel', targetId: 'blocked' });
    assert.equal((await driver.wait(value => value.id === 'cancel')).cancellationRequested, true);
    assert.match((await driver.wait(value => value.id === 'blocked')).transportError, /cancel/i);
    // Parent death closes the Gateway's stdin; the Gateway/Native owner guards must finish actual cleanup.
    driver.child.kill('SIGKILL');
    await withTimeout(driver.exited, 10000, 'Skill owner crash');
    const end = Date.now() + 12000;
    let survivors = observedSurvivors(observed);
    while (survivors.length && Date.now() < end) { await new Promise(resolve => setTimeout(resolve, 100)); survivors = observedSurvivors(observed); }
    assert.deepEqual(survivors, []);
  } finally {
    for (const survivor of observedSurvivors(observed)) terminateObserved(survivor);
    await stopChild(driver.child, driver.exited); await f.remove();
  }
});
