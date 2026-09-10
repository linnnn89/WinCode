import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { ownedProcesses, observedSurvivors, terminateObserved } from '../lib/owned-processes.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(test, message) {
  const deadline = Date.now() + 15000;
  while (!(await test())) { if (Date.now() > deadline) throw new Error(message); await sleep(25); }
}
async function clean(processes, report, role = 'owner-tree') {
  for (const old of [...processes].reverse()) {
    try { if (terminateObserved(old)) report.cleanup.push({ pid: old.ProcessId, forced: true, role }); }
    catch (error) { report.cleanup.push({ pid: old.ProcessId, error: String(error), role }); }
  }
}

export async function verifyDesktopOwner({ root, repo, toolchain, report }) {
  const marker = path.join(root, 'uia-entered');
  const fixture = path.join(repo, 'tests/fixtures/wpf-ui-review/bin/Release/net10.0-windows/win-x64/publish/wpf-ui-review.exe');
  const target = spawn(fixture, ['--background-fixture', '--auto-close=60000'], {
    cwd: root, env: { ...toolchain.env, WINCODE_TEST_OWNER_UI_MARKER: marker }, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', observed = [], targetProcesses = [], pending;
  target.stdout.on('data', data => { stdout = (stdout + data.toString()).slice(-8192); });
  target.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-8192); });
  let spawnError;
  target.on('error', error => { spawnError = error; });
  const client = new Client({ name: 'owner-death-desktop', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(repo, 'dist/index.js'), '--workspace', root],
    cwd: root, env: toolchain.env, stderr: 'pipe' });
  try {
    await waitFor(() => { if (spawnError) throw spawnError; return /READY\s+(\d+)\s+(0x[0-9a-fA-F]+)/.test(stdout); }, `WPF readiness missing: ${stderr}`);
    const match = stdout.match(/READY\s+(\d+)\s+(0x[0-9a-fA-F]+)/);
    targetProcesses = ownedProcesses(target.pid);
    await client.connect(transport);
    transport.stderr?.on('data', () => {});
    await fs.writeFile(marker + '.armed', 'controlled UIA access');
    pending = client.callTool({ name: 'wincode_ui_inspect', arguments: {
      pid: Number(match[1]), hwnd: match[2], capture: 'none', backgroundOnly: true, maxNodes: 10, timeoutMs: 30000,
    } }, { timeout: 40000 }).then(value => ({ value }), error => ({ error: String(error) }));
    await waitFor(() => fs.stat(marker).catch(() => null), 'The target UIA provider was not entered');
    observed = ownedProcesses(transport.pid);
    assert.ok(observed.some(item => item.CommandLine?.includes('WinCode.UIA.Host')), 'Active UIA Helper missing');
    const started = Date.now();
    process.kill(transport.pid, 'SIGKILL');
    await sleep(8000);
    const survivors = observedSurvivors(observed);
    const targetStillAlive = observedSurvivors(targetProcesses).some(item => item.ProcessId === target.pid);
    report.scenarios.push({ name: 'Gateway dies while the actual UIA provider is blocked', elapsedMs: Date.now() - started,
      processes: observed, survivors, targetStillAlive, success: survivors.length === 0 && targetStillAlive });
    assert.equal(survivors.length, 0, 'Owned UIA Helper survived');
    assert.equal(targetStillAlive, true, 'Owner cleanup must preserve the target application');
  } finally {
    await clean(observed, report);
    await client.close().catch(error => report.cleanup.push({ client: String(error) }));
    await pending;
    // 夹具是验收目标，不属于 Gateway 后代；仅在验收记录完成后单独关闭它。
    if (!targetProcesses.length && target.pid) targetProcesses = ownedProcesses(target.pid);
    await clean(targetProcesses, report, 'target-fixture-after-acceptance');
  }
}

/** 通过实际 RepomixAdapter 调用生成的 Node CLI；不安装 Repomix，不改变真实配置。 */
export async function auditRepomixOwner({ root, repo, toolchain, report }) {
  const marker = path.join(root, 'pack-entered');
  const cli = path.join(root, 'controlled-cli.mjs');
  await fs.writeFile(cli, `import fs from 'node:fs'; if (process.argv.includes('--version')) { console.log('1.0.0'); }
else { fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000); }\n`);
  await fs.writeFile(path.join(root, 'input.ts'), 'export const marker = 1;');
  const source = name => JSON.stringify(pathToFileURL(path.join(repo, `src/${name}.ts`)).href);
  const bootstrap = `import { RepomixAdapter } from ${source('Adapters/RepomixAdapter')};
import { getDefaultConfig } from ${source('Core/Config')}; import { CacheManager } from ${source('Core/Cache')};
const config = getDefaultConfig(${JSON.stringify(root)}); config.adapters.repomix.useCli = true;
config.adapters.repomix.customCliPath = ${JSON.stringify(cli)}; config.timeouts.repomixPackMs = 60000;
const adapter = new RepomixAdapter(config, new CacheManager(config.cacheDir)); await adapter.initialize();
await adapter.packWorkspace({ include: ['input.ts'] });`;
  const owner = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', bootstrap], {
    cwd: repo, env: toolchain.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '', observed = [];
  owner.stdout.resume(); owner.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-8192); });
  try {
    await waitFor(() => fs.stat(marker).catch(() => null), `Controlled Repomix did not start: ${stderr}`);
    observed = ownedProcesses(owner.pid);
    assert.ok(observed.some(item => item.CommandLine?.includes(cli)), 'Controlled Node CLI missing');
    process.kill(owner.pid, 'SIGKILL');
    await sleep(8000);
    const survivors = observedSurvivors(observed);
    report.scenarios.push({ name: 'Actual RepomixAdapter owner dies during controlled CLI work', processes: observed,
      survivors, success: survivors.length === 0, scope: 'Controlled Node CLI, not installed Repomix or full Gateway' });
    assert.equal(survivors.length, 0, 'Repomix owner-death protection is not supplied by the native Helper guard');
  } finally {
    if (!observed.length) observed = ownedProcesses(owner.pid);
    await clean(observed, report);
  }
}
