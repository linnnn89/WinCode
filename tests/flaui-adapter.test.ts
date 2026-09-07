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

  it('7. timeout aborts helper, returns TIMEOUT, and target WPF fixture remains alive', async () => {
    // Call with an impractically short timeout of 1ms
    const res = await adapter.inspect({
      requestId: 'req-short-timeout',
      pid: wpfPid,
      hwnd: wpfHwnd,
      timeoutMs: 1,
    });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.errorCode, UiErrorCodes.TIMEOUT);

    // Target process must remain running!
    let targetAlive = false;
    try {
      process.kill(wpfPid, 0);
      targetAlive = true;
    } catch {
      targetAlive = false;
    }
    assert.strictEqual(targetAlive, true, 'Target WPF application must remain alive after helper timeout');
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

  it('10. AbortSignal cancellation returns CANCELLED and aborts helper promptly', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 10);
    const res = await adapter.inspect(
      {
        requestId: 'req-cancelled',
        pid: wpfPid,
        hwnd: wpfHwnd,
        maxDepth: 6,
      },
      ac.signal
    );

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.errorCode, UiErrorCodes.CANCELLED);
  });
});
