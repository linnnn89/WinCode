/** Isolated real WinForms + secured Named Pipe + real stdio MCP, simulated Roslyn lifetimes. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { resolveDotnet } from './lib/dotnet.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { env } = resolveDotnet(repo);
const parent = path.join(repo, 'test-tmp/tray');
await fs.mkdir(parent, { recursive: true });
const root = await fs.mkdtemp(path.join(parent, 'run-'));
const children = [];
let tray, stderr = '';
const report = { root, success: false, scenarios: [] };
async function verifyProductionEntry() {
  const exe = path.join(repo, 'tools/WinCode.Tray/bin/Release/net10.0-windows/win-x64/publish/WinCode.Tray.exe');
  const endpoint = JSON.parse(execFileSync(exe, ['--endpoint'], { env, encoding: 'utf8', windowsHide: true, timeout: 3000 })).pipeName;
  const server = net.createServer();
  let socket, client;
  try {
    // Use the real opt-in CLI. Bind fails rather than taking over an existing user's Tray.
    server.listen('\\\\.\\pipe\\' + endpoint); await once(server, 'listening');
    const connection = once(server, 'connection');
    client = new Client({ name: 'tray-production-entry', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(repo, 'dist/index.js'), '--workspace', root, '--tray'], cwd: repo, env, stderr: 'pipe' });
    transport.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
    await client.connect(transport);
    const hello = await client.callTool({ name: 'wincode_hello_world', arguments: {} }); assert.notEqual(hello.isError, true);
    [socket] = await connection;
    let input = '', frames = [], waiters = [];
    socket.on('data', chunk => { input += chunk; let newline; while ((newline = input.indexOf('\n')) >= 0) {
      const value = JSON.parse(input.slice(0, newline)); input = input.slice(newline + 1);
      const next = waiters.shift(); if (next) next(value); else frames.push(value);
    } });
    const read = () => frames.length ? Promise.resolve(frames.shift()) : new Promise(resolve => waiters.push(resolve));
    const registration = await read(); assert.equal(registration.pid, transport.pid);
    const closed = once(socket, 'close');
    socket.write(JSON.stringify({ v: 1, type: 'request', id: 'stop', instanceId: registration.instanceId, operation: 'shutdown' }) + '\n');
    assert.equal((await read()).result.status, 'accepted'); await closed;
    const deadline = Date.now() + 5000;
    while (transport.pid != null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(transport.pid, null, 'Production Gateway must exit after the acknowledged shutdown');
    report.scenarios.push('Actual dist/index.js --tray registers after MCP readiness and exits through its existing shutdown path on a targeted acknowledged request');
  } finally {
    await client?.close().catch(() => {}); socket?.destroy();
    await new Promise(resolve => server.close(() => resolve()));
  }
}
try {
  tray = spawn(path.join(repo, 'tools/WinCode.Tray/bin/Release/net10.0-windows/win-x64/publish/WinCode.Tray.exe'), ['--self-test', root],
    { cwd: repo, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise((resolve, reject) => { tray.once('error', reject); tray.once('exit', resolve); });
  tray.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
  const ready = await new Promise((resolve, reject) => {
    let input = '';
    const timer = setTimeout(() => reject(new Error('Tray ready timeout')), 8000);
    tray.stdout.on('data', chunk => {
      input += chunk;
      if (input.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(input.split('\n')[0])); } catch (error) { reject(error); } }
    });
    exited.then(code => { clearTimeout(timer); reject(new Error(`Tray exited before ready: ${code} ${stderr}`)); }, reject);
  });
  report.tray = ready;
  assert.equal(ready.pid, tray.pid);
  report.trayMemoryAtOpen = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command',
    `$p=Get-Process -Id ${tray.pid}; try { [PSCustomObject]@{workingSetBytes=$p.WorkingSet64;privateBytes=$p.PrivateMemorySize64;cpuSeconds=$p.TotalProcessorTime.TotalSeconds} | ConvertTo-Json -Compress } finally {$p.Dispose()}`],
    { encoding: 'utf8', windowsHide: true, timeout: 8000 }));
  for (const mode of ['idle', 'busy']) {
    const workspace = path.join(root, mode); await fs.mkdir(workspace);
    // Fixed test bootstrap; no public CLI argument can inject a backend into production.
    const bootstrap = `
      import { ToolRouter } from './src/Core/ToolRouter.ts';
      import { getDefaultConfig } from './src/Core/Config.ts';
      import { RoslynAdapter } from './src/Adapters/RoslynAdapter.ts';
      import { WinCodeMcpServer } from './src/Gateway/McpServer.ts';
      import { TrayClient } from './src/Gateway/TrayClient.ts';
      const config=getDefaultConfig(${JSON.stringify(workspace)});
      config.adapters.roslyn={enabled:true,allowProjectEvaluation:true,project:'App.csproj',configuration:'Debug',targetFramework:'net10.0',dotnetPath:process.execPath,hostPath:${JSON.stringify(path.join(root, 'fixture.dll'))}};
      const router=new ToolRouter(config), server=new WinCodeMcpServer(router);
      await server.start();
      router.roslyn.client={active:true,close:async()=>{}}; router.roslyn.snapshot='a'.repeat(32);
      const busy=${mode === 'busy'}; if(busy) router.beginRequest();
      let stopping=false;
      const control=new TrayClient(${JSON.stringify(ready.pipeName)},router,()=>stop());
      async function stop(){if(stopping)return;stopping=true;control.dispose();if(busy)router.endRequest();await server.stop();}
      server.onDisconnect=()=>void stop(); process.stdin.once('end',()=>void stop()); control.start();
    `;
    const client = new Client({ name: `tray-${mode}`, version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', '--input-type=module', '--eval', bootstrap], cwd: repo, env, stderr: 'pipe' });
    children.push({ client, transport });
    transport.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
    await client.connect(transport);
  }
  const timeout = setTimeout(() => { report.uiTimedOut = true; tray.kill(); }, 35000);
  let code; try { code = await exited; } finally { clearTimeout(timeout); }
  report.uiExitCode = code;
  report.ui = JSON.parse(await fs.readFile(path.join(root, 'tray-ui-report.json'), 'utf8').catch(error => {
    throw new Error(`Native UI report unavailable (exit=${code}, timeout=${report.uiTimedOut === true}): ${stderr}`, { cause: error });
  }));
  assert.equal(code, 0, JSON.stringify(report.ui)); assert.equal(report.ui.success, true);
  for (const [index, { client }] of children.entries()) {
    const response = await client.callTool({ name: 'wincode_hello_world', arguments: {} });
    assert.notEqual(response.isError, true);
    const hello = JSON.parse(response.content[0].text);
    assert.equal(hello.health.roslyn.processAlive, index === 1);
  }
  report.scenarios.push('Both independent stdio MCP connections remain usable after Tray exits; only the selected fixture was released');
  await verifyProductionEntry();
  report.success = true;
} catch (error) { report.error = String(error.stack ?? error); process.exitCode = 1; }
finally {
  for (const { client } of children) await client.close().catch(() => {});
  if (tray && tray.exitCode === null && tray.signalCode === null) tray.kill();
  report.stderr = stderr;
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`[tray] ${report.success ? 'passed' : 'failed'}: ${path.join(root, 'report.json')}`);
}
