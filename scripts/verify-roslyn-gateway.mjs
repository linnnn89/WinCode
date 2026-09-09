/**
 * 直接 Roslyn 的真实 stdio MCP 验收。只生成/求值 test-tmp 下两套 C# 项目，保留失败与进程证据。
 * 依赖项目内已批准 SDK 与已构建 Gateway/Code Host；不安装、不运行真实用户项目或目标应用。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sdk = path.join(repo, '.deps/dotnet-10.0.303');
const dotnet = path.join(sdk, 'dotnet.exe');
const host = path.join(repo, 'tools/WinCode.Code.Host/bin/Release/net10.0/WinCode.Code.Host.dll');
const env = { ...process.env, DOTNET_ROOT: sdk, DOTNET_HOST_PATH: dotnet, DOTNET_CLI_HOME: path.join(repo, '.deps/dotnet-cli-home'),
  NUGET_PACKAGES: path.join(repo, '.deps/nuget-packages'), NUGET_HTTP_CACHE_PATH: path.join(repo, '.deps/nuget-http-cache'),
  DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' };
const parent = path.join(repo, 'test-tmp/roslyn-gateway');
await fs.mkdir(parent, { recursive: true });
const root = await fs.mkdtemp(path.join(parent, 'run-'));
const report = { root, scenarios: [], processes: [], success: false,
  limitations: ['Generated C# projects and a fresh local stdio client; not the currently configured Codex connection or a clean machine release test.'] };
const library = 'namespace Demo;\npublic partial class Api { public static void Save(int x) {} public static void Save(string x) {} public static void Unused() {} }\npublic class Other { public static void Save(int x) {} }\n';
const calls = tag => `using Demo;\n// 😀 中文 UTF-16 ${tag}\npublic class Use { public void Run() { Api.Save(1); Api.Save("x"); Other.Save(2); ${tag === 'A' ? 'Api.Save(3);' : ''} } }\n// Api.Save(777)\n`;
const project = '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><LangVersion>13.0</LangVersion><EnableNETAnalyzers>false</EnableNETAnalyzers></PropertyGroup>EXTRA</Project>';
const appProject = project.replace('EXTRA', '<ItemGroup><ProjectReference Include="../Lib/Lib.csproj" /></ItemGroup>');
let transport;
let client;
let stderr = '';

/** 执行限定时长的本地 SDK 命令；失败保留输出，不把失败当成缺包后自动安装。 */
function dotnetRun(args) {
  const result = spawnSync(dotnet, args, { cwd: repo, env, windowsHide: true, encoding: 'utf8', timeout: 120000 });
  assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

/** 获取测试所有进程树；只拼接经正整数校验的 PID，记录创建时间以排除 PID 复用。 */
function owned(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const command = `$all = @(Get-CimInstance Win32_Process); $ids = @(${pid}); do { $more = @($all | Where-Object { $_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids }); $ids += @($more | ForEach-Object { $_.ProcessId }) } while ($more.Count -gt 0); @($all | Where-Object { $_.ProcessId -in $ids } | Select-Object ProcessId,ParentProcessId,CreationDate,Name,CommandLine) | ConvertTo-Json -Compress`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout || '[]');
  return Array.isArray(value) ? value : [value];
}

/** 每个进程按 PID/创建时间核对退出；不终止不属于本次测试的对象。 */
function assertExited(processes) {
  for (const process of processes) assert.ok(!owned(process.ProcessId).some(current => current.ProcessId === process.ProcessId && current.CreationDate === process.CreationDate), `Owned process survived: ${process.ProcessId}`);
}

/** 工作区切换只关闭 Code Host 子树；Gateway 自己的控制台宿主应保持到 Gateway 退出。 */
function codeProcesses() {
  const all = owned(transport.pid);
  const code = all.find(item => item.CommandLine?.includes(host));
  assert.ok(code, 'Owned Code Host is missing.');
  return owned(code.ProcessId);
}

/** tools/call 使用真实 MCP 客户端；默认失败立即终止场景，故障测试显式读取错误响应。 */
async function call(name, args = {}, failure = false) {
  const response = await client.callTool({ name, arguments: args }, { timeout: 60000 });
  const data = JSON.parse(response.content[0].text);
  if (!failure) assert.notEqual(response.isError, true, JSON.stringify(data));
  else assert.equal(response.isError, true, JSON.stringify(data));
  return data;
}

