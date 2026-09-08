import { it } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/client';
import { WinCodeMcpServer } from '../src/Gateway/McpServer.js';
import { ToolRouter } from '../src/Core/ToolRouter.js';
import { getDefaultConfig } from '../src/Core/Config.js';
import { FlaUiAdapter } from '../src/Adapters/FlaUiAdapter.js';

it('raw capture quality hints survive MCP without discarding image or UIA evidence', async () => {
  const router = new ToolRouter(getDefaultConfig(process.cwd()));
  const server = new WinCodeMcpServer(router);
  const client = new Client({ name: 'capture-quality', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  router.inspectUi = async () => ({ schemaVersion: '1.0', protocolVersion: '1.0', requestId: 'quality', success: true,
    tree: { id: 1, parentId: null, children: [] }, backgroundOnly: true, captureMethod: 'printWindow',
    captureQuality: { status: 'suspect-low-variation', sampleCount: 1024, maxChannelRange: 0, message: 'May be blank or a legitimate uniform view.' },
    screenshotPngBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=' });
  try {
    await (server as any).server.connect(b); await client.connect(a);
    const response = await client.callTool({ name: 'wincode_ui_inspect', arguments: { pid: 1, hwnd: '0x1', capture: 'original', backgroundOnly: true } });
    const blocks = response.content as Array<{ type: string; text: string }>;
    assert.equal(response.isError, false);
    const data = JSON.parse(blocks[0].text);
    assert.equal(data.tree.id, 1);
    assert.equal(data.captureQuality.status, 'suspect-low-variation');
    assert.equal(data.hasScreenshot, true);
    assert.equal(blocks.filter(item => item.type === 'image').length, 1);
  } finally { await client.close(); await server.stop(); }
});

it('background policy validates explicit identity before spawning and survives MCP serialization', async () => {
  const router = new ToolRouter(getDefaultConfig(process.cwd()));
  const server = new WinCodeMcpServer(router);
  const client = new Client({ name: 'background-policy', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  let calls = 0;
  router.inspectUi = async request => {
    calls++; assert.equal(request.backgroundOnly, true);
    return { schemaVersion: '1.0', protocolVersion: '1.0', requestId: 'background', success: true,
      backgroundOnly: true, tree: { id: 1, parentId: null, children: [] },
      imageOmitted: true, imageOmittedReason: 'Window capture failed; screen fallback disabled by backgroundOnly.' };
  };
  try {
    await (server as any).server.connect(b); await client.connect(a);
    for (const args of [{ pid: 1, backgroundOnly: true }, { hwnd: '0x1', backgroundOnly: true },
      { pid: 1, hwnd: '0x1', backgroundOnly: 'true' }]) {
      const result = await client.callTool({ name: 'wincode_ui_inspect', arguments: args });
      assert.equal(result.isError, true);
    }
    assert.equal(calls, 0);
    const response = await client.callTool({ name: 'wincode_ui_inspect', arguments: {
      pid: 1, hwnd: '0x1', backgroundOnly: true, capture: 'original',
    } });
    const blocks = response.content as Array<{ text: string }>;
    assert.equal(blocks.length, 1);
    const result = JSON.parse(blocks[0].text);
    assert.equal(result.tree.id, 1); assert.equal(result.imageOmitted, true);
    assert.equal(result.hasScreenshot, false); assert.equal(result.backgroundOnly, true);
    assert.equal(calls, 1);
  } finally { await client.close(); await server.stop(); }
});

it('adapter serializes backgroundOnly to the helper without changing lifecycle ownership', async () => {
  const adapter = new FlaUiAdapter(getDefaultConfig(process.cwd()));
  adapter.resolveHostCommand = () => ({ command: process.execPath, args: ['-e',
    `let input='';process.stdin.on('data', c=>input+=c);process.stdin.on('end',()=>{const r=JSON.parse(input);console.log(JSON.stringify({schemaVersion:'1.0',protocolVersion:'1.0',requestId:r.requestId,success:true,backgroundOnly:r.backgroundOnly}));});`] });
  try {
    assert.equal((await adapter.inspect({ pid: 1, backgroundOnly: true })).errorCode, 'INVALID_ARGUMENT');
    const result = await adapter.inspect({ pid: 1, hwnd: '0x1', backgroundOnly: true });
    assert.equal(result.success, true); assert.equal(result.backgroundOnly, true);
    assert.equal(adapter.isRunning, false);
  } finally { await adapter.dispose(); }
});
