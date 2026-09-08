import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateUiQuery } from '../src/Core/UiContracts.js';
import { FlaUiAdapter } from '../src/Adapters/FlaUiAdapter.js';
import { getDefaultConfig } from '../src/Core/Config.js';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/client';
import { WinCodeMcpServer } from '../src/Gateway/McpServer.js';
import { ToolRouter } from '../src/Core/ToolRouter.js';

it('bounded production search preserves ambiguity, incompleteness and cancellation', async () => {
  const {stdout} = await promisify(execFile)('dotnet', ['run', '--project', 'tests/fixtures/ui-query-check', '-c', 'Release'], {timeout:60000});
  assert.match(stdout, /"passed":16/);
  assert.match(stdout, /"qualityPassed":8/);
});
it('query rejects unbounded, empty, malformed filters before launching a helper', async () => {
  for (const q of [{}, null, [], {name:''}, {name:'x',maxSearchNodes:5001}, {name:'x',maxMatches:21}, {name:'x',nodeId:1}]) {
    assert.throws(() => validateUiQuery(q, false));
  }
  assert.throws(() => validateUiQuery(undefined, 'true'));
  const adapter = new FlaUiAdapter(getDefaultConfig(process.cwd()));
  (adapter as any).executeHost = () => { throw new Error('Must not launch'); };
  assert.equal((await adapter.inspect({pid:1,query:{}})).errorCode, 'INVALID_ARGUMENT');
  await adapter.dispose();
});
it('MCP query and state options reach the router; invalid input never does', async () => {
  const router = new ToolRouter(getDefaultConfig(process.cwd()));
  const server = new WinCodeMcpServer(router);
  let received: any;
  router.inspectUi = async request => { received = request; return {schemaVersion:'1.0',protocolVersion:'1.0',requestId:'test',success:true,queryResult:{status:'not-found',searchComplete:true,visitedNodes:1,matches:[]}}; };
  const [a,b] = InMemoryTransport.createLinkedPair();
  const client = new Client({name:'query-contract',version:'1'});
  try {
    await (server as any).server.connect(a); await client.connect(b);
    const result = await client.callTool({name:'wincode_ui_inspect',arguments:{pid:1,query:{name:'Save'},readStates:true}});
    assert.equal(result.isError,false); assert.deepEqual(received.query,{name:'Save'}); assert.equal(received.readStates,true);
    received = undefined;
    const bad = await client.callTool({name:'wincode_ui_inspect',arguments:{pid:1,query:{}}});
    assert.equal(bad.isError,true); assert.equal(received,undefined);
  } finally { await client.close(); await server.stop(); }
});

it('old helper cannot silently ignore a local query', async () => {
  const adapter = new FlaUiAdapter(getDefaultConfig(process.cwd()));
  (adapter as any).resolveHostCommand = () => ({command:process.execPath,args:['-e',`process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({success:true,protocolVersion:'1.0',tree:{id:1,children:[]}})))`]});
  try { assert.equal((await adapter.inspect({pid:1,query:{name:'Save'}})).errorCode,'VERSION_MISMATCH'); }
  finally { await adapter.dispose(); }
});
