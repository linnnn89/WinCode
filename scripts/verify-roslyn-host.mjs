import { verifySemantics, verifyQueue } from './roslyn/host-semantics.mjs';
import { verifyInputChanges, verifyBudgetsAndEncoding } from './roslyn/host-inputs.mjs';
/**
 * 自有 Roslyn Host 的隔离验收入口：只写 test-tmp 下生成的两项目夹具。
 * 使用项目内 SDK/NuGet，验证语义结果、失败边界及进程退出；不启动 Gateway/Local text。
 * 返回非零退出码表示验收失败，详细结果和失败原因保留到夹具目录 report.json。
 */
import assert from 'node:assert/strict';
import { resolveDotnet, runDotnet } from './lib/dotnet.mjs';
import { ownedProcesses } from './lib/owned-processes.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const toolchain = resolveDotnet(repo);
const { dotnet, env } = toolchain;
const run = (args, cwd = repo) => runDotnet(toolchain, args, cwd);
const parent = path.join(repo, 'test-tmp/roslyn-host');
await fs.mkdir(parent, { recursive: true });
const root = await fs.mkdtemp(path.join(parent, 'fixture-'));
const report = { root, scenarios: [], metrics: [], limitations: ['Generated SDK C# fixture only; checkpoints cover tracked inputs, not arbitrary external target inputs or live Gateway migration.'] };
const host = path.join(repo, 'tools/WinCode.Code.Host/bin/Release/net10.0/WinCode.Code.Host.dll');

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
await fs.mkdir(path.join(root, 'build-inputs'));
await fs.writeFile(path.join(root, 'build-inputs/custom.rules'), '<Project />');
await fs.writeFile(path.join(root, 'schema.yaml'), 'mode: original\n');
await fs.writeFile(path.join(root, 'App/details.data'), 'additional document\n');
await fs.writeFile(path.join(root, 'App/App.csproj'), project('<ItemGroup><ProjectReference Include="../Lib/Lib.csproj" /><AdditionalFiles Include="details.data" /></ItemGroup><Import Project="../build-inputs/custom.rules" />'));
const additionalInputs = ['schema.yaml', 'build-inputs/custom.rules'];
const args = [host, '--allow-project-evaluation', root, path.join(root, 'App/App.csproj'), 'Debug', 'net10.0', JSON.stringify(additionalInputs)];
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
  for (const field of [4, 5]) for (const value of ['.', '..', 'Debug.', 'Debug ', 'x;y', '$(Configuration)', '%2e%2e', '@(Compile)']) {
    const invalidArgs = [...args]; invalidArgs[field] = value;
    const rejected = spawnSync(dotnet, invalidArgs, { cwd: repo, env, input: '', encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(rejected.error, undefined);
    assert.equal(rejected.status, 1, `${field}: ${value}`);
    assert.equal(JSON.parse(rejected.stdout.trim()).errorCode, 'INVALID_ARGUMENT');
    for (const directory of [root, path.join(root, 'App'), path.join(root, 'Lib')])
      await assert.rejects(fs.stat(path.join(directory, '.cache')), { code: 'ENOENT' });
  }
  report.scenarios.push('nonliteral configuration and framework segments are rejected without private output side effects');
  for (const [label, inputs, errorCode] of [
    ['outside additional input', ['../outside.yaml'], 'OUTSIDE_WORKSPACE'],
    ['wildcard additional input', ['*.yaml'], 'INVALID_ARGUMENT'],
    ['duplicate additional input', ['schema.yaml', './schema.yaml'], 'INVALID_ARGUMENT'],
    ['missing additional input', ['missing.yaml'], 'INPUT_UNAVAILABLE'],
    ['directory additional input', ['App'], 'INPUT_UNAVAILABLE'],
  ]) {
    const rejected = spawnSync(dotnet, [...args.slice(0, -1), JSON.stringify(inputs)], { cwd: repo, env, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(rejected.status, 1, label);
    assert.equal(JSON.parse(rejected.stdout.trim()).errorCode, errorCode, label);
    report.scenarios.push(`${label} rejected before project loading`);
  }

  const started = performance.now();
  const session = startHost();
  child = session.process;
  exit = session.exited;
  const next = session.next;
  const duringLoad = ownedProcesses(child.pid);
  const ready = await next(150000);
  assert.equal(ready.type, 'ready', JSON.stringify(ready));
  assert.equal(ready.protocolVersion, 2);
  assert.equal(ready.inputPolicy.version, 2);
  assert.deepEqual(ready.inputPolicy.additionalInputs.map(file => file.replaceAll('\\', '/')), additionalInputs);
  assert.equal(ready.freshness.scope, 'compilation-inputs-and-explicit-files');
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
  const burstQuery = id => ({ id, operation: 'references', snapshot: activeSnapshot,
    project: 'Lib/Lib.csproj', file: 'Lib/Api.cs', position: source.indexOf('Save(int') });
  const scenario = { root, source, code, child, next, query, reload, assertStale, report, ready, burstQuery,
    get snapshot() { return activeSnapshot; }, nextId: () => ++count };
  // 场景有显式前置状态；不为拆文件而改变执行顺序或并发修改同一夹具。
  await verifySemantics(scenario);
  await verifyInputChanges(scenario);
  await verifyQueue(scenario);
  await verifyBudgetsAndEncoding(scenario);

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
