import { verifyGatewayLifecycle } from './roslyn/gateway-lifecycle.mjs';
/**
 * 直接 Roslyn 的真实 stdio MCP 验收。只生成/求值 test-tmp 下两套 C# 项目，保留失败与进程证据。
 * 依赖项目内已批准 SDK 与已构建 Gateway/Code Host；不安装、不运行真实用户项目或目标应用。
 */
import assert from 'node:assert/strict';
import { resolveDotnet, runDotnet } from './lib/dotnet.mjs';
import { ownedProcesses as owned, assertExited } from './lib/owned-processes.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const toolchain = resolveDotnet(repo);
const { dotnet, env } = toolchain;
let host;
const dotnetRun = args => runDotnet(toolchain, args, repo, 120000);
const parent = path.join(repo, 'test-tmp/roslyn-gateway');
await fs.mkdir(parent, { recursive: true });
const root = await fs.mkdtemp(path.join(parent, 'run-'));
const report = { root, scenarios: [], processes: [], success: false,
  limitations: ['Generated C# projects and a fresh local stdio client; relocated published Code Host with the installed SDK; not the current Codex connection or a clean machine test.'] };
const library = 'namespace Demo;\npublic partial class Api { public static void Save(int x) {} public static void Save(string x) {} public static void Unused() {} }\npublic class Other { public static void Save(int x) {} }\n';
const calls = tag => `using Demo;\n// 😀 中文 UTF-16 ${tag}\npublic class Use { public void Run() { Api.Save(1); Api.Save("x"); Other.Save(2); ${tag === 'A' ? 'Api.Save(3);' : ''} } }\n// Api.Save(777)\n`;
const project = '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><LangVersion>13.0</LangVersion><EnableNETAnalyzers>false</EnableNETAnalyzers></PropertyGroup>EXTRA</Project>';
const appProject = project.replace('EXTRA', '<ItemGroup><ProjectReference Include="../Lib/Lib.csproj" /></ItemGroup>');
let transport;
let client;
let stderr = '';




/** Observe the owned Code Host subtree; the Gateway remains until its connection closes. */
function codeProcesses() {
  const all = owned(transport.pid);
  const code = all.find(item => item.CommandLine?.includes(host));
  assert.ok(code, 'Owned Code Host is missing.');
  return owned(code.ProcessId);
}

/** tools/call 使用真实 MCP 客户端；默认失败立即终止场景，故障测试显式读取错误响应。 */
async function call(name, args = {}, failure = false, activeClient = client) {
  const response = await activeClient.callTool({ name, arguments: args }, { timeout: 60000 });
  const data = JSON.parse(response.content[0].text);
  if (!failure) assert.notEqual(response.isError, true, JSON.stringify(data));
  else assert.equal(response.isError, true, JSON.stringify(data));
  return data;
}

/** 选择真实重载签名；测试不人工填 UTF-16 位置，必须通过公共符号搜索取得定位。 */
async function integerTarget(activeClient = client) {
  const result = await call('wincode_find_code_symbol', { query: 'Save', kind: 'method' }, false, activeClient);
  assert.equal(result.source, 'roslyn');
  assert.equal(result.queryComplete, false);
  assert.equal(result.semanticContext.freshness.status, 'checked');
  assert.equal(result.symbols.length, 3);
  const target = result.symbols.find(symbol => symbol.signature === 'Demo.Api.Save(int)');
  assert.ok(target?.location, JSON.stringify(result));
  return target;
}