/** 选择真实重载签名；测试不人工填 UTF-16 位置，必须通过公共符号搜索取得定位。 */
async function integerTarget() {
  const result = await call('wincode_find_code_symbol', { query: 'Save', kind: 'method' });
  assert.equal(result.source, 'roslyn');
  assert.equal(result.queryComplete, false);
  assert.equal(result.semanticContext.freshness.status, 'checked');
  assert.equal(result.symbols.length, 3);
  const target = result.symbols.find(symbol => symbol.signature === 'Demo.Api.Save(int)');
  assert.ok(target?.location, JSON.stringify(result));
  return target;
}

/** 仅传回搜索结果里的身份；按实际源码字符串断言位置，避免自己重算同一实现作为真值。 */
async function references(target, expected, expectedRoot) {
  const result = await call('wincode_find_references', { symbolName: target.name, symbolLocation: target.location });
  assert.equal(result.source, 'roslyn');
  assert.equal(result.resolution, 'resolved');
  assert.equal(result.queryComplete, false);
  assert.equal(result.totalReferences, expected);
  for (const item of result.references) {
    const source = await fs.readFile(path.join(expectedRoot, item.file), 'utf8');
    assert.equal(source.slice(item.start, item.start + item.length), 'Save');
    assert.equal(source.slice(item.start - 4, item.start), 'Api.');
    assert.ok(!source.slice(0, item.start).split('\n').at(-1).startsWith('//'));
  }
  return result;
}

