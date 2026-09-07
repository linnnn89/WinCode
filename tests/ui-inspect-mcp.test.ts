import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn, ChildProcess } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
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
    assert.strictEqual(data.adapters.flaui.available, true);
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
});
