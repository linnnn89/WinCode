/** 用生成项目复现 Gateway 在 Roslyn 初始加载期间死亡；只终止本测试拥有且身份仍匹配的进程。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { resolveDotnet, runDotnet } from './lib/dotnet.mjs';
import { ownedProcesses, observedSurvivors, terminateObserved } from './lib/owned-processes.mjs';
import { verifyDesktopOwner, auditRepomixOwner } from './owner-death/scenarios.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv.length > 3 || process.argv.slice(2).some(arg => !['--desktop', '--repomix'].includes(arg)))
  throw new Error('Usage: node scripts/verify-owner-death.mjs [--desktop|--repomix]');
const toolchain = resolveDotnet(repo);
const parent = path.join(repo, 'test-tmp/owner-death');
await fs.mkdir(parent, { recursive: true });
const root = await fs.mkdtemp(path.join(parent, 'run-'));
const report = { version: JSON.parse(await fs.readFile(path.join(repo, 'package.json'), 'utf8')).version,
  root, startedAt: new Date().toISOString(), scenarios: [], cleanup: [], success: false };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const xml = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
let client, transport, observed = [], pending;
try {
  if (process.argv.includes('--desktop')) {
    await verifyDesktopOwner({ root, repo, toolchain, report });
    report.success = true;
  } else if (process.argv.includes('--repomix')) {
    await auditRepomixOwner({ root, repo, toolchain, report });
    report.success = true;
  } else {
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(path.join(workspace, '.cache'), { recursive: true });
  const marker = path.join(workspace, '.cache', 'loading.marker');
  const blocker = path.join(root, 'blocker.mjs');
  await fs.writeFile(blocker, "import fs from 'node:fs'; fs.writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);\n");
  const project = '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><EnableNETAnalyzers>false</EnableNETAnalyzers></PropertyGroup></Project>';
  const projectPath = path.join(workspace, 'App.csproj');
  await fs.writeFile(projectPath, project);
  await fs.writeFile(path.join(workspace, 'Api.cs'), 'public class Api { public void Save() {} }');
  await fs.writeFile(path.join(workspace, 'NuGet.Config'), '<configuration><packageSources><clear /></packageSources></configuration>');
  runDotnet(toolchain, ['restore', projectPath, '--nologo'], workspace);
  const blocking = `<Target Name="OwnerDeathBlock" BeforeTargets="CoreCompile" Condition="'$(DesignTimeBuild)' == 'true'"><Exec Command="${xml(`"${process.execPath}" "${blocker}" "${marker}"`)}" /></Target>`;
  await fs.writeFile(projectPath, project.replace('</Project>', blocking + '</Project>'));
  const config = path.join(root, 'roslyn.json');
  const host = path.join(repo, 'tools/WinCode.Code.Host/bin/Release/net10.0/publish/WinCode.Code.Host.dll');
  await fs.writeFile(config, JSON.stringify({ enabled: true, allowProjectEvaluation: true, project: 'App.csproj',
    configuration: 'Debug', targetFramework: 'net10.0', dotnetPath: toolchain.dotnet, hostPath: host,
    loadTimeoutMs: 30000, queryTimeoutMs: 10000 }));
  client = new Client({ name: 'owner-death-acceptance', version: '1' });
  transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(repo, 'dist/index.js'), '--workspace', workspace, '--roslyn-config', config],
    cwd: root, env: toolchain.env, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  await client.connect(transport);
  transport.stderr?.on('data', () => {});
  pending = client.callTool({ name: 'wincode_find_code_symbol', arguments: { query: 'Api' } }, { timeout: 40000 })
    .then(value => ({ value }), error => ({ error: String(error) }));
  const deadline = Date.now() + 20000;
  while (!(await fs.stat(marker).catch(() => null))) {
    if (Date.now() > deadline) throw new Error('MSBuild loading marker missing.');
    await sleep(50);
  }
  observed = ownedProcesses(transport.pid);
  assert.ok(observed.some(item => item.CommandLine?.includes(host)), 'Code Host not observed');
  assert.ok(observed.some(item => item.CommandLine?.includes('BuildHost')), 'BuildHost not observed');
  assert.ok(observed.some(item => item.CommandLine?.includes(blocker)), 'Blocking child not observed');
  report.processes = observed;
  const gatewayPid = transport.pid;
  const started = Date.now();
  process.kill(gatewayPid, 'SIGKILL'); // 单个受控 Gateway；不能用 /T 代替被测清理。
  await sleep(8000);
  const survivors = observedSurvivors(observed);
  report.scenarios.push({ name: 'Gateway dies during initial MSBuild load', elapsedMs: Date.now() - started,
    observedCount: observed.length, survivors, success: survivors.length === 0 });
  assert.equal(survivors.length, 0, `Owned descendants survived Gateway death: ${survivors.map(p => p.ProcessId).join(', ')}`);
  report.success = true;
  }
} catch (error) {
  report.error = String(error);
  process.exitCode = 1;
} finally {
  // 清理不计入验收成功，PID/创建时间不匹配时绝不终止复用该 PID 的进程。
  for (const old of [...observed].reverse()) {
    try { if (terminateObserved(old)) report.cleanup.push({ pid: old.ProcessId, forced: true }); }
    catch (error) { report.cleanup.push({ pid: old.ProcessId, error: String(error) }); }
  }
  await client?.close().catch(error => { report.cleanup.push({ client: String(error) }); });
  await pending;
  if (report.cleanup.some(item => item.error || item.client)) {
    report.success = false;
    report.error ??= 'Test cleanup failed; inspect cleanup records.';
    process.exitCode = 1;
  }
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ success: report.success, error: report.error, report: path.join(root, 'report.json') }));
}
