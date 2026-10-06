import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { WinCodeSession } from '../src/Client/SkillSession.js';
import type { UiReader, UiTarget } from '../src/Client/ReadonlyUiWorkflow.js';
import { killProcessTree, withTimeout } from '../src/Core/ResourceManager.js';

const root = path.resolve(import.meta.dirname, '..');
const summary = { query: { automationId: 'hybridSummary' }, readStates: true, maxDepth: 2, maxNodes: 8 };
const detail = { query: { automationId: 'hybridChecks' }, readStates: true, maxDepth: 4, maxNodes: 40 };
const parse = (result: Awaited<ReturnType<WinCodeSession['call']>>) => {
  const text = result.content.find(block => block.type === 'text');
  assert.ok(text?.type === 'text'); return JSON.parse(text.text);
};
const exited = (pid: number) => assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });

async function fixture(marker?: string) {
  const child = spawn(path.join(root, 'tests/fixtures/wpf-ui-review/bin/Release/net10.0-windows/win-x64/publish/wpf-ui-review.exe'),
    ['--background-fixture', '--hybrid-fixture', '--auto-close=90000'],
    { cwd: root, env: { ...process.env, ...(marker ? { WINCODE_TEST_UI_HOLD_MARKER: marker } : {}) },
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  let error = '';
  child.stderr!.on('data', chunk => { error = (error + chunk.toString()).slice(-2048); });
  try {
    const target = await withTimeout(new Promise<UiTarget>((resolve, reject) => {
      let text = '';
      child.stdout!.on('data', chunk => {
        text += chunk.toString();
        const found = text.match(/READY (\d+) (0x[\dA-F]+)/);
        if (found) resolve({ pid: Number(found[1]), hwnd: found[2] });
        text = text.slice(-4096);
      });
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`Fixture exited ${code}: ${error}`)));
    }), 10000, 'Hybrid session fixture readiness');
    return { child, closed, target };
  } catch (error) { await stopFixture(child, closed); throw error; }
}

async function stopFixture(child: ChildProcess, closed: Promise<void>) {
  await killProcessTree(child);
  await withTimeout(closed, 5000, 'Hybrid session fixture exit');
  if (child.pid) exited(child.pid);
}

it('closing a cold session cancels processing between reads and rejects further workflow use', async () => {
  const session = new WinCodeSession({ workspace: root });
  let reader: UiReader | undefined, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const running = session.readonlyUiWorkflow({ pid: 1, hwnd: '0x1' }, async current => {
    reader = current; entered(); return new Promise(() => {});
  }, { timeoutMs: 30000 });
  await ready;
  assert.equal(session.status.pid, null, 'client-only processing must not spawn a Gateway');
  await withTimeout(session.close(), 1000, 'Close must cancel the workflow rather than await its deadline');
  const result = await running;
  assert.equal(result.report.errorCode, 'CANCELLED');
  assert.equal(result.report.metrics.dispatchedCalls, 0);
  await assert.rejects(reader!.inspect(summary), /already returned/);
  assert.throws(() => session.readonlyUiWorkflow({ pid: 1, hwnd: '0x1' }, async () => null), /closed/);
  assert.equal(session.status.state, 'closed'); assert.equal(session.status.pid, null);
});

it('the session API reuses a real Gateway for conditional UI reads and delivers the native screenshot',
  { skip: process.platform !== 'win32', timeout: 40000 }, async () => {
    const f = await fixture(), session = new WinCodeSession({ workspace: root });
    try {
      const listed = parse(await session.call('wincode_ui_list_windows', { pid: f.target.pid, maxWindows: 8 }));
      assert.ok(listed.windows.some((window: UiTarget) => window.pid === f.target.pid && BigInt(window.hwnd) === BigInt(f.target.hwnd)));
      const before = session.status;
      const result = await session.readonlyUiWorkflow(f.target, async reader => {
        const value = await reader.inspect({ ...summary, capture: 'original' });
        assert.equal(value.tree?.states?.toggle, 'On');
        const checks = await reader.inspect(detail);
        const rows = checks.tree!.children.flatMap(node => [node, ...node.children])
          .filter(node => /^hybridCheck\d$/.test(node.automationId ?? ''));
        assert.equal(rows.length, 8);
        return { unchecked: rows.filter(node => node.states?.toggle === 'Off').map(node => node.automationId),
          disabled: rows.filter(node => node.isEnabled === false).map(node => node.automationId) };
      });
      assert.equal(result.isError, false, result.content[0].text);
      assert.deepEqual(result.report.findings, { unchecked: ['hybridCheck3'], disabled: ['hybridCheck6'] });
      assert.deepEqual(result.report.steps.map(step => step.status), ['completed', 'completed']);
      assert.equal(result.report.steps[0].imageContentIndex, 1);
      assert.equal(result.content[1]?.type, 'image');
      assert.equal(session.status.pid, before.pid); assert.deepEqual(session.status.identity, before.identity);
      const output = await fs.mkdtemp(path.join(root, 'test-tmp', 'hybrid-session-'));
      await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result.report, null, 2));
      const image = result.content[1]; assert.equal(image.type, 'image');
      await fs.writeFile(path.join(output, 'fixture.png'), Buffer.from(image.data, 'base64'));
      console.log(JSON.stringify({ hybridSessionArtifacts: output }));
      await session.close(); exited(before.pid!);
    } finally { await session.close(); await stopFixture(f.child, f.closed); }
  });

it('session close interrupts a real UIA provider, preserves completed evidence and prevents a queued read',
  { skip: process.platform !== 'win32', timeout: 40000 }, async () => {
    const output = await fs.mkdtemp(path.join(root, 'test-tmp', 'hybrid-session-close-'));
    const marker = path.join(output, 'entered'), f = await fixture(marker);
    const session = new WinCodeSession({ workspace: root });
    let helperPid: number | undefined;
    try {
      const running = session.readonlyUiWorkflow(f.target, async reader => {
        await reader.inspect(summary);
        await fs.writeFile(marker + '.armed', 'armed');
        await Promise.all([reader.inspect({}), reader.inspect(detail)]);
      });
      const deadline = Date.now() + 10000;
      while (!(await fs.stat(marker).catch(() => null))) {
        assert.ok(Date.now() < deadline, 'real UIA provider must enter before close');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      helperPid = parse(await session.call('wincode_hello_world')).health.flaui.runtime.activePid;
      assert.ok(helperPid);
      const gatewayPid = session.status.pid!;
      await withTimeout(session.close(), 10000, 'Close workflow and native processes');
      const result = await running;
      assert.equal(result.report.errorCode, 'CANCELLED');
      assert.equal(result.report.metrics.dispatchedCalls, 2);
      assert.deepEqual(result.report.steps.map(step => step.status), ['completed', 'failed', 'not_started']);
      assert.ok(result.report.steps[0].requestId); assert.ok(result.report.steps[0].evidence);
      exited(helperPid); exited(gatewayPid);
      await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ report: result.report, helperExited: true, gatewayExited: true }, null, 2));
      console.log(JSON.stringify({ hybridSessionCloseArtifacts: output }));
    } finally {
      await session.close(); await fs.writeFile(marker + '.release', 'release');
      await stopFixture(f.child, f.closed);
    }
  });
