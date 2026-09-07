import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { FlaUiAdapter } from '../src/Adapters/FlaUiAdapter.js';
import { getDefaultConfig } from '../src/Core/Config.js';
import { ResourceManager, killProcessTree } from '../src/Core/ResourceManager.js';
import { UiErrorCodes } from '../src/Core/UiContracts.js';

describe('FlaUiAdapter Unit & Lifecycle Suite', () => {
  const root = process.cwd();
  let resources: ResourceManager;
  let adapter: FlaUiAdapter;
  let wpfProc: ChildProcess | null = null;
  let wpfPid: number = 0;
  let wpfHwnd: string = '';

  before(async () => {
    resources = new ResourceManager();
    const config = getDefaultConfig(root);
    adapter = new FlaUiAdapter(config, resources);
    await adapter.initialize();

    // Start the WPF fixture app and await READY signal
    const fixtureExe = path.resolve(root, 'tests/fixtures/wpf-ui-review/bin/Release/net10.0-windows/win-x64/publish/wpf-ui-review.exe');
    const isExe = fs.existsSync(fixtureExe);
    const cmd = isExe ? fixtureExe : 'dotnet';
    const args = isExe ? ['--auto-close=60000'] : ['run', '--project', 'tests/fixtures/wpf-ui-review/wpf-ui-review.csproj', '--no-build', '--', '--auto-close=60000'];

    wpfProc = spawn(cmd, args, {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: false,
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WPF fixture start timed out waiting for READY')), 12000);
      let buffer = '';
      wpfProc?.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const match = buffer.match(/READY\s+(\d+)\s+(0x[0-9a-fA-F]+)/);
        if (match) {
          clearTimeout(timer);
          wpfPid = parseInt(match[1], 10);
          wpfHwnd = match[2];
          resolve();
        }
      });
      wpfProc?.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  });

  after(async () => {
    await adapter.dispose();
    if (wpfProc && wpfPid) {
      try {
        await killProcessTree(wpfProc);
      } catch {
        // cleanup
      }
    }
    await resources.dispose();
  });

  it('1. checkHealth reports available and responsive', async () => {
    const health = await adapter.checkHealth();
    assert.strictEqual(health.available, true);
    assert.strictEqual(health.source, 'installed');
  });

  it('2. checkHealth reports unavailable when adapter is disabled', async () => {
    const disabledConfig = getDefaultConfig(root);
    disabledConfig.adapters.flaui.enabled = false;
    const disabledAdapter = new FlaUiAdapter(disabledConfig);
    const health = await disabledAdapter.checkHealth();
    assert.strictEqual(health.available, false);
  });

  it('3. inspect rejects empty arguments with INVALID_ARGUMENT', async () => {
    const res = await adapter.inspect({
      requestId: 'req-invalid',
      pid: 0,
    });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.errorCode, UiErrorCodes.INVALID_ARGUMENT);
  });

  it('4. inspect live WPF fixture returns complete node tree and annotated screenshot', async () => {
    assert.ok(wpfPid > 0, 'WPF fixture PID must be ready');
    const res = await adapter.inspect({
      requestId: 'req-live-1',
      pid: wpfPid,
      hwnd: wpfHwnd,
      capture: 'annotated',
      maxDepth: 6,
      maxNodes: 50,
    });

    assert.strictEqual(res.success, true);
    assert.ok(res.tree, 'Result must contain tree root');
    assert.strictEqual(res.tree?.controlType, 'Window');
    assert.ok((res.totalNodes ?? 0) >= 15, `Expected >= 15 nodes, got ${res.totalNodes}`);
    assert.strictEqual(res.truncated, false);
    assert.ok(res.annotatedPngBase64 && res.annotatedPngBase64.length > 500, 'Expected base64 PNG screenshot');
    assert.ok(res.captureMethod, 'Expected captureMethod in response');

    // Find specific controls
    const allAutoIds: string[] = [];
    const collectIds = (n?: any) => {
      if (!n) return;
      if (n.automationId) allAutoIds.push(n.automationId);
      if (n.children) n.children.forEach(collectIds);
    };
    collectIds(res.tree);

    assert.ok(allAutoIds.includes('btnNormalAction'), 'Must find normal button');
    assert.ok(allAutoIds.includes('btnDisabledAction'), 'Must find disabled button');
    assert.ok(allAutoIds.includes('txtUsername'), 'Must find username textbox');
    assert.ok(allAutoIds.includes('duplicateItem'), 'Must find duplicateItem text');
  });

  it('5. maxDepth truncation sets truncated: true and bounds maxDepthReached', async () => {
    const res = await adapter.inspect({
      requestId: 'req-trunc-depth',
      pid: wpfPid,
      hwnd: wpfHwnd,
      capture: 'none',
      maxDepth: 2,
      maxNodes: 50,
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.truncated, true);
    assert.ok((res.maxDepthReached ?? 0) <= 2, `Depth reached ${res.maxDepthReached} should be <= 2`);
  });

  it('6. maxNodes truncation sets truncated: true and caps totalNodes', async () => {
    const res = await adapter.inspect({
      requestId: 'req-trunc-nodes',
      pid: wpfPid,
      hwnd: wpfHwnd,
      capture: 'none',
      maxDepth: 6,
      maxNodes: 8,
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.truncated, true);
    assert.ok((res.totalNodes ?? 0) <= 8, `Total nodes ${res.totalNodes} should be <= 8`);
  });

  it('7. timeout aborts helper, returns TIMEOUT, target WPF remains alive, and next inspect succeeds', async () => {
    // Call with an impractically short timeout of 1ms
    const res = await adapter.inspect({
      requestId: 'req-short-timeout',
      pid: wpfPid,
      hwnd: wpfHwnd,
      timeoutMs: 1,
    });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.errorCode, UiErrorCodes.TIMEOUT);
    assert.strictEqual(adapter.isRunning, false, 'Helper process must not be running after timeout');

    // Target process must remain running!
    let targetAlive = false;
    try {
      process.kill(wpfPid, 0);
      targetAlive = true;
    } catch {
      targetAlive = false;
    }
    assert.strictEqual(targetAlive, true, 'Target WPF application must remain alive after helper timeout');

    // Subsequent inspect must succeed promptly without collision or leftover helper
    const nextRes = await adapter.inspect({
      requestId: 'req-after-timeout',
      pid: wpfPid,
      hwnd: wpfHwnd,
      maxDepth: 2,
    });
    assert.strictEqual(nextRes.success, true);
    assert.strictEqual(adapter.isRunning, false);
  });

  it('8. concurrent inspect calls are serialized safely by mutex', async () => {
    const p1 = adapter.inspect({
      requestId: 'req-concurrent-1',
      pid: wpfPid,
      hwnd: wpfHwnd,
      maxDepth: 3,
    });
    const p2 = adapter.inspect({
      requestId: 'req-concurrent-2',
      pid: wpfPid,
      hwnd: wpfHwnd,
      maxDepth: 3,
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    assert.strictEqual(r1.success, true);
    assert.strictEqual(r2.success, true);
    assert.strictEqual(r1.requestId, 'req-concurrent-1');
    assert.strictEqual(r2.requestId, 'req-concurrent-2');
  });

  it('9. dispose marks shutting down and rejects subsequent requests', async () => {
    const freshConfig = getDefaultConfig(root);
    const tempAdapter = new FlaUiAdapter(freshConfig);
    await tempAdapter.dispose();

    const res = await tempAdapter.inspect({
      requestId: 'req-after-dispose',
      pid: wpfPid,
    });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.errorCode, UiErrorCodes.SHUTDOWN);
  });

  it('10. AbortSignal cancellation returns CANCELLED, aborts helper promptly, and next inspect succeeds', async () => {
    const ac = new AbortController();
    const pending = adapter.inspect(
      {
        requestId: 'req-cancelled',
        pid: wpfPid,
        hwnd: wpfHwnd,
        maxDepth: 6,
      },
      ac.signal
    );

    // Obtain the real spawned helper PID before cancellation; never skip this assertion.
    const deadline = Date.now() + 2000;
    while (!(adapter as any).activeProcess?.pid && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    const helperPid = (adapter as any).activeProcess?.pid;
    assert.ok(helperPid, 'Expected an actual helper PID');
    ac.abort();
    const res = await pending;
    assert.throws(() => process.kill(helperPid, 0), (err: any) => err.code === 'ESRCH');

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.errorCode, UiErrorCodes.CANCELLED);
    assert.strictEqual(adapter.isRunning, false, 'Helper process must not linger after cancellation');

    // Subsequent inspect must succeed without leftover helper
    const nextRes = await adapter.inspect({
      requestId: 'req-after-cancelled',
      pid: wpfPid,
      hwnd: wpfHwnd,
      maxDepth: 2,
    });
    assert.strictEqual(nextRes.success, true);
    assert.strictEqual(adapter.isRunning, false);
  });

  it('11. Cancelling queued request immediately aborts and does not block the third request', async () => {
    // p1: active request
    const p1 = adapter.inspect({
      requestId: 'req-queue-1',
      pid: wpfPid,
      hwnd: wpfHwnd,
      maxDepth: 3,
    });

    // p2: queued request with abort signal
    const ac2 = new AbortController();
    const p2 = adapter.inspect(
      {
        requestId: 'req-queue-2',
        pid: wpfPid,
        hwnd: wpfHwnd,
        maxDepth: 3,
      },
      ac2.signal
    );

    // p3: normal queued request
    const p3 = adapter.inspect({
      requestId: 'req-queue-3',
      pid: wpfPid,
      hwnd: wpfHwnd,
      maxDepth: 2,
    });

    // Abort p2 while it is waiting in queue
    ac2.abort();

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    assert.strictEqual(r1.success, true, 'Task 1 must succeed');
    assert.strictEqual(r2.success, false, 'Task 2 must be cancelled');
    assert.strictEqual(r2.errorCode, UiErrorCodes.CANCELLED);
    assert.strictEqual(r3.success, true, 'Task 3 must succeed after task 2 was cancelled in queue');
    assert.strictEqual(adapter.isRunning, false);
  });

  it('12. enabled=false rejects inspect immediately at entry without helper spawn', async () => {
    const disabledConfig = getDefaultConfig(root);
    disabledConfig.adapters.flaui.enabled = false;
    const disabledAdapter = new FlaUiAdapter(disabledConfig);

    const res = await disabledAdapter.inspect({
      requestId: 'req-disabled',
      pid: wpfPid,
      hwnd: wpfHwnd,
    });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.errorCode, UiErrorCodes.HOST_UNAVAILABLE);
    assert.ok(res.errorMessage?.includes('disabled'));
    assert.strictEqual(disabledAdapter.isRunning, false);
  });

  it('13. explicit customHostPath error clearly reports configured path not found', async () => {
    const badConfig = getDefaultConfig(root);
    badConfig.adapters.flaui.customHostPath = 'C:\\non_existent_tools\\WinCode.UIA.Host.exe';
    const badAdapter = new FlaUiAdapter(badConfig);

    const health = await badAdapter.checkHealth(1000);
    assert.strictEqual(health.available, false);
    assert.ok(health.details?.includes('Configured customHostPath'));

    const res = await badAdapter.inspect({
      requestId: 'req-bad-path',
      pid: wpfPid,
      hwnd: wpfHwnd,
    });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.errorCode, UiErrorCodes.HOST_UNAVAILABLE);
    assert.ok(res.errorMessage?.includes('Configured customHostPath'));
  });
});