/** 仅传回搜索结果里的身份；按实际源码字符串断言位置，避免自己重算同一实现作为真值。 */
async function references(target, expected, expectedRoot, activeClient = client) {
  const result = await call('wincode_find_references', { symbolName: target.name, symbolLocation: target.location }, false, activeClient);
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
  // 验收构建只写入本轮目录，不能改写 check 已散列的正式 publish 交付件。
  const fixturePublish = path.join(root, 'fixture-publish');
  report.hostBuild = dotnetRun(['publish', 'tools/WinCode.Code.Host', '-c', 'Release', '-p:RestoreLockedMode=true', '--nologo', '--output', fixturePublish]);
  // 复制完整发布目录，使用含中文和空格的新路径；不能依赖原 bin 旁的 BuildHost。
  const relocated = path.join(root, '交付 Code Host');
  await fs.cp(fixturePublish, relocated, { recursive: true, errorOnExist: true, force: false });
  host = path.join(relocated, 'WinCode.Code.Host.dll');
  report.publishedHost = host;
  const identity = JSON.parse(runDotnet(toolchain, [host, '--identity'], root));
  assert.equal(identity.hostIdentity.configuration, 'Release');
  report.scenarios.push('complete published Code Host relocates to a Chinese path with spaces and starts from a different working directory');
  for (const tag of ['A', 'B']) {
    const workspace = path.join(root, tag);
    for (const folder of ['Lib', 'App', '.cache']) await fs.mkdir(path.join(workspace, folder), { recursive: true });
    await fs.writeFile(path.join(workspace, 'Lib/Lib.csproj'), project.replace('EXTRA', ''));
    await fs.writeFile(path.join(workspace, 'App/App.csproj'), appProject);
    await fs.writeFile(path.join(workspace, 'Lib/Api.cs'), library);
    await fs.writeFile(path.join(workspace, 'Lib/Partial.cs'), 'namespace Demo; public partial class Api { public int Value { get; set; } }');
    await fs.writeFile(path.join(workspace, 'App/Use.cs'), calls(tag));
    await fs.writeFile(path.join(workspace, 'Helper.ts'), 'export function localHelp() { return 3; }\n');
    await fs.writeFile(path.join(workspace, 'schema.yaml'), 'mode: original\n');
    dotnetRun(['restore', path.join(workspace, 'App/App.csproj'), '--nologo']);
  }
  const a = path.join(root, 'A'), b = path.join(root, 'B');
  const config = path.join(root, 'roslyn.json');
  await fs.writeFile(config, JSON.stringify({ enabled: true, allowProjectEvaluation: true, project: 'App/App.csproj',
    configuration: 'Debug', targetFramework: 'net10.0', dotnetPath: dotnet, hostPath: host, loadTimeoutMs: 15000, queryTimeoutMs: 10000,
    additionalInputs: ['schema.yaml'] }));
  client = new Client({ name: 'roslyn-gateway-acceptance', version: '1' });
  transport = new StdioClientTransport({ command: process.execPath, args: [path.join(repo, 'dist/index.js'), '--workspace', a, '--roslyn-config', config], cwd: root, env, stderr: 'pipe' });
  await client.connect(transport);
  transport.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-16384); });
  const initial = await call('wincode_hello_world');
  assert.deepEqual(initial.health.workspaceBinding, { mode: 'fixed', root: a, source: 'argument' });
  assert.equal(initial.codeProvider, 'roslyn');
  assert.equal(initial.health.roslyn.processAlive, false);
  assert.equal(initial.health.text.semanticConfigured, false);
  report.scenarios.push('explicit production CLI selects Roslyn; hello does not load a project');
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 15);
  assert.ok(listed.tools.find(tool => tool.name === 'wincode_find_references').inputSchema.properties.symbolLocation);
  report.scenarios.push('existing tools expose the validated optional symbolLocation contract');
  const target = await integerTarget();
  await references(target, 2, a);
  for (const name of ['analyze_change_impact', 'wincode_plan_refactoring']) {
    assert.ok(listed.tools.find(tool => tool.name === name).inputSchema.properties.symbolLocation);
    const result = await call(name, { target: target.name, symbolLocation: target.location, ...(name.includes('refactoring') ? { goal: 'Simplify this overload' } : {}) });
    const evidence = result.evidence ?? result;
    assert.deepEqual(evidence.symbolLocation, target.location);
    assert.equal(evidence.queryComplete, false);
    if (!result.evidence) { assert.equal(result.referencesCount, 2); assert.equal(result.matchedSymbols.length, 1); }
    assert.equal((await call(name, { target: 'Other', symbolLocation: target.location, goal: 'Simplify' }, true)).errorCode, 'SYMBOL_MISMATCH');
  }
  report.scenarios.push('selected overload continues into impact and refactoring without mixing other Save declarations');
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
  const absoluteImpact = await call('analyze_change_impact', { target: path.join(a, 'Lib/Api.cs') });
  assert.equal(absoluteImpact.uniqueResolution, true);
  assert.equal(absoluteImpact.referencesCount, impact.referencesCount);
  const refactor = await call('wincode_plan_refactoring', { target: 'Api', goal: 'Simplify the implementation' });
  assert.equal(refactor.evidence.source, 'roslyn');
  assert.equal(refactor.evidence.queryComplete, false);
  assert.ok(refactor.recommendedSteps.every(step => !/interrupted|textual matches|degraded retrieval/.test(step)));
  report.scenarios.push('absolute workspace target resolves and real Roslyn refactoring preserves bounded semantic evidence');
  const context = await call('wincode_prepare_context', { task: 'Inspect Save', scopeFiles: ['Lib/Api.cs'], lineRanges: [{ file: 'Lib/Api.cs', startLine: 1, endLine: 3 }], maxTokens: 2000 });
  assert.ok(context.evidence.length > 0);
  const textContext = await call('wincode_prepare_context', { task: 'Inspect localHelp', scopeFiles: ['Helper.ts'], symbol: 'localHelp', maxTokens: 2000 });
  assert.ok(textContext.evidence.some(item => item.snippet.includes('localHelp')));
  report.scenarios.push('explicit source context remains available alongside the semantic provider');
  const badLocation = { ...target.location, file: '../outside.cs' };
  assert.equal((await call('wincode_find_references', { symbolName: 'Save', symbolLocation: badLocation }, true)).errorCode, 'OUTSIDE_WORKSPACE');
  assert.equal((await call('wincode_find_references', { symbolName: 'Other', symbolLocation: target.location }, true)).errorCode, 'SYMBOL_MISMATCH');
  assert.equal((await call('wincode_find_references', { symbolName: 'Api/Save[0]' }, true)).errorCode, 'LEGACY_SYMBOL_ID');
  report.scenarios.push('outside location, mismatched name and retired Serena identity are rejected');
  await fs.writeFile(path.join(a, 'App/Use.cs'), calls('A').replace('Api.Save(3);', ''));
  const stale = await call('wincode_find_references', { symbolName: 'Save', symbolLocation: target.location }, true);
  assert.ok(['SNAPSHOT_STALE', 'INPUTS_CHANGED'].includes(stale.errorCode));
  assert.equal(stale.references, undefined);
  for (const name of ['analyze_change_impact', 'wincode_plan_refactoring']) {
    const rejected = await call(name, { target: target.name, symbolLocation: target.location, goal: 'Simplify' }, true);
    assert.ok(['SNAPSHOT_STALE', 'INPUTS_CHANGED'].includes(rejected.errorCode));
  }
  report.scenarios.push('impact and refactoring reject stale selected locations before search can reload');
  const edited = await integerTarget();
  assert.notEqual(edited.location.snapshotId, target.location.snapshotId);
  await references(edited, 1, a);
  report.scenarios.push('edit rejects old evidence; explicit new search reloads and returns changed references');
  const warmProcesses = codeProcesses();
  const warmHealth = (await call('wincode_hello_world')).health;
  for (let iteration = 0; iteration < 10; iteration++) {
    await call('workspace_open', { path: a });
    const confirmed = await integerTarget();
    assert.equal(confirmed.location.snapshotId, edited.location.snapshotId);
    await references(edited, 1, a);
  }
  await Promise.all([
    ...Array.from({ length: 4 }, () => call('workspace_open', { path: a })),
    references(edited, 1, a),
  ]);
  const confirmedHealth = (await call('wincode_hello_world')).health;
  assert.equal(confirmedHealth.session.id, warmHealth.session.id);
  assert.deepEqual(confirmedHealth.workspaceWatch, warmHealth.workspaceWatch);
  assert.equal(confirmedHealth.roslyn.snapshotId, warmHealth.roslyn.snapshotId);
  assert.deepEqual(codeProcesses().map(item => item.ProcessId).sort(), warmProcesses.map(item => item.ProcessId).sort());
  report.warmConfirmations = { sequential: 10, concurrent: 4, snapshotId: confirmedHealth.roslyn.snapshotId,
    processes: warmProcesses, sessionId: confirmedHealth.session.id };
  report.scenarios.push('ten same-root opens and four concurrent confirmations preserve the real Host and observed owned-process PIDs, snapshot, watcher and session while references remain valid');
  const beforeSwitch = codeProcesses();
  report.beforeSwitch = { gatewayPid: transport.pid, processes: beforeSwitch };
  const rejected = await call('workspace_open', { path: b }, true);
  assert.equal(rejected.errorCode, 'WORKSPACE_MISMATCH');
  assert.equal(rejected.activeWorkspace, a); assert.equal(rejected.requestedWorkspace, b);
  assert.deepEqual(codeProcesses().map(item => item.ProcessId).sort(), beforeSwitch.map(item => item.ProcessId).sort());
  await references(edited, 1, a);
  const peerClient = new Client({ name: 'roslyn-gateway-peer-B', version: '1' });
  const peerTransport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(repo, 'dist/index.js'), '--workspace', b, '--roslyn-config', config], cwd: root, env, stderr: 'pipe' });
  let peerProcesses = [];
  try {
    await peerClient.connect(peerTransport);
    const peerHello = await call('wincode_hello_world', {}, false, peerClient);
    assert.notEqual(peerHello.runtime.instanceId, initial.runtime.instanceId);
    assert.equal(peerHello.workspace, b);
    const [inB] = await Promise.all([integerTarget(peerClient), references(edited, 1, a)]);
    await references(inB, 1, b, peerClient);
    peerProcesses = owned(peerTransport.pid); report.processes.push(...peerProcesses);
    assert.equal((await call('wincode_find_references', { symbolName: 'Save', symbolLocation: edited.location }, true, peerClient)).errorCode, 'SNAPSHOT_STALE');
    assert.equal((await call('wincode_find_references', { symbolName: 'Save', symbolLocation: inB.location }, true)).errorCode, 'SNAPSHOT_STALE');
    const preserved = (await call('wincode_hello_world')).health;
    assert.equal(preserved.session.id, confirmedHealth.session.id);
    assert.equal(preserved.cache.namespace, confirmedHealth.cache.namespace);
    assert.deepEqual(preserved.workspaceWatch, confirmedHealth.workspaceWatch);
    assert.equal(preserved.roslyn.snapshotId, edited.location.snapshotId);
    assert.deepEqual(codeProcesses().map(item => item.ProcessId).sort(), beforeSwitch.map(item => item.ProcessId).sort());
  } finally { await peerClient.close(); assertExited(peerProcesses); }
  const againA = await integerTarget();
  await references(againA, 1, a);
  assert.equal(againA.location.snapshotId, edited.location.snapshotId);
  report.scenarios.push('wrong-root open preserves the warm A Host, snapshot, session and watcher; independent B queries work and both connections reject foreign locations');

  // 配置经生产 CLI/Adapter/Host 三层传递；无关文件和显式输入必须产生相反的失效行为。
  await fs.writeFile(path.join(a, 'README.md'), '# Unrelated notes\n');
  const unrelated = path.join(a, 'unrelated.bin');
  const unrelatedHandle = await fs.open(unrelated, 'wx');
  try { await unrelatedHandle.truncate(33 * 1024 * 1024); } finally { await unrelatedHandle.close(); }
  try { await references(againA, 1, a); } finally { await fs.unlink(unrelated); }
  report.scenarios.push('real MCP keeps the same snapshot after README and unrelated 33 MiB file creation');
  await fs.writeFile(path.join(a, 'schema.yaml'), 'mode: changed\n');
  const additionalStale = await call('wincode_find_references', { symbolName: 'Save', symbolLocation: againA.location }, true);
  assert.ok(['SNAPSHOT_STALE', 'INPUTS_CHANGED'].includes(additionalStale.errorCode));
  assert.equal(additionalStale.references, undefined);
  const inputReloaded = await integerTarget();
  assert.notEqual(inputReloaded.location.snapshotId, againA.location.snapshotId);
  await references(inputReloaded, 1, a);
  await fs.unlink(path.join(a, 'schema.yaml'));
  const inputMissing = await call('wincode_find_references', { symbolName: 'Save', symbolLocation: inputReloaded.location }, true);
  assert.equal(inputMissing.errorCode, 'INPUT_UNAVAILABLE');
  assert.equal((await call('wincode_find_code_symbol', { query: 'Api' }, true)).errorCode, 'INPUT_UNAVAILABLE');
  await fs.writeFile(path.join(a, 'schema.yaml'), 'mode: restored\n');
  await references(await integerTarget(), 1, a);
  assert.equal((await call('wincode_hello_world')).health.lastAdapterError.provider, 'roslyn');
  report.scenarios.push('configured extra input changes and absence invalidate evidence; explicit repair and search recover');

  // SDK input changes really require a fresh process. This also establishes an
  // actual cold state for the following initial-load failure assertion.
  const beforeSdk = await integerTarget();
  const sdkProcesses = codeProcesses();
  await fs.writeFile(path.join(a, 'global.json'), JSON.stringify({ sdk: { version: '10.0.303', rollForward: 'disable' } }));
  const sdkChanged = await call('wincode_find_references', { symbolName: 'Save', symbolLocation: beforeSdk.location }, true);
  assert.equal(sdkChanged.errorCode, 'HOST_RESTART_REQUIRED');
  assert.equal(sdkChanged.recoveryAction, 'workspace_open');
  await call('workspace_open', { path: a });
  assertExited(sdkProcesses);
  assert.equal((await call('wincode_hello_world')).health.roslyn.processAlive, false);
  report.scenarios.push('real SDK-selection input change requires workspace_open, closes the old Host and leaves a cold reusable adapter');
  await fs.writeFile(path.join(a, 'App/App.csproj'), '<Project');
  const failedLoad = await call('wincode_find_code_symbol', { query: 'Api' }, true);
  assert.equal(failedLoad.errorCode, 'PROJECT_LOAD_FAILED');
  assert.equal((await call('wincode_hello_world')).health.roslyn.cleanupFailed, false);
  await fs.writeFile(path.join(a, 'App/App.csproj'), appProject);
  await references(await integerTarget(), 1, a);
  report.scenarios.push('initial project load failure returns its domain error and permits explicit repair without false cleanup failure');

  const beforeMalformed = await integerTarget();
  await fs.writeFile(path.join(a, 'App/App.csproj'), '<Project');
  const invalidated = await call('wincode_find_references', { symbolName: 'Save', symbolLocation: beforeMalformed.location }, true);
  assert.ok(['SNAPSHOT_STALE', 'INPUTS_CHANGED'].includes(invalidated.errorCode));
  assert.equal((await call('wincode_find_code_symbol', { query: 'Api' }, true)).errorCode, 'PROJECT_LOAD_FAILED');
  await fs.writeFile(path.join(a, 'App/App.csproj'), appProject);
  await references(await integerTarget(), 1, a);
  report.scenarios.push('malformed input in a warm project rejects old evidence before explicit reload fails; repairing and searching recovers');

  await verifyGatewayLifecycle({ root, a, host, appProject, client, call, markerReady, codeProcesses, report, references, integerTarget });
  const final = await call('wincode_hello_world');
  assert.equal(final.health.text.semanticConfigured, false);
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