/** 等待自有 MSBuild 目标写入启动标记，使用有界轮询而非猜测固定启动延迟。 */
async function markerReady(marker) {
  const deadline = Date.now() + 12000;
  while (true) {
    try { await fs.access(marker); return; } catch {}
    if (Date.now() > deadline) throw new Error('MSBuild blocking target did not start.');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

try {
  console.log('[roslyn-gateway] build and generated fixtures');
  report.hostBuild = dotnetRun(['build', 'tools/WinCode.Code.Host', '-c', 'Release', '-p:RestoreLockedMode=true', '--nologo']);
  for (const tag of ['A', 'B']) {
    const workspace = path.join(root, tag);
    for (const folder of ['Lib', 'App', '.cache']) await fs.mkdir(path.join(workspace, folder), { recursive: true });
    await fs.writeFile(path.join(workspace, 'Lib/Lib.csproj'), project.replace('EXTRA', ''));
    await fs.writeFile(path.join(workspace, 'App/App.csproj'), appProject);
    await fs.writeFile(path.join(workspace, 'Lib/Api.cs'), library);
    await fs.writeFile(path.join(workspace, 'Lib/Partial.cs'), 'namespace Demo; public partial class Api { public int Value { get; set; } }');
    await fs.writeFile(path.join(workspace, 'App/Use.cs'), calls(tag));
    await fs.writeFile(path.join(workspace, 'Helper.ts'), 'export function localHelp() { return 3; }\n');
    dotnetRun(['restore', path.join(workspace, 'App/App.csproj'), '--nologo']);
  }
  const a = path.join(root, 'A'), b = path.join(root, 'B');
  const config = path.join(root, 'roslyn.json');
  await fs.writeFile(config, JSON.stringify({ enabled: true, allowProjectEvaluation: true, project: 'App/App.csproj',
    configuration: 'Debug', targetFramework: 'net10.0', dotnetPath: dotnet, hostPath: host, loadTimeoutMs: 15000, queryTimeoutMs: 10000 }));
  client = new Client({ name: 'roslyn-gateway-acceptance', version: '1' });
  transport = new StdioClientTransport({ command: process.execPath, args: [path.join(repo, 'dist/index.js'), '--workspace', a, '--roslyn-config', config], env, stderr: 'pipe' });
  await client.connect(transport);
  transport.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-16384); });
  const initial = await call('wincode_hello_world');
  assert.equal(initial.codeProvider, 'roslyn');
  assert.equal(initial.health.roslyn.processAlive, false);
  assert.equal(initial.health.serena.handshakeOk, false);
  report.scenarios.push('explicit production CLI selects Roslyn; hello does not load a project');
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 15);
  assert.ok(listed.tools.find(tool => tool.name === 'wincode_find_references').inputSchema.properties.symbolLocation);
  report.scenarios.push('existing tools expose the validated optional symbolLocation contract');
  const target = await integerTarget();
  await references(target, 2, a);
  const ambiguous = await call('wincode_find_references', { symbolName: 'Save' });
  assert.equal(ambiguous.resolution, 'ambiguous');
  assert.equal(ambiguous.candidateCount, 3);
  assert.deepEqual(ambiguous.references, []);
  report.scenarios.push('real MCP search selects an exact overload; simple-name ambiguity returns candidates');
  const type = await call('wincode_find_code_symbol', { query: 'Api', kind: 'class' });
  assert.equal(type.symbols.length, 1);
  assert.equal(type.uniqueTypeMatch, true);
  const scopedPartial = await call('wincode_find_references', { symbolName: 'Api', relativePath: 'Lib/Partial.cs' });
  assert.equal(scopedPartial.candidates.length, 1);
  assert.equal(scopedPartial.candidates[0].location.file.replaceAll('\\', '/'), 'Lib/Partial.cs');
  const impact = await call('analyze_change_impact', { target: 'Api' });
  assert.equal(impact.source, 'roslyn');
  assert.equal(impact.queryComplete, false);
  assert.equal(impact.riskLevel, 'UNKNOWN');
  assert.equal(impact.confidence, 'UNCERTAIN');
  assert.ok(impact.referencesCount > 0, JSON.stringify(impact));
  report.scenarios.push('partial declarations deduplicate; impact keeps real references and incomplete confidence');
  const context = await call('wincode_prepare_context', { task: 'Inspect Save', scopeFiles: ['Lib/Api.cs'], lineRanges: [{ file: 'Lib/Api.cs', startLine: 1, endLine: 3 }], maxTokens: 2000 });
  assert.ok(context.evidence.length > 0);
  const textContext = await call('wincode_prepare_context', { task: 'Inspect localHelp', scopeFiles: ['Helper.ts'], symbol: 'localHelp', maxTokens: 2000 });
  assert.ok(textContext.evidence.some(item => item.snippet.includes('localHelp')));
  report.scenarios.push('explicit source context remains available alongside the semantic provider');
  const badLocation = { ...target.location, file: '../outside.cs' };
  assert.equal((await call('wincode_find_references', { symbolName: 'Save', symbolLocation: badLocation }, true)).errorCode, 'OUTSIDE_WORKSPACE');
  assert.equal((await call('wincode_find_references', { symbolName: 'Other', symbolLocation: target.location }, true)).errorCode, 'SYMBOL_MISMATCH');
  assert.equal((await call('wincode_find_references', { symbolName: 'Api/Save[0]' }, true)).errorCode, 'LEGACY_SYMBOL_ID');
  report.scenarios.push('outside location, mismatched name and legacy Serena identity are rejected');
  await fs.writeFile(path.join(a, 'App/Use.cs'), calls('A').replace('Api.Save(3);', ''));
  const stale = await call('wincode_find_references', { symbolName: 'Save', symbolLocation: target.location }, true);
  assert.ok(['SNAPSHOT_STALE', 'INPUTS_CHANGED'].includes(stale.errorCode));
  assert.equal(stale.references, undefined);
  const edited = await integerTarget();
  assert.notEqual(edited.location.snapshotId, target.location.snapshotId);
  await references(edited, 1, a);
  report.scenarios.push('edit rejects old evidence; explicit new search reloads and returns changed references');
  const beforeSwitch = codeProcesses();
  report.beforeSwitch = { gatewayPid: transport.pid, processes: beforeSwitch };
  await call('workspace_open', { path: b });
  assertExited(beforeSwitch);
  assert.equal((await call('wincode_find_references', { symbolName: 'Save', symbolLocation: edited.location }, true)).errorCode, 'SNAPSHOT_STALE');
  const inB = await integerTarget();
  await references(inB, 1, b);
  await call('workspace_open', { path: a });
  const againA = await integerTarget();
  await references(againA, 1, a);
  assert.notEqual(againA.location.snapshotId, edited.location.snapshotId);
  assert.equal((await call('wincode_find_references', { symbolName: 'Save', symbolLocation: inB.location }, true)).errorCode, 'SNAPSHOT_STALE');
  report.scenarios.push('A to B to A closes the old Host and rejects identities from both prior sessions');

  await call('workspace_open', { path: a });
  await fs.writeFile(path.join(a, 'App/App.csproj'), '<Project');
  const failedLoad = await call('wincode_find_code_symbol', { query: 'Api' }, true);
  assert.equal(failedLoad.errorCode, 'PROJECT_LOAD_FAILED');
  assert.equal((await call('wincode_hello_world')).health.roslyn.cleanupFailed, false);
  await fs.writeFile(path.join(a, 'App/App.csproj'), appProject);
  await references(await integerTarget(), 1, a);
  report.scenarios.push('initial project load failure returns its domain error and permits explicit repair without false cleanup failure');

  // 获准的隔离 targets 只启动测试脚本；标记写入 .cache，避免用写入结果假装另一个业务输入。
  const blocker = path.join(root, 'blocker.mjs');
  await fs.writeFile(blocker, "import fs from 'node:fs'; fs.writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);\n");
  const marker = path.join(a, '.cache/block.started');
  const escape = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  const targetXml = `<Target Name="WinCodeAcceptanceBlock" BeforeTargets="CoreCompile" Condition="'$(DesignTimeBuild)' == 'true'"><Exec Command="${escape(`"${process.execPath}" "${blocker}" "${marker}"`)}" /></Target>`;
  for (const mode of ['cancel', 'crash', 'timeout']) {
    console.log(`[roslyn-gateway] active MSBuild ${mode}`);
    await call('workspace_open', { path: a });
    await fs.rm(marker, { force: true });
    await fs.writeFile(path.join(a, 'App/App.csproj'), appProject.replace('</Project>', targetXml + '</Project>'));
    const controller = new AbortController();
    const pending = client.callTool({ name: 'wincode_find_code_symbol', arguments: { query: 'Api' } }, { timeout: 30000, signal: controller.signal });
    const settled = pending.then(value => ({ value }), error => ({ error: String(error) }));
    await markerReady(marker);
    const processes = codeProcesses();
    assert.ok(processes.some(item => item.CommandLine?.includes('BuildHost')), 'actual BuildHost must be observed during design-time work');
    assert.ok(processes.some(item => item.CommandLine?.includes(blocker)), 'blocking target child must be observed');
    report.processes.push({ mode, processes });
    if (mode === 'cancel') controller.abort();
    if (mode === 'crash') {
      const hostProcess = processes.find(item => item.CommandLine?.includes(host));
      assert.ok(hostProcess);
      process.kill(hostProcess.ProcessId, 'SIGKILL');
    }
    const outcome = await settled;
    if (mode === 'cancel') assert.ok(outcome.error);
    else {
      assert.equal(outcome.value?.isError, true, JSON.stringify(outcome));
      assert.equal(JSON.parse(outcome.value.content[0].text).errorCode, mode === 'timeout' ? 'HOST_TIMEOUT' : 'HOST_CRASHED');
    }
    // 客户端取消会先结束本地等待；同根打开等待 Gateway 占用清理完成后，才应确认恢复。
    await call('workspace_open', { path: a });
    assertExited(processes);
    await fs.writeFile(path.join(a, 'App/App.csproj'), appProject);
    await references(await integerTarget(), 1, a);
    report.scenarios.push(`${mode} during real MSBuild work releases observed Host, BuildHost and target descendants; explicit recovery succeeds`);
  }
  const final = await call('wincode_hello_world');
  assert.equal(final.health.serena.handshakeOk, false);
  const processes = owned(transport.pid);
  assert.ok(processes.every(item => !/python|serena/i.test(`${item.Name} ${item.CommandLine}`)));
  await client.close();
  assertExited(processes);
  report.scenarios.push('final client shutdown releases the Gateway and current Host without launching Serena or Python');
  report.success = true;
} catch (error) { report.failure = String(error); process.exitCode = 1; }
finally {
  if (client) await client.close().catch(() => {});
  report.stderr = stderr;
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ success: report.success, scenarios: report.scenarios.length, failure: report.failure, report: path.join(root, 'report.json') }));
}
