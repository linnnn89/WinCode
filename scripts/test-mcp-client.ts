import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { contractHash, toolsContractHash } from '../src/Gateway/Protocol.js';

/** One child process/connection, isolated workspace, compiled production handlers. */
async function verify() {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-stdio-'));
  const client = new Client({ name: 'wincode-runtime-probe', version: '1' });
  let transport: StdioClientTransport | undefined;
  try {
    const lines = Array.from({ length: 60 }, (_, index) => index === 49 ?
      'export function RuntimeProbeTarget() { return "RUNTIME_TARGET_BODY"; }' : `// padding ${index + 1}`);
    await fs.writeFile(path.join(root, 'Target.ts'), lines.join('\n'));
    await fs.writeFile(path.join(root, 'package.json'), '{"name":"runtime-probe"}');
    const distUrl = (name: string) => JSON.stringify(pathToFileURL(path.join(repo, 'dist', name)).href);
    const bootstrap = path.join(root, 'probe.mjs');
    await fs.writeFile(bootstrap, `
import { getDefaultConfig } from ${distUrl('Core/Config.js')};
import { ToolRouter } from ${distUrl('Core/ToolRouter.js')};
import { WinCodeMcpServer } from ${distUrl('Gateway/McpServer.js')};
const config = getDefaultConfig(${JSON.stringify(root)});
config.adapters.serena.enabled = false;
config.adapters.flaui.enabled = false;
config.adapters.repomix.useCli = false;
const server = new WinCodeMcpServer(new ToolRouter(config));
process.stdin.on('end', () => { void server.stop(); });
process.on('SIGTERM', () => { void server.stop(); });
await server.start();
`);
    transport = new StdioClientTransport({ command: process.execPath, args: [bootstrap], cwd: root, stderr: 'pipe' });
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert.ok(Array.isArray(result.content) && result.content[0]?.type === 'text');
      return JSON.parse((result.content as { text: string }[])[0].text);
    };
    const hello = await call('wincode_hello_world', { toolName: 'wincode_prepare_context' });
    assert.equal(hello.runtime.build.status, 'verified', 'run npm run build before this probe');
    assert.equal(hello.toolContract.schemaHash, toolsContractHash(tools));
    assert.equal(hello.toolContract.toolCount, tools.length);
    const schema = tools.find(tool => tool.name === 'wincode_prepare_context')!.inputSchema;
    assert.deepEqual(hello.toolContract.tool.inputSchema, schema);
    assert.equal(hello.toolContract.tool.schemaHash, contractHash(schema));
    for (const key of ['scopeFiles', 'symbol', 'lineRanges']) assert.ok(Object.hasOwn(schema.properties!, key));
    const symbol = await call('wincode_prepare_context', { task: 'Inspect runtime target', scopeFiles: ['Target.ts'], symbol: 'RuntimeProbeTarget' });
    assert.ok(symbol.evidence.some((item: any) => item.file === 'Target.ts' && item.line === 50 && item.snippet.includes('RUNTIME_TARGET_BODY')));
    const range = await call('wincode_prepare_context', { task: 'Inspect runtime target', lineRanges: [{ file: 'Target.ts', startLine: 50, endLine: 50 }] });
    assert.ok(range.evidence.some((item: any) => item.startLine === 50 && item.endLine === 50 && item.snippet === lines[49]));
    const invalid = await client.callTool({ name: 'wincode_prepare_context', arguments: { task: 'Inspect target', scopeFile: ['Target.ts'] } });
    assert.equal(invalid.isError, true);
    const after = await call('wincode_hello_world');
    assert.deepEqual(after.runtime, hello.runtime);
    console.log(JSON.stringify({ status: 'passed', transport: 'stdio', productionHandlers: true,
      upstreams: false, gui: false, codexConnectionVerified: false, version: hello.version,
      runtime: hello.runtime, schemaHash: hello.toolContract.schemaHash, toolCount: tools.length,
      checks: ['initialize', 'tools/list', 'hello schema agreement', 'symbol body at line 50', 'exact range body', 'unknown parameter rejected', 'stable instance'] }, null, 2));
  } finally {
    try { await client.close(); } finally {
      try { await transport?.close(); } finally {
        assert.equal(path.dirname(root), os.tmpdir());
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  }
}

verify().catch(error => { console.error(error); process.exitCode = 1; });
