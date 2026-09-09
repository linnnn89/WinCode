/**
 * 自有 Roslyn Host 的隔离验收入口：只写 test-tmp 下生成的两项目夹具。
 * 使用项目内 SDK/NuGet，验证语义结果、失败边界及进程退出；不启动 Gateway/Serena。
 * 返回非零退出码表示验收失败，详细结果和失败原因保留到夹具目录 report.json。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localSdk = path.join(repo, '.deps/dotnet-10.0.303');
await fs.access(path.join(localSdk, 'dotnet.exe'));
const dotnet = path.join(localSdk, 'dotnet.exe');
const env = { ...process.env, DOTNET_ROOT: localSdk, DOTNET_HOST_PATH: dotnet,
  DOTNET_CLI_HOME: path.join(repo, '.deps/dotnet-cli-home'), NUGET_PACKAGES: path.join(repo, '.deps/nuget-packages'),
  NUGET_HTTP_CACHE_PATH: path.join(repo, '.deps/nuget-http-cache'), DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' };
const parent = path.join(repo, 'test-tmp/roslyn-host');
await fs.mkdir(parent, { recursive: true });
const root = await fs.mkdtemp(path.join(parent, 'fixture-'));
const report = { root, scenarios: [], metrics: [], limitations: ['Generated SDK C# fixture only; checkpoints cover tracked inputs, not arbitrary external target inputs or live Gateway migration.'] };
const host = path.join(repo, 'tools/WinCode.Code.Host/bin/Release/net10.0/WinCode.Code.Host.dll');
/** 执行有 180 秒上限的 dotnet 命令；失败包含构建输出，成功返回 stdout。 */
function run(args, cwd = repo) {
  const result = spawnSync(dotnet, args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 2 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`dotnet ${args[0]} failed: ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
const code = {
  'Lib/Api.cs': 'namespace Demo;\npublic class Api {\n public static void Save(int x) {}\n public static void Save(string x) {}\n public static void Unused() {}\n}\npublic class Other { public static void Save(int x) {} }\n',
  'App/Use.cs': 'using Demo;\npublic class Use {\n public void Run() {\n  Api.Save(1);\n  Api.Save("x");\n  Other.Save(2);\n  Api.Save(3);\n }\n}\n',
  'App/Conditional.cs': '#if EXTRA\nclass Conditional { public void Run() { Demo.Api.Save(5); } }\n#endif\n',
};
/** 生成固定 TFM/语言版本的测试项目；extra 仅来自本脚本内置 XML。 */
const project = (extra = '') => `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><LangVersion>13.0</LangVersion><EnableNETAnalyzers>false</EnableNETAnalyzers></PropertyGroup>${extra}</Project>`;
for (const directory of ['Lib', 'App']) await fs.mkdir(path.join(root, directory));
for (const [file, content] of Object.entries(code)) await fs.writeFile(path.join(root, file), content);
await fs.writeFile(path.join(root, 'Lib/Lib.csproj'), project());
await fs.writeFile(path.join(root, 'App/App.csproj'), project('<ItemGroup><ProjectReference Include="../Lib/Lib.csproj" /></ItemGroup>'));
const args = [host, '--allow-project-evaluation', root, path.join(root, 'App/App.csproj'), 'Debug', 'net10.0'];
let child;
let exit;
/**
 * 启动一个测试所有的 Host；next 按顺序取单行 JSON，exited 等待进程退出。
 * stderr 仅保留最后 16 Ki 字符。调用方必须在 finally 中关闭或回收 process。
 * 该驱动不是生产适配器；生产接入须另行处理并发、主动取消和崩溃恢复。
 */
function startHost() {
  const process = spawn(dotnet, args, { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const exited = new Promise(resolve => process.once('exit', (code, signal) => resolve({ code, signal })));
  let stderr = '';
  process.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16384); });
  const queue = [];
  const waiters = [];
  createInterface({ input: process.stdout }).on('line', line => {
    let value;
    try { value = JSON.parse(line); } catch { value = { invalidProtocol: line }; }
    const waiter = waiters.shift();
    if (waiter) waiter(value); else queue.push(value);
  });
  /** 等待下一帧；超时移除自身等待项，避免下一帧错误地交给过期请求。 */
  const next = (milliseconds = 30000) => new Promise((resolve, reject) => {
    if (queue.length) { resolve(queue.shift()); return; }
    const accept = value => { clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => {
      const index = waiters.indexOf(accept);
      if (index >= 0) waiters.splice(index, 1);
      reject(new Error(`Host response timeout: ${stderr}`));
    }, milliseconds);
    waiters.push(accept);
  });
  return { process, exited, next, stderr: () => stderr };
}
/**
 * 只读抓取给定 PID 及后代的身份；退出检查同时比对 CreationDate，避免 PID 复用误判。
 * PowerShell 命令只插入经过正整数校验的 PID，不插入路径或任意用户文本。
 */
function ownedProcesses(pid) {
  assert.ok(Number.isInteger(pid) && pid > 0);
  const command = `$all = @(Get-CimInstance Win32_Process); $ids = @(${pid}); do { $more = @($all | Where-Object { $_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids }); $ids += @($more | ForEach-Object { $_.ProcessId }) } while ($more.Count -gt 0); @($all | Where-Object { $_.ProcessId -in $ids } | Select-Object ProcessId,ParentProcessId,CreationDate,Name,CommandLine) | ConvertTo-Json -Compress`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout || '[]');
  return Array.isArray(value) ? value : [value];
}
try {
  // Only Host and generated fixture dependencies are restored, never a user's target application.
  report.hostBuild = run(['build', 'tools/WinCode.Code.Host', '-c', 'Release', '-p:RestoreLockedMode=true', '--nologo']);
  // 固定锁文件和包元数据随回执记录，便于后续核对依赖及声明的许可证。
  const dependencies = JSON.parse(await fs.readFile(path.join(repo, 'tools/WinCode.Code.Host/packages.lock.json'), 'utf8')).dependencies['net10.0'];
  report.packages = await Promise.all(Object.entries(dependencies).map(async ([name, value]) => {
    const metadata = await fs.readFile(path.join(env.NUGET_PACKAGES, name.toLowerCase(), value.resolved, `${name.toLowerCase()}.nuspec`), 'utf8');
    return { name, version: value.resolved, declaredLicense: metadata.match(/<license[^>]*>(.*?)<\/license>/s)?.[1] ?? 'unavailable' };
  }));
  report.sdkVersion = run(['--version']).trim();
  report.fixtureRestore = run(['restore', path.join(root, 'App/App.csproj'), '--nologo']);
  const denied = spawnSync(dotnet, [host, root], { cwd: repo, env, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(denied.status, 1);
  assert.match(denied.stdout, /Explicit project evaluation permission required/);
  report.scenarios.push('missing evaluation permission rejected before load');

  const started = performance.now();
  const session = startHost();
  child = session.process;
  exit = session.exited;
  const next = session.next;
  const duringLoad = ownedProcesses(child.pid);
  const ready = await next(150000);
  assert.equal(ready.type, 'ready', JSON.stringify(ready));
  assert.equal(ready.protocolVersion, 2);
  assert.equal(ready.projects, 2);
  assert.deepEqual(ready.loadDiagnostics, []);
  assert.deepEqual(ready.compilationErrors, []);
  assert.equal(ready.diskFreshnessVerified, false);
  assert.equal(ready.freshness.status, 'checked');
  let activeSnapshot = ready.snapshot;
  report.ready = ready;
  report.metrics.push({ coldReadyMs: performance.now() - started });
  report.scenarios.push('two real MSBuild projects load without compiler errors');
  let count = 0;
  /** 在指定库项目中按 UTF-16 偏移查引用；extra 用于构造受控失败样例。 */
  const query = async (position, extra = {}) => {
    const id = `query-${++count}`;
    child.stdin.write(JSON.stringify({ id, operation: 'references', snapshot: activeSnapshot,
      project: 'Lib/Lib.csproj', file: 'Lib/Api.cs', position, ...extra }) + '\n');
    const response = await next();
    assert.equal(response.id, id);
    return response;
  };
  const source = code['Lib/Api.cs'];
  const timedOut = await query(source.indexOf('Save(int'), { timeoutMs: 1 });
  assert.equal(timedOut.success, false, 'cold semantic operation should exceed the 1 ms test budget');
  assert.equal(timedOut.errorCode, 'CANCELLED');
  report.scenarios.push('1 ms cold-query budget cancels without losing the session');
  const integers = await query(source.indexOf('Save(int'));
  assert.equal(integers.success, true, JSON.stringify(integers));
  assert.equal(integers.freshness.files, ready.freshness.files);
  assert.equal(integers.freshness.fingerprint, ready.freshness.fingerprint);
  assert.equal(integers.totalReferences, 2);
  assert.deepEqual(integers.references.map(r => r.line).sort((a, b) => a - b), [4, 7]);
  for (const reference of integers.references) {
    assert.equal(reference.file.replaceAll('\\', '/'), 'App/Use.cs');
    assert.equal(reference.column, 7);
    assert.equal(code['App/Use.cs'].slice(reference.start, reference.start + reference.length), 'Save');
  }
  report.scenarios.push('integer overload resolves exact cross-project call spans and columns');
  const strings = await query(source.indexOf('Save(string'));
  assert.equal(strings.success, true);
  assert.deepEqual(strings.references.map(r => r.line), [5]);
  report.scenarios.push('string overload excludes integer overload and same-name other type');
  const empty = await query(source.indexOf('Unused'));
  assert.equal(empty.success, true);
  assert.equal(empty.totalReferences, 0);
  report.scenarios.push('valid symbol with zero references remains successful bounded evidence');
  const repeated = await query(source.indexOf('Save(int'));
  assert.deepEqual(repeated.references, integers.references);
  report.metrics.push({ firstQueryMs: integers.queryMs, warmQueryMs: repeated.queryMs, workingSetBytes: repeated.workingSetBytes });
  report.scenarios.push('warm query reuses snapshot and preserves exact evidence');
  const truncated = await query(source.indexOf('Save(int'), { limit: 1 });
  assert.equal(truncated.totalReferences, 2);
  assert.equal(truncated.references.length, 1);
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.queryComplete, false);
  report.scenarios.push('output cap preserves total and marks incomplete');
  for (const [label, extra, errorCode] of [
    ['stale snapshot', { snapshot: 'stale' }, 'SNAPSHOT_STALE'], ['outside source', { file: '../outside.cs' }, 'OUTSIDE_WORKSPACE'],
    ['invalid position', { position: -1 }, 'INVALID_ARGUMENT'], ['wrong project context', { project: 'App/App.csproj' }, 'INVALID_ARGUMENT'],
    ['invalid time budget', { timeoutMs: 0 }, 'INVALID_ARGUMENT'],
    ['fractional position', { position: 1.5 }, 'INVALID_ARGUMENT'], ['fractional time budget', { timeoutMs: 1.5 }, 'INVALID_ARGUMENT'],
  ]) {
    const rejected = await query(source.indexOf('Save(int'), extra);
    assert.equal(rejected.success, false, label);
    assert.equal(rejected.errorCode, errorCode, label);
    report.scenarios.push(`${label} rejected`);
  }
  /** 主动重载应生成新身份；默认只用于预期成功的稳定夹具状态。 */
  const reload = async () => {
    const id = `reload-${++count}`;
    child.stdin.write(JSON.stringify({ id, operation: 'reload' }) + '\n');
    const result = await next(150000);
    assert.equal(result.id, id);
    assert.equal(result.type, 'ready', JSON.stringify(result));
    assert.notEqual(result.snapshot, activeSnapshot);
    activeSnapshot = result.snapshot;
    return result;
  };
  /** 修改后立即发请求，不等待 watcher 防抖；失败必须没有旧引用载荷。 */
  const assertStale = async label => {
    const result = await query(source.indexOf('Save(int'));
    assert.equal(result.success, false, label);
    assert.ok(['SNAPSHOT_STALE', 'INPUTS_CHANGED'].includes(result.errorCode), JSON.stringify(result));
    assert.equal(result.references, undefined);
    report.scenarios.push(label);
  };
  await fs.writeFile(path.join(root, 'App/Use.cs'), code['App/Use.cs'].replace('Api.Save(3)', 'Other.Save(3)'));
  await assertStale('immediate query after source edit refuses old references');
  const firstSnapshot = activeSnapshot;
  await reload();
  assert.equal((await query(source.indexOf('Save(int'))).totalReferences, 1);
  assert.equal((await query(source.indexOf('Save(int'), { snapshot: firstSnapshot })).errorCode, 'SNAPSHOT_STALE');
  report.scenarios.push('reload reflects changed call and permanently expires old snapshot');

  await fs.writeFile(path.join(root, 'App/Extra.cs'), 'class Extra { void Run() { Demo.Api.Save(9); } }');
  await assertStale('new source file invalidates the original reference file set');
  await reload();
  const added = await query(source.indexOf('Save(int'));
  assert.equal(added.totalReferences, 2);
  assert.ok(added.references.some(item => item.file.endsWith('Extra.cs')));
  report.scenarios.push('reloaded MSBuild Compile glob includes new call sites');

  await fs.rename(path.join(root, 'App/Extra.cs'), path.join(root, 'App/Moved.cs'));
  await assertStale('renamed file invalidates old locations');
  await reload();
  const renamed = await query(source.indexOf('Save(int'));
  assert.ok(renamed.references.some(item => item.file.endsWith('Moved.cs')));
  assert.ok(renamed.references.every(item => !item.file.endsWith('Extra.cs')));
  await fs.unlink(path.join(root, 'App/Moved.cs'));
  await assertStale('deleted file invalidates old references');
  await reload();
  assert.equal((await query(source.indexOf('Save(int'))).totalReferences, 1);
  report.scenarios.push('rename and delete reloads return only current paths');

  await fs.appendFile(path.join(root, 'App/obj/project.assets.json'), '\n');
  await assertStale('obj assets changes are tracked before another query');
  await reload();
  assert.equal((await query(source.indexOf('Save(int'))).totalReferences, 1);
  await fs.writeFile(path.join(root, 'Directory.Build.props'), '<Project><PropertyGroup><DefineConstants>TRACE;EXTRA</DefineConstants></PropertyGroup></Project>');
  await assertStale('Directory.Build.props change invalidates compiled conditions');
  await reload();
  const conditional = await query(source.indexOf('Save(int'));
  assert.equal(conditional.totalReferences, 2);
  assert.ok(conditional.references.some(item => item.file.endsWith('Conditional.cs')));
  report.scenarios.push('reload applies actual MSBuild preprocessor configuration');

  const appProject = path.join(root, 'App/App.csproj');
  const originalProject = await fs.readFile(appProject, 'utf8');
  await fs.writeFile(appProject, originalProject.replace('</Project>', '<ItemGroup><Compile Remove="Conditional.cs" /></ItemGroup></Project>'));
  await assertStale('project Compile changes invalidate the loaded project graph');
  await reload();
  assert.equal((await query(source.indexOf('Save(int'))).totalReferences, 1);
  report.scenarios.push('reload respects project file exclusions');

  await fs.writeFile(appProject, '<Project');
  await assertStale('malformed project change refuses the last valid snapshot');
  child.stdin.write(JSON.stringify({ id: 'broken-reload', operation: 'reload' }) + '\n');
  const failedReload = await next(150000);
  report.failedReload = failedReload;
  assert.equal(failedReload.id, 'broken-reload');
  assert.equal(failedReload.success, false);
  assert.equal(failedReload.errorCode, 'PROJECT_LOAD_FAILED');
  assert.equal((await query(source.indexOf('Save(int'))).errorCode, 'SNAPSHOT_STALE');
  await fs.writeFile(appProject, originalProject);
  await reload();
  assert.equal((await query(source.indexOf('Save(int'))).totalReferences, 2);
  report.scenarios.push('failed reload cannot resurrect old state; repaired input recovers explicitly');

  child.stdin.write(JSON.stringify({ id: 'cancel-target', operation: 'references', snapshot: activeSnapshot,
    project: 'Lib/Lib.csproj', file: 'Lib/Api.cs', position: source.indexOf('Save(int') }) + '\n' +
    JSON.stringify({ id: 'cancel-control', operation: 'cancel', targetId: 'cancel-target' }) + '\n');
  const cancelled = new Map((await Promise.all([next(), next()])).map(result => [result.id, result]));
  assert.equal(cancelled.get('cancel-control').cancellationRequested, true);
  assert.equal(cancelled.get('cancel-target').errorCode, 'CANCELLED');
  assert.equal((await query(source.indexOf('Save(int'))).totalReferences, 2);
  report.scenarios.push('explicit cancellation reaches queued or active work without closing the session');

  // 单次突发同时检验身份冲突、排队截止和背压；每个输入都必须收到独立结果，不静默丢队列项。
  /** 构造当前夹具快照的引用请求，允许突发与 EOF 验收复用同一定位。 */
  const burstQuery = id => ({ id, operation: 'references', snapshot: activeSnapshot,
    project: 'Lib/Lib.csproj', file: 'Lib/Api.cs', position: source.indexOf('Save(int') });
  // 到期的排队 reload 必须在触碰工作区前退出；若错误地到执行时才计时，会使后续旧身份查询失败。
  const burst = [burstQuery('burst-first'), burstQuery('burst-first'),
    { id: 'burst-deadline', operation: 'reload', timeoutMs: 1 },
    ...Array.from({ length: 16 }, (_, index) => burstQuery(`burst-${index}`))];
  child.stdin.write(burst.map(request => JSON.stringify(request)).join('\n') + '\n');
  const burstResults = await Promise.all(burst.map(() => next()));
  const duplicated = burstResults.filter(result => result.id === 'burst-first');
  assert.equal(duplicated.length, 2);
  assert.equal(duplicated.filter(result => result.errorCode === 'DUPLICATE_REQUEST').length, 1);
  assert.equal(duplicated.filter(result => result.success === true).length, 1);
  report.scenarios.push('duplicate active id is rejected without cancelling its original request');
  assert.equal(burstResults.find(result => result.id === 'burst-deadline').errorCode, 'CANCELLED');
  report.scenarios.push('expired queued reload is cancelled before invalidating the valid snapshot');
  assert.ok(burstResults.some(result => result.errorCode === 'BUSY'));
  for (const request of burst.slice(2)) assert.equal(burstResults.filter(result => result.id === request.id).length, 1);
  for (const result of burstResults) {
    if (result.success) assert.equal(result.totalReferences, 2);
    else assert.ok(['CANCELLED', 'BUSY', 'DUPLICATE_REQUEST'].includes(result.errorCode));
  }
  report.queue = { submitted: burst.length, completed: burstResults.filter(result => result.success).length,
    rejectedBusy: burstResults.filter(result => result.errorCode === 'BUSY').length };
  report.scenarios.push('bounded queue reports backpressure and accounts for every submitted frame');
  child.stdin.write(JSON.stringify({ id: 'cancel-missing', operation: 'cancel', targetId: 'absent-request' }) + '\n');
  assert.equal((await next()).cancellationRequested, false);
  assert.equal((await query(source.indexOf('Save(int'))).totalReferences, 2);
  report.scenarios.push('cancelling an absent request reports no cancellation and preserves the session');

  const excessive = path.join(root, 'oversized-input.bin');
  const handle = await fs.open(excessive, 'wx');
  try { await handle.truncate(33 * 1024 * 1024); } finally { await handle.close(); }
  assert.equal((await query(source.indexOf('Save(int'))).errorCode, 'INPUT_BUDGET_EXCEEDED');
  await fs.unlink(excessive);
  await reload();
  report.scenarios.push('input byte cap rejects oversized input without accepting a partial fingerprint');

  await fs.writeFile(path.join(root, 'global.json'), JSON.stringify({ sdk: { version: '10.0.303', rollForward: 'disable' } }));
  assert.equal((await query(source.indexOf('Save(int'))).errorCode, 'HOST_RESTART_REQUIRED');
  child.stdin.write(JSON.stringify({ id: 'sdk-reload', operation: 'reload' }) + '\n');
  assert.equal((await next()).errorCode, 'HOST_RESTART_REQUIRED');
  report.scenarios.push('SDK selection changes require a new process, not an in-process reload');
  const owned = [...new Map([...duringLoad, ...ownedProcesses(child.pid)].map(p => [`${p.ProcessId}/${p.CreationDate}`, p])).values()];
  report.ownedProcesses = owned;
  report.buildHostObserved = owned.some(p => p.CommandLine?.includes('BuildHost'));
  child.stdin.write(JSON.stringify({ id: 'stop', operation: 'shutdown' }) + '\n');
  assert.equal((await next()).id, 'stop');
  const stopped = await Promise.race([exit, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Host did not exit')), 10000); timer.unref(); })]);
  assert.equal(stopped.code, 0);
  report.scenarios.push('graceful shutdown exits successfully');
  for (const ownedProcess of owned) {
    const remaining = ownedProcesses(ownedProcess.ProcessId).filter(p => p.ProcessId === ownedProcess.ProcessId && p.CreationDate === ownedProcess.CreationDate);
    assert.deepEqual(remaining, [], 'owned process survived host disposal');
  }
  report.scenarios.push('sampled owned processes are absent after shutdown; unobserved processes not claimed');
  // Design-time evaluation may create output directories without compiling an assembly.
  /** 枚举夹具输出文件（不把空目录视为编译产物）；ENOENT 表示还没有输出目录。 */
  const generatedFiles = async directory => {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    return (await Promise.all(entries.map(entry => entry.isDirectory() ? generatedFiles(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))).flat();
  };
  const outputs = (await Promise.all(['App', 'Lib'].map(project => generatedFiles(path.join(root, project, 'bin'))))).flat();
  assert.deepEqual(outputs, []);
  report.scenarios.push('design-time output directories contain no compiled target files');
  const buildFiles = await generatedFiles(path.dirname(host));
  report.buildArtifacts = { files: buildFiles.length, bytes: (await Promise.all(buildFiles.map(async file => (await fs.stat(file)).size))).reduce((a, b) => a + b, 0) };
  report.stderr = session.stderr();

  // A second generated project state cannot turn missing dependencies into complete evidence.
  await fs.appendFile(path.join(root, 'App/Use.cs'), '\nclass Broken : UnavailablePackage.MissingBase {}\n');
  const broken = startHost();
  child = broken.process;
  exit = broken.exited;
  const brokenReady = await broken.next(150000);
  assert.equal(brokenReady.type, 'ready');
  assert.ok(brokenReady.compilationErrors.some(error => error.includes('UnavailablePackage')));
  child.stdin.write(JSON.stringify({ id: 'missing-dependency', operation: 'references', snapshot: brokenReady.snapshot,
    project: 'Lib/Lib.csproj', file: 'Lib/Api.cs', position: source.indexOf('Save(int') }) + '\n');
  const incomplete = await broken.next();
  assert.equal(incomplete.success, true);
  assert.equal(incomplete.totalReferences, 2);
  assert.equal(incomplete.queryComplete, false);
  report.missingDependency = { diagnostics: brokenReady.compilationErrors, result: incomplete };
  report.scenarios.push('missing dependency retains useful references but marks incomplete');
  // EOF 必须取消并排空已接纳操作，再释放工作区；不能只验证空闲时退出。
  const closing = Array.from({ length: 3 }, (_, index) => ({ ...burstQuery(`eof-${index}`), snapshot: brokenReady.snapshot }));
  child.stdin.end(closing.map(request => JSON.stringify(request)).join('\n') + '\n');
  const closingResults = await Promise.all(closing.map(() => broken.next()));
  for (const request of closing) {
    const result = closingResults.find(item => item.id === request.id);
    assert.equal(result?.errorCode, 'CANCELLED');
    assert.equal(result?.references, undefined);
  }
  report.scenarios.push('stdin EOF cancels and drains accepted reference requests without old payloads');
  assert.equal((await Promise.race([exit, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('EOF shutdown timeout')), 10000); timer.unref(); })])).code, 0);
  report.scenarios.push('stdin EOF disposes the second workspace');
  report.success = true;
} catch (error) {
  report.success = false;
  report.failure = String(error);
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    await exit;
  }
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ success: report.success, scenarios: report.scenarios.length, failure: report.failure, report: path.join(root, 'report.json') }));
}
