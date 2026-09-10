import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn, ChildProcess } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/client';
import { ToolRouter } from '../src/Core/ToolRouter.js';
import { WinCodeMcpServer } from '../src/Gateway/McpServer.js';
import { getDefaultConfig } from '../src/Core/Config.js';
import { killProcessTree } from '../src/Core/ResourceManager.js';
import { UiErrorCodes, UiInspectResult } from '../src/Core/UiContracts.js';

describe('WinCode MCP UI Inspect Protocol & End-to-End Suite', () => {
  const root = process.cwd();
  const testCacheDir = path.resolve(root, 'test-tmp/mcp_ui_inspect_test');
  let router: ToolRouter;
  let server: WinCodeMcpServer;
  let client: Client;
  let clientTransport: any;
  let serverTransport: any;

  let wpfProc: ChildProcess | null = null;
  let wpfPid = 0;
  let wpfHwnd = '';

  before(async () => {
    await fsPromises.mkdir(testCacheDir, { recursive: true });

    // 1. Setup WinCode ToolRouter and McpServer
    const config = getDefaultConfig(root);
    config.cacheDir = path.join(testCacheDir, 'cache');
    router = new ToolRouter(config);
    server = new WinCodeMcpServer(router);
    await router.initialize();

    // 2. Setup In-Memory MCP Client-Server connection
    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await (server as any).server.connect(serverTransport);

    client = new Client(
      { name: 'ui-inspect-mcp-test-runner', version: '1.0.0' },
      { capabilities: {} }
    );
    await client.connect(clientTransport);

    // 3. Launch WPF Fixture
    const fixtureExe = path.resolve(
      root,
      'tests/fixtures/wpf-ui-review/bin/Release/net10.0-windows/win-x64/publish/wpf-ui-review.exe'
    );
    const isExe = fsSync.existsSync(fixtureExe);
    const cmd = isExe ? fixtureExe : 'dotnet';
    const args = isExe
      ? ['--auto-close=60000']
      : [
          'run',
          '--project',
          'tests/fixtures/wpf-ui-review/wpf-ui-review.csproj',
          '--no-build',
          '--',
          '--auto-close=60000',
        ];

    wpfProc = spawn(cmd, args, {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: false,
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('WPF fixture launch timed out waiting for READY')),
        15000
      );
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
      wpfProc?.on('close', (code) => {
        clearTimeout(timer);
        reject(new Error(`WPF fixture exited prematurely with code ${code}`));
      });
    });

    // Brief delay to allow WPF window to be composited
    await new Promise((r) => setTimeout(r, 400));
  });

  after(async () => {
    // 1. Terminate WPF fixture cleanly
    if (wpfProc) {
      await killProcessTree(wpfProc).catch(() => {});
      wpfProc = null;
    }

    // 2. Disconnect MCP client and stop server
    try {
      await client?.close();
    } catch {}
    try {
      await server?.stop();
    } catch {}

    // 3. Clean test cache directory
    await fsPromises.rm(testCacheDir, { recursive: true, force: true }).catch(() => {});
  });

  it('1. tools/list exposes wincode_ui_inspect with compliant schema', async () => {
    const res = await client.listTools();
    const tool = res.tools.find((t) => t.name === 'wincode_ui_inspect');
    assert.ok(tool, 'wincode_ui_inspect must be present in tools list');
    assert.ok(tool.description?.includes('UI Automation'));
    const schema = tool.inputSchema as Record<string, any>;
    const props = schema.properties as Record<string, any>;
    assert.strictEqual(props.pid.type, 'integer');
    assert.ok(props.hwnd);
    assert.ok(props.capture);
    assert.deepStrictEqual(props.capture.enum, ['none', 'original', 'annotated']);
    assert.strictEqual(props.capture.default, 'none');
    assert.strictEqual(props.maxDepth.default, 6);
    assert.strictEqual(props.maxNodes.default, 300);
    assert.ok(Array.isArray(schema.anyOf), 'Must have anyOf requiring pid or hwnd');
  });

  function getContent(res: any): Array<{ type: string; text?: string; data?: string; mimeType?: string }> {
    return (res as any).content;
  }

  it('2. wincode_hello_world exposes flaui adapter and ui inspect capability', async () => {
    const res = await client.callTool({
      name: 'wincode_hello_world',
      arguments: {},
    });
    assert.ok(!res.isError);
    const data = JSON.parse(getContent(res)[0].text!);
    assert.ok(data.adapters.flaui, 'flaui adapter must be reported');
    assert.strictEqual(data.adapters.flaui.available, null, 'Unused UIA must remain unprobed');
    assert.strictEqual(data.adapters.flaui.source, 'unknown');
    assert.ok(data.capabilities.includes('wincode_ui_inspect'));
  });

  it('3. wincode_ui_inspect rejects missing pid/hwnd with INVALID_ARGUMENT', async () => {
    const res = await client.callTool({
      name: 'wincode_ui_inspect',
      arguments: {},
    });
    assert.strictEqual(res.isError, true);
    const data = JSON.parse(getContent(res)[0].text!);
    assert.strictEqual(data.success, false);
    assert.strictEqual(data.errorCode, UiErrorCodes.INVALID_ARGUMENT);
  });

  it('4. wincode_ui_inspect handles non-existent PID gracefully', async () => {
    const res = await client.callTool({
      name: 'wincode_ui_inspect',
      arguments: { pid: 999999 },
    });
    assert.strictEqual(res.isError, true);
    const data = JSON.parse(getContent(res)[0].text!);
    assert.strictEqual(data.success, false);
    assert.ok(
      [UiErrorCodes.WINDOW_NOT_FOUND, UiErrorCodes.NO_VISIBLE_WINDOWS, UiErrorCodes.HOST_ERROR].includes(data.errorCode),
      `Unexpected error code: ${data.errorCode}`
    );
  });

  it('5. wincode_ui_inspect live WPF fixture without screenshot (capture: none)', async () => {
    const res = await client.callTool({
      name: 'wincode_ui_inspect',
      arguments: { pid: wpfPid, capture: 'none' },
    });
    assert.ok(!res.isError);
    const content = getContent(res);
    assert.strictEqual(content.length, 1);
    assert.strictEqual(content[0].type, 'text');

    const data = JSON.parse(content[0].text!) as UiInspectResult;
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.pid, wpfPid);
    assert.ok(data.tree, 'Must return control tree root');
    assert.ok(data.totalNodes && data.totalNodes > 5, 'Must collect multiple control nodes');
    assert.strictEqual(data.annotatedPngBase64, undefined);
    assert.strictEqual(data.screenshotPngBase64, undefined);
  });

  it('6. wincode_ui_inspect live WPF fixture with annotated screenshot returns image block without polluting text JSON', async () => {
    const res = await client.callTool({
      name: 'wincode_ui_inspect',
      arguments: { pid: wpfPid, capture: 'annotated' },
    });
    assert.ok(!res.isError);
    const content = getContent(res);
    assert.strictEqual(content.length, 2, 'Must return text JSON block and image block');
    assert.strictEqual(content[0].type, 'text');
    assert.strictEqual(content[1].type, 'image');

    const data = JSON.parse(content[0].text!) as any;
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.hasScreenshot, true);
    assert.strictEqual(data.annotatedPngBase64, undefined, 'Base64 must NOT be in text JSON payload');
    assert.strictEqual(data.screenshotPngBase64, undefined, 'Base64 must NOT be in text JSON payload');

    const imageBlock = content[1];
    assert.strictEqual(imageBlock.mimeType, 'image/png');
    assert.ok(imageBlock.data && imageBlock.data.length > 500, 'Image block data must be non-empty base64');
    assert.ok(['unknown', 'suspect-low-variation'].includes(data.captureQuality?.status));
    assert.ok(data.captureQuality.sampleCount > 0 && data.captureQuality.sampleCount <= 1024);
  });

  it('7. wincode_ui_inspect live WPF fixture with raw screenshot returns image block without polluting text JSON', async () => {
    const res = await client.callTool({
      name: 'wincode_ui_inspect',
      arguments: { pid: wpfPid, capture: 'original' },
    });
    assert.ok(!res.isError);
    const content = getContent(res);
    assert.strictEqual(content.length, 2, 'Must return text JSON block and image block');
    assert.strictEqual(content[0].type, 'text');
    assert.strictEqual(content[1].type, 'image');

    const data = JSON.parse(content[0].text!) as any;
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.hasScreenshot, true);
    assert.strictEqual(data.screenshotPngBase64, undefined, 'Base64 must NOT be in text JSON payload');
    assert.strictEqual(data.annotatedPngBase64, undefined, 'Base64 must NOT be in text JSON payload');

    const imageBlock = content[1];
    assert.strictEqual(imageBlock.mimeType, 'image/png');
    assert.ok(imageBlock.data && imageBlock.data.length > 500);
    assert.ok(['unknown', 'suspect-low-variation'].includes(data.captureQuality?.status));
    assert.ok(data.captureQuality.sampleCount > 0 && data.captureQuality.sampleCount <= 1024);
  });

  it('8. wincode_ui_inspect targets WPF window via hwnd handle', async () => {
    const res = await client.callTool({
      name: 'wincode_ui_inspect',
      arguments: { hwnd: wpfHwnd },
    });
    assert.ok(!res.isError);
    const data = JSON.parse(getContent(res)[0].text!) as UiInspectResult;
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.pid, wpfPid);
  });

  it('9. wincode_ui_inspect honors maxDepth truncation parameter', async () => {
    const res = await client.callTool({
      name: 'wincode_ui_inspect',
      arguments: { pid: wpfPid, maxDepth: 1 },
    });
    assert.ok(!res.isError);
    const data = JSON.parse(getContent(res)[0].text!) as UiInspectResult;
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.truncated, true);
    assert.strictEqual(data.truncateReason, 'maxDepth');
    assert.ok(data.maxDepthReached !== undefined && data.maxDepthReached <= 1);
  });

  it('10. target application survives all MCP inspections and helper process terminates', async () => {
    assert.ok(wpfProc?.pid, 'WPF fixture PID must exist');
    let alive = false;
    try {
      process.kill(wpfProc!.pid!, 0);
      alive = true;
    } catch {
      alive = false;
    }
    assert.strictEqual(alive, true, 'Target WPF application must remain alive throughout all MCP inspections');
    assert.strictEqual((router.flaui as any).activeProcess, null, 'FlaUI helper must not linger after inspections');
  });

  it('11. wincode_ui_inspect strictly validates and rejects invalid arguments', async () => {
    // Non-positive pid
    const resPid = await client.callTool({
      name: 'wincode_ui_inspect',
      arguments: { pid: 0 },
    });
    assert.strictEqual(resPid.isError, true);
    assert.strictEqual(JSON.parse(getContent(resPid)[0].text!).errorCode, 'INVALID_ARGUMENT');

    // Invalid capture mode
    const resCap = await client.callTool({
      name: 'wincode_ui_inspect',
      arguments: { pid: wpfPid, capture: 'invalid_mode' },
    });
    assert.strictEqual(resCap.isError, true);
    assert.strictEqual(JSON.parse(getContent(resCap)[0].text!).errorCode, 'INVALID_ARGUMENT');

    // Negative maxDepth
    const resDepth = await client.callTool({
      name: 'wincode_ui_inspect',
      arguments: { pid: wpfPid, maxDepth: -1 },
    });
    assert.strictEqual(resDepth.isError, true);
    assert.strictEqual(JSON.parse(getContent(resDepth)[0].text!).errorCode, 'INVALID_ARGUMENT');

    // Out of range maxNodes
    const resNodes = await client.callTool({
      name: 'wincode_ui_inspect',
      arguments: { pid: wpfPid, maxNodes: 999999 },
    });
    assert.strictEqual(resNodes.isError, true);
    assert.strictEqual(JSON.parse(getContent(resNodes)[0].text!).errorCode, 'INVALID_ARGUMENT');
  });

  it('12. concurrent inspect calls are safely serialized by Mutex without collision or hang', async () => {
    const [res1, res2] = await Promise.all([
      client.callTool({
        name: 'wincode_ui_inspect',
        arguments: { pid: wpfPid, capture: 'none', maxDepth: 2 },
      }),
      client.callTool({
        name: 'wincode_ui_inspect',
        arguments: { pid: wpfPid, capture: 'none', maxDepth: 2 },
      }),
    ]);

    assert.ok(!res1.isError);
    assert.ok(!res2.isError);
    const data1 = JSON.parse(getContent(res1)[0].text!);
    const data2 = JSON.parse(getContent(res2)[0].text!);
    assert.strictEqual(data1.success, true);
    assert.strictEqual(data2.success, true);
    assert.strictEqual(data1.pid, wpfPid);
    assert.strictEqual(data2.pid, wpfPid);
  });

  it('13. real MCP client cancellation propagates signal, aborts helper, and next inspect succeeds', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    let threw = false;
    try {
      await client.callTool(
        {
          name: 'wincode_ui_inspect',
          arguments: { pid: wpfPid, capture: 'annotated', maxDepth: 6 },
        },
        { signal: ac.signal }
      );
    } catch (err: any) {
      threw = true;
      assert.ok(
        err.message.includes('aborted') || err.message.includes('AbortError'),
        `Expected abort error, got: ${err.message}`
      );
    }
    assert.strictEqual(threw, true, 'client.callTool with aborted signal must reject');

    // Client cancellation precedes server cleanup; wait for its terminal state,
    // not a scheduler-dependent 200ms sleep. Keep the exit assertion below.
    const cleanupDeadline = Date.now() + 4000;
    while ((router.flaui as any).activeProcess !== null && Date.now() < cleanupDeadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.strictEqual((router.flaui as any).activeProcess, null, 'Helper process must not linger after MCP cancellation');

    // Subsequent normal inspect must succeed without leftover process
    const nextRes = await client.callTool({
      name: 'wincode_ui_inspect',
      arguments: { pid: wpfPid, capture: 'none', maxDepth: 2 },
    });
    assert.ok(!nextRes.isError);
    const nextData = JSON.parse(getContent(nextRes)[0].text!);
    assert.strictEqual(nextData.success, true);
  });

  it('14. a rejected switch preserves UI access and an independent external workspace resolves the installed helper', async () => {
    const tempWs = path.resolve(root, 'test-tmp/external_wpf_target');
    await fsPromises.mkdir(tempWs, { recursive: true });

    // The external directory has no tools/ folder and requires its own connection.
    const switchRes = await client.callTool({
      name: 'workspace_open',
      arguments: { path: tempWs },
    });
    assert.strictEqual(switchRes.isError, true);
    assert.strictEqual(JSON.parse(getContent(switchRes)[0].text!).errorCode, 'WORKSPACE_MISMATCH');
    assert.strictEqual(router.config.workspaceRoot, root);
    const peerConfig = getDefaultConfig(tempWs);
    peerConfig.adapters.repomix.useCli = false;
    const peerRouter = new ToolRouter(peerConfig), peerServer = new WinCodeMcpServer(peerRouter);
    const peer = new Client({ name: 'external-ui-workspace', version: '1' });
    try {
      await peerRouter.initialize();
      const [left, right] = InMemoryTransport.createLinkedPair();
      await Promise.all([peer.connect(left), (peerServer as any).server.connect(right)]);
      for (const connection of [client, peer]) {
        const res = await connection.callTool({ name: 'wincode_ui_inspect',
          arguments: { pid: wpfPid, capture: 'none', maxDepth: 2 } });
        assert.ok(!res.isError);
        const data = JSON.parse(getContent(res)[0].text!);
        assert.strictEqual(data.success, true);
        assert.strictEqual(data.pid, wpfPid);
      }
    } finally { await peer.close(); await peerServer.stop(); }
  });

  it('15. inspect returns image scale and dimension metadata preserving coordinate alignment', async () => {
    const res = await client.callTool({
      name: 'wincode_ui_inspect',
      arguments: { pid: wpfPid, capture: 'original', maxDepth: 2 },
    });
    assert.ok(!res.isError);
    const data = JSON.parse(getContent(res)[0].text!);
    assert.strictEqual(data.success, true);
    assert.ok(typeof data.imageWidth === 'number' && data.imageWidth > 0);
    assert.ok(typeof data.imageHeight === 'number' && data.imageHeight > 0);
    assert.ok(typeof data.imageScale === 'number' && data.imageScale > 0);
  });

  it('budget pruning returns bounded text and accurate retained node counts on a real WPF tree', async () => {
    const exe = path.resolve(root, 'tests/fixtures/wpf-ui-review/bin/Release/net10.0-windows/win-x64/publish/wpf-ui-review.exe');
    const target = spawn(exe, ['--budget-fixture', '--auto-close=20000'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const pid = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Budget fixture did not become ready')), 8000);
        let output = '';
        target.stdout!.on('data', chunk => {
          output += chunk.toString();
          const ready = output.match(/READY\s+(\d+)/);
          if (ready) { clearTimeout(timer); resolve(Number(ready[1])); }
        });
        target.on('error', err => { clearTimeout(timer); reject(err); });
      });
      const result = await client.callTool({ name: 'wincode_ui_inspect', arguments: { pid, capture: 'annotated', maxDepth: 20, maxNodes: 1000 } });
      assert.ok(!result.isError);
      const text = getContent(result)[0].text!;
      assert.ok(Buffer.byteLength(text, 'utf8') <= 128 * 1024);
      const data = JSON.parse(text);
      assert.equal(data.truncated, true);
      assert.equal(data.truncateReason, 'budgetLimit');
      let count = 0;
      const visit = (node: any) => { count++; assert.ok((node.automationId?.length ?? 0) <= 256); node.children.forEach(visit); };
      visit(data.tree);
      assert.equal(data.totalNodes, count);
      assert.ok(count < 350, 'Oversized tree should actually have been pruned');
    } finally { await killProcessTree(target); }
  });

  it('review links a real WPF snapshot to fixture XAML with the same request node IDs', async () => {
    const res = await client.callTool({ name: 'wincode_ui_review', arguments: {
      pid: wpfPid, capture: 'annotated', maxDepth: 6,
      candidateFiles: ['tests/fixtures/wpf-ui-review/MainWindow.xaml'],
    } });
    assert.strictEqual(res.isError, false);
    const content = getContent(res);
    const data = JSON.parse(content[0].text!);
    assert.strictEqual(content[1].type, 'image');
    assert.strictEqual(data.sourceEvidence.runtimeSourceVerified, false);
    const pending = [data.tree];
    let disabled: any;
    while (pending.length) {
      const current = pending.pop();
      if (current.automationId === 'btnDisabledAction') disabled = current;
      pending.push(...current.children);
    }
    assert.ok(disabled, 'Fixture button must be in the actual UIA snapshot');
    assert.strictEqual(disabled.isEnabled, false);
    const evidence = data.sourceEvidence.nodes.find((entry: any) => entry.nodeId === disabled.id);
    assert.strictEqual(evidence.status, 'single-candidate');
    assert.strictEqual(evidence.candidates[0].declarations.IsEnabled, 'False');
    const lines = (await fsPromises.readFile(path.join(root, evidence.candidates[0].file), 'utf8')).split('\n');
    assert.ok(lines[evidence.candidates[0].line - 1].includes('<Button'));
  });

  it('16. disabled flaui adapter rejects MCP call at entry with HOST_UNAVAILABLE', async () => {
    (router.flaui as any).config.adapters.flaui.enabled = false;
    try {
      const res = await client.callTool({
        name: 'wincode_ui_inspect',
        arguments: { pid: wpfPid },
      });
      assert.strictEqual(res.isError, true);
      const data = JSON.parse(getContent(res)[0].text!);
      assert.strictEqual(data.errorCode, 'HOST_UNAVAILABLE');
      assert.ok(data.errorMessage?.includes('disabled'));
    } finally {
      (router.flaui as any).config.adapters.flaui.enabled = true;
    }
  });
});
