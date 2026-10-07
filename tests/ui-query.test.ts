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

it('parent scopes reach inspect and expansion while invalid paths and old helpers never act', async () => {
  const scopePath = [{ name: 'Speech', controlType: 'Group' }, { name: 'Advanced', controlType: 'Group' }];
  const router = new ToolRouter(getDefaultConfig(process.cwd()));
  const server = new WinCodeMcpServer(router);
  const seen: any[] = [];
  router.inspectUi = async request => { seen.push(request); return { schemaVersion:'1.0', protocolVersion:'1.0', requestId:'scope', success:true,
    pid:1, hwnd:'0x1', tree:{ id:1, parentId:null, automationId:'Normalize', children:[] } }; };
  router.performUiAction = router.inspectUi;
  const [a,b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name:'scope-contract', version:'1' });
  const adapter = new FlaUiAdapter(getDefaultConfig(process.cwd()));
  const dispatched: string[] = [];
  (adapter as any).executeHost = async (request: any) => {
    dispatched.push(request.action);
    return { schemaVersion:'1.0', protocolVersion:'1.0', requestId:request.requestId, success:true, inspectionVersion:4, status:'healthy' };
  };
  try {
    await (server as any).server.connect(a); await client.connect(b);
    await client.callTool({ name:'wincode_ui_inspect', arguments:{ pid:1, scopePath, query:{ name:'Normalize' } } });
    await client.callTool({ name:'wincode_ui_set_expanded', arguments:{ pid:1, scopePath, targetName:'Inner', expanded:true } });
    assert.deepEqual(seen.map(r => r.scopePath), [scopePath, scopePath]);
    const compact = await client.callTool({ name:'wincode_ui_inspect', arguments:{ pid:1, scopePath, responseFormat:'compact' } });
    const body = JSON.parse((compact.content as any)[0].text);
    assert.deepEqual(body.expansionRequests[0].arguments.scopePath, scopePath);
    for (const invalid of [[], [{}], [{name:''}], [{name:'x',maxMatches:1}], 'Speech']) {
      const result = await client.callTool({ name:'wincode_ui_inspect', arguments:{ pid:1, scopePath:invalid } });
      assert.equal(result.isError, true);
    }
    assert.equal(seen.length, 3);
    const old = await adapter.performUiAction({ pid:1, action:'setExpanded', targetName:'Inner', expanded:true, scopePath } as any);
    assert.equal(old.errorCode, 'VERSION_MISMATCH');
    assert.deepEqual(dispatched, ['health']);
    const unsupported = await adapter.performUiAction({ pid:1, action:'click', targetName:'Inner', scopePath } as any);
    assert.equal(unsupported.errorCode, 'INVALID_ARGUMENT');
    assert.deepEqual(dispatched, ['health']);
    const parsed = (adapter as any).parseHostResponse(JSON.stringify({ success:true, inspectionVersion:4 }), { requestId:'old', pid:1, scopePath });
    assert.equal(parsed.errorCode, 'VERSION_MISMATCH');
  } finally { await adapter.dispose(); await client.close(); await server.stop(); }
});
