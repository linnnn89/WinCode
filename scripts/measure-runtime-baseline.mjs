/** 三次隔离 stdio 样本；连接/冷查询/热查询计时不包含外部进程快照的开销。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { resolveDotnet, runDotnet } from './lib/dotnet.mjs';
import { ownedProcesses, observedSurvivors } from './lib/owned-processes.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const toolchain = resolveDotnet(repo);
await fs.mkdir(path.join(repo, 'test-tmp/runtime-baseline'), { recursive: true });
const root = await fs.mkdtemp(path.join(repo, 'test-tmp/runtime-baseline/run-'));
const report = { root, version: JSON.parse(await fs.readFile(path.join(repo, 'package.json'), 'utf8')).version,
  startedAt: new Date().toISOString(), samples: [], success: false,
  limitations: ['Three local generated-project samples; filesystem/SDK caches are warm across runs. No p95 or clean-machine promise.',
    'Owned-process working sets are snapshots and may count shared pages more than once. No installed Codex connection change.'] };
const config = path.join(root, 'roslyn.json');
function startupProfile() {
  const moduleUrl = name => JSON.stringify(pathToFileURL(path.join(repo, `src/${name}.ts`)).href);
  // 仅在独立测量进程包裹现有方法；不改变生产代码、启动顺序或模块行为。
  const code = `import childProcess from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs/promises';
let spawns = 0, reads = 0, readBytes = 0, stats = 0, enumerations = 0;
const spawn = childProcess.spawn; childProcess.spawn = function(...args) { spawns++; return spawn.apply(this, args); }; syncBuiltinESMExports();
for (const name of ['readFile', 'stat', 'lstat', 'readdir']) { const original = fs[name]; fs[name] = async function(...args) {
const result = await original.apply(this, args); if (name === 'readFile') { reads++; readBytes += Buffer.byteLength(result); }
else if (name === 'readdir') enumerations++; else stats++; return result; }; }
const { ToolRouter } = await import(${moduleUrl('Core/ToolRouter')});
const { getDefaultConfig } = await import(${moduleUrl('Core/Config')});
const router = new ToolRouter(getDefaultConfig(${JSON.stringify(root)}));
spawns = reads = readBytes = stats = enumerations = 0;
const stages = [];
for (const [object, method, label] of [[router.cache,'initialize','cache'], [router.repomix,'initialize','repomix'],
[router.text,'initialize','local-text'], [router.flaui,'initialize','flaui'], [router.extensions,'initializeAll','extensions'],
[router.cache,'computeWorkspaceFingerprint','fingerprint']]) {
const original = object[method]; object[method] = async function(...args) { const start = performance.now();
const before = { spawns, reads, readBytes, stats, enumerations }; try { return await original.apply(this, args); }
finally { stages.push({ label, ms: performance.now() - start, spawns: spawns-before.spawns, reads: reads-before.reads,
readBytes: readBytes-before.readBytes, stats: stats-before.stats, enumerations: enumerations-before.enumerations }); } }; }
const watchStart = router.watch.start; router.watch.start = function(...args) { const start = performance.now();
try { return watchStart.apply(this, args); } finally { stages.push({ label: 'watch', ms: performance.now()-start }); } };
const start = performance.now(); try { await router.initialize();
console.log(JSON.stringify({ totalMs: performance.now()-start, stages, spawns, reads, readBytes, stats, enumerations })); }
finally { await router.dispose(); }`;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', code], {
    cwd: repo, env: toolchain.env, windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}
async function snapshot(pid) {
  const processes = ownedProcesses(pid);
  const ids = processes.map(item => item.ProcessId);
  assert.ok(ids.length <= 256 && ids.every(id => Number.isSafeInteger(id) && id > 0));
  const command = `@(Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64,PrivateMemorySize64,HandleCount) | ConvertTo-Json -Compress`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout || '[]');
  return { processes, memory: Array.isArray(parsed) ? parsed : [parsed] };
}
try {
  const project = '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><EnableNETAnalyzers>false</EnableNETAnalyzers></PropertyGroup></Project>';
  await fs.writeFile(path.join(root, 'App.csproj'), project);
  await fs.writeFile(path.join(root, 'Api.cs'), 'public class Api { public static void Save(int value) {} public void Run() { Save(1); } }');
  await fs.writeFile(path.join(root, 'NuGet.Config'), '<configuration><packageSources><clear /></packageSources></configuration>');
  runDotnet(toolchain, ['restore', path.join(root, 'App.csproj'), '--nologo'], root);
  await fs.writeFile(config, JSON.stringify({ enabled: true, allowProjectEvaluation: true, project: 'App.csproj', configuration: 'Debug',
    targetFramework: 'net10.0', dotnetPath: toolchain.dotnet,
    hostPath: path.join(repo, 'tools/WinCode.Code.Host/bin/Release/net10.0/publish/WinCode.Code.Host.dll') }));
  for (let index = 0; index < 3; index++) {
    const sample = { index: index + 1 };
    report.samples.push(sample);
    const client = new Client({ name: 'runtime-baseline', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [path.join(repo, 'dist/index.js'), '--workspace', root, '--roslyn-config', config], cwd: root, env: toolchain.env, stderr: 'pipe' });
    const call = async (name, args = {}) => {
      const response = await client.callTool({ name, arguments: args }, { timeout: 30000 });
      assert.notEqual(response.isError, true, JSON.stringify(response));
      return JSON.parse(response.content[0].text);
    };
    try {
      let start = performance.now();
      await client.connect(transport);
      transport.stderr?.on('data', () => {});
      const hello = await call('wincode_hello_world');
      sample.connectThroughHelloMs = performance.now() - start;
      sample.identity = { version: hello.version, runtime: hello.runtime, codeProvider: hello.codeProvider };
      sample.unused = await snapshot(transport.pid);
      assert.ok(!sample.unused.processes.some(item => item.CommandLine?.includes('WinCode.Code.Host')), 'Hello unexpectedly started Roslyn');
      start = performance.now();
      const symbols = await call('wincode_find_code_symbol', { query: 'Save', kind: 'method' });
      sample.coldQueryMs = performance.now() - start;
      assert.equal(symbols.source, 'roslyn');
      sample.warm = await snapshot(transport.pid);
      start = performance.now();
      await call('wincode_find_code_symbol', { query: 'Save', kind: 'method' });
      sample.warmQueryMs = performance.now() - start;
      start = performance.now();
      await client.close();
      sample.clientCloseMs = performance.now() - start;
      sample.survivors = observedSurvivors(sample.warm.processes);
      assert.equal(sample.survivors.length, 0);
    } finally { await client.close(); }
  }
  report.startupProfiles = Array.from({ length: 3 }, startupProfile);
  report.limitations.push('Startup profiles use source ToolRouter/local-text in isolated Node processes; counts cover Node calls, not native Host or kernel I/O. Timed method wrappers add measurement overhead.');
  report.success = true;
} catch (error) { report.error = String(error); process.exitCode = 1; }
finally {
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ success: report.success, error: report.error, report: path.join(root, 'report.json'),
    samples: report.samples.map(({ index, connectThroughHelloMs, coldQueryMs, warmQueryMs }) => ({ index, connectThroughHelloMs, coldQueryMs, warmQueryMs })) }));
}
