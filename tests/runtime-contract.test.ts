import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/client';
import { getDefaultConfig } from '../src/Core/Config.js';
import { ToolRouter } from '../src/Core/ToolRouter.js';
import { WinCodeMcpServer } from '../src/Gateway/McpServer.js';
import { WINCODE_TOOLS, contractHash, toolsContractHash } from '../src/Gateway/Protocol.js';

it('hello and tools/list share an immutable registered contract and runtime survives workspace switching', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-contract-'));
  const config = getDefaultConfig(root);
  config.adapters.serena.enabled = false;
  config.adapters.flaui.enabled = false;
  config.adapters.repomix.useCli = false;
  const server = new WinCodeMcpServer(new ToolRouter(config));
  const client = new Client({ name: 'contract-fixture', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  const original = WINCODE_TOOLS[0].description;
  try {
    await Promise.all([client.connect(left), (server as any).server.connect(right)]);
    const tools = (await client.listTools()).tools;
    WINCODE_TOOLS[0].description = 'changed after registration';
    const call = async (args = {}) => {
      const result: any = await client.callTool({ name: 'wincode_hello_world', arguments: args });
      assert.notEqual(result.isError, true);
      return JSON.parse(result.content[0].text);
    };
    const hello = await call();
    assert.equal(hello.toolContract.schemaHash, toolsContractHash(tools));
    assert.deepEqual((await client.listTools()).tools, tools);
    assert.deepEqual(hello.capabilities, tools.map(tool => tool.name));
    assert.equal(hello.toolContract.tool, undefined);
    assert.ok(JSON.stringify(hello).length < 10000);
    assert.equal(hello.runtime.build.status, 'unknown', 'source tests must not borrow a dist identity');
    const selected = await call({ toolName: 'wincode_prepare_context' });
    const schema = tools.find(tool => tool.name === 'wincode_prepare_context')!.inputSchema;
    assert.deepEqual(selected.toolContract.tool.inputSchema, schema);
    assert.equal(selected.toolContract.tool.schemaHash, contractHash(schema));
    await fs.mkdir(path.join(root, 'other'));
    const switched = await client.callTool({ name: 'workspace_open', arguments: { path: path.join(root, 'other') } });
    assert.notEqual(switched.isError, true);
    assert.deepEqual((await call()).runtime, hello.runtime);
    for (const args of [{ toolName: 'missing' }, { greeting: 5 }]) {
      assert.equal((await client.callTool({ name: 'wincode_hello_world', arguments: args })).isError, true);
    }
    assert.deepEqual((await call({ toolNames: [] })).runtime, hello.runtime, 'extra fields are tolerated but cannot select tools');
    assert.notEqual((await client.callTool({ name: 'wincode_prepare_context', arguments: { task: 'target', scopeFile: ['Target.ts'] } })).isError, true);
    assert.equal((await client.callTool({ name: 'wincode_prepare_context', arguments: { task: 'target', scopeFiles: 'Target.ts' } })).isError, true, 'known field types remain enforced');
  } finally {
    WINCODE_TOOLS[0].description = original;
    await client.close();
    await server.stop();
    assert.equal(path.dirname(root), os.tmpdir());
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('schema fingerprints ignore object key and tool listing order but detect parameter changes', () => {
  assert.equal(contractHash({ b: 2, a: { z: 1, c: 3 } }), contractHash({ a: { c: 3, z: 1 }, b: 2 }));
  assert.equal(toolsContractHash(WINCODE_TOOLS), toolsContractHash([...WINCODE_TOOLS].reverse()));
  assert.notEqual(contractHash({ type: 'string' }), contractHash({ type: 'number' }));
});
