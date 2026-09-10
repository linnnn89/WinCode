import { it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { killProcessTree, withTimeout } from '../src/Core/ResourceManager.js';

const fixture = path.resolve('tests/fixtures/owner-guard-check/bin/Release/net10.0/owner-guard-check.dll');
const dotnet = process.env.DOTNET_HOST_PATH || path.resolve('.deps/dotnet-10.0.303/dotnet.exe');
const options = { skip: process.platform !== 'win32', timeout: 30000 };
const bootstrap = `
const { spawn } = require('node:child_process');
const env = { ...process.env, WINCODE_OWNER_PID: process.env.TEST_OWNER_OVERRIDE || String(process.pid) };
let child;
if (process.env.TEST_WRAPPER === '1') {
  env.TEST_WRAPPER = '0'; env.TEST_OWNER_OVERRIDE = env.WINCODE_OWNER_PID;
  child = spawn(process.execPath, ['-e', process.env.TEST_BOOTSTRAP], { env, stdio: ['ignore', 1, 2], windowsHide: true, detached: true });
} else {
  child = spawn(process.env.TEST_DOTNET, [process.env.TEST_GUARD, process.env.TEST_MODE], { env, stdio: ['ignore', 1, 2], windowsHide: true, detached: true });
}
child.on('error', e => { console.error(e); process.exit(1); });
child.on('exit', code => process.exit(code || 0));
process.stdin.resume();
`;
interface Record { stage: string; pid: number; created: string }

async function scenario(mode: string, run: (owner: ChildProcessWithoutNullStreams, closed: Promise<number | null>, records: Record[], logs: () => string) => Promise<void>, extra: NodeJS.ProcessEnv = {}) {
  const owner = spawn(process.execPath, ['-e', bootstrap], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, TEST_MODE: mode, TEST_DOTNET: dotnet, TEST_GUARD: fixture, TEST_BOOTSTRAP: bootstrap, ...extra } });
  const closed = new Promise<number | null>((resolve, reject) => { owner.on('close', resolve); owner.on('error', reject); });
  owner.stdin.on('error', () => {});
  let buffer = '', stderr = '';
  const records: Record[] = [];
  owner.stdout.on('data', data => {
    buffer += data.toString();
    const lines = buffer.split('\n'); buffer = lines.pop()!;
    for (const line of lines) if (line.trim()) records.push(JSON.parse(line));
  });
  owner.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-8192); });
  try { await run(owner, closed, records, () => stderr); }
  finally {
    if (owner.exitCode === null && owner.signalCode === null) await killProcessTree(owner);
    for (const record of records.filter((value, index, all) => all.findIndex(item => item.pid === value.pid) === index)) {
      assert.ok(Number.isSafeInteger(record.pid) && record.pid > 0 && /^\d+$/.test(record.created));
      // 捕获的创建时间必须匹配；先持有实际对象句柄，避免在核验与清理之间复用 PID。
      const script = `$ErrorActionPreference = 'Stop'; $p = Get-Process -Id ${record.pid} -ErrorAction SilentlyContinue; if ($p) { try { $h = $p.SafeHandle; if ($p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -eq '${record.created}') { $p.Kill(); $p.WaitForExit(3000) | Out-Null } } finally { $p.Dispose() } }; exit 0`;
      await promisify(execFile)('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true, timeout: 5000 });
    }
    await withTimeout(closed, 5000, 'owner fixture cleanup');
  }
}
async function stage(records: Record[], name: string, logs: () => string) {
  const deadline = Date.now() + 8000;
  while (!records.some(record => record.stage === name)) {
    if (Date.now() >= deadline) throw new Error(`Missing ${name}: ${logs()}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

for (const mode of ['normal', 'repeat']) it(`owner guard supports ${mode} disposal without handle accumulation`, options, async () => {
  await scenario(mode, async (_owner, closed, records, logs) => {
    assert.equal(await withTimeout(closed, 10000, 'normal guard exit'), 0, logs());
    assert.ok(records.some(record => record.stage === (mode === 'repeat' ? 'repeat-complete' : 'attached')));
  });
});
for (const mode of ['native-block', 'blocked-callback', 'cooperative', 'early-owner-death'])
  it(`owner death stops the Helper during ${mode} without a tree kill`, options, async () => {
    await scenario(mode, async (owner, closed, records, logs) => {
      await stage(records, mode === 'early-owner-death' ? 'before-attach' : 'attached', logs);
      process.kill(owner.pid!, 'SIGKILL');
      // 子进程继承同一 stdout pipe；close 只有在 Helper 也关闭写端后才触发。
      await withTimeout(closed, 7000, 'orphaned Helper exit');
      for (const record of records) assert.throws(() => process.kill(record.pid, 0), /ESRCH/, 'Helper survived');
    });
  });
it('owner identity follows an explicit ancestor through a startup wrapper', options, async () => {
  await scenario('native-block', async (owner, closed, records, logs) => {
    await stage(records, 'attached', logs);
    process.kill(owner.pid!, 'SIGKILL');
    await withTimeout(closed, 7000, 'wrapped Helper exit');
    assert.throws(() => process.kill(records[0].pid, 0), /ESRCH/);
  }, { TEST_WRAPPER: '1' });
});
for (const invalid of ['0', 'not-a-pid', '4294967295']) it(`owner guard rejects invalid or unrelated owner ${invalid}`, options, async () => {
  await scenario('normal', async (_owner, closed, records, logs) => {
    assert.equal(await withTimeout(closed, 8000, 'invalid owner exit'), 1);
    assert.equal(records.length, 0, 'No work may start without a verified owner');
    assert.match(logs(), /owner|owning|process/i);
  }, { TEST_OWNER_OVERRIDE: invalid });
});
it('the Helper cannot declare itself as its owner', options, async () => {
  await scenario('self-owner', async (_owner, closed, records) => {
    assert.equal(await withTimeout(closed, 8000, 'self owner rejection'), 1);
    assert.equal(records.length, 0);
  });
});

it('owner death leaves a second independent owner and Helper alive', options, async () => {
  await scenario('native-block', async (otherOwner, _otherClosed, otherRecords, otherLogs) => {
    await stage(otherRecords, 'attached', otherLogs);
    await scenario('native-block', async (owner, closed, records, logs) => {
      await stage(records, 'attached', logs);
      process.kill(owner.pid!, 'SIGKILL');
      await withTimeout(closed, 7000, 'first Helper exit');
      assert.throws(() => process.kill(records[0].pid, 0), /ESRCH/);
      assert.doesNotThrow(() => process.kill(otherOwner.pid!, 0));
      assert.doesNotThrow(() => process.kill(otherRecords[0].pid, 0));
    });
  });
});

it('production UIA still treats stdin EOF as the request boundary', options, async () => {
  const host = path.resolve('tools/WinCode.UIA.Host/bin/Release/net10.0-windows/win-x64/publish/WinCode.UIA.Host.dll');
  const child = spawn(dotnet, [host], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, WINCODE_OWNER_PID: String(process.pid) } });
  const closed = new Promise<number | null>((resolve, reject) => { child.on('close', resolve); child.on('error', reject); });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data.toString(); });
  child.stderr.on('data', data => { stderr += data.toString(); });
  child.stdin.on('error', () => {});
  try {
    child.stdin.end(JSON.stringify({ action: 'health', requestId: 'owner-eof' }));
    assert.equal(await withTimeout(closed, 8000, 'UIA EOF response'), 0, stderr);
    const response = JSON.parse(stdout);
    assert.equal(response.success, true);
    assert.equal(response.status, 'healthy');
    assert.equal(response.requestId, 'owner-eof');
  } finally {
    if (child.exitCode === null && child.signalCode === null) await killProcessTree(child);
    await withTimeout(closed, 5000, 'UIA cleanup');
  }
});

