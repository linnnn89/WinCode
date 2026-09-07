import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { WinCodeMcpServer } from '../src/Gateway/McpServer.js';
import { ToolRouter } from '../src/Core/ToolRouter.js';
import { getDefaultConfig } from '../src/Core/Config.js';

it('production audit boundaries and MCP reminder reach the caller without UI content', { timeout: 30000 }, async () => {
  await fs.mkdir('test-tmp', { recursive: true });
  const directory = await fs.mkdtemp(path.resolve('test-tmp/audit-test-'));
  // The console fixture links the production C# source and has no additional package dependencies.
  const result = await promisify(execFile)('dotnet', ['run', '--project', 'tests/fixtures/ui-audit-check/ui-audit-check.csproj', '--', directory],
    { windowsHide: true, timeout: 20000 });
  assert.match(result.stdout, /"passed":17/);
  const router = new ToolRouter(getDefaultConfig(process.cwd()));
  router.flaui.resolveHostCommand = () => ({
    command: path.resolve('tools/WinCode.UIA.Host/bin/Release/net10.0-windows/win-x64/publish/WinCode.UIA.Host.exe'),
    args: ['--audit-check', '--audit-directory', path.join(directory, 'warning')],
  });
  const server = new WinCodeMcpServer(router);
  const client = new Client({ name: 'audit-warning', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await (server as any).server.connect(b); await client.connect(a);
    const response = await client.callTool({ name: 'wincode_ui_list_windows', arguments: {} });
    const content = response.content as Array<{ text: string }>;
    const notice = JSON.parse(content[0].text).auditNotice;
    assert.equal(notice.directory, path.join(directory, 'warning'));
    assert.ok(notice.totalBytes > 1024 * 1024);
    assert.match(notice.message, /建议清理/);
    assert.equal(notice.blocked, false);
    assert.equal(content.length, 1);
  } finally { await client.close(); await server.stop(); }
});
