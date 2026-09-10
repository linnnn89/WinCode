import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { getDefaultConfig } from '../src/Core/Config.js';
import { ToolRouter } from '../src/Core/ToolRouter.js';
import { WinCodeMcpServer } from '../src/Gateway/McpServer.js';
import { WINCODE_TOOLS, toolsContractHash } from '../src/Gateway/Protocol.js';

async function fixture(run: (client: Client, router: ToolRouter, admissions: () => number) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-tool-contract-'));
  const config = getDefaultConfig(root);

  config.adapters.flaui.enabled = false;
  config.adapters.repomix.useCli = false;
  const router = new ToolRouter(config);
  let admitted = 0;
  router.acquireRequestSlot = async () => { admitted++; };
  router.endRequest = () => {};
  const server = new WinCodeMcpServer(router);
  const client = new Client({ name: 'all-tools-contract', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(left), (server as any).server.connect(right)]);
    await run(client, router, () => admitted);
  } finally {
    await client.close();
    await server.stop();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}

it('rejects object-valued symbol queries before admission or adapter execution', async () => fixture(async (client, router, admissions) => {
  let calls = 0;
  router.text.findSymbolsDetailed = async () => { calls++; return {} as any; };
  const result = await client.callTool({ name: 'wincode_find_code_symbol', arguments: { query: { wrong: 'type' } } });
  assert.equal(result.isError, true);
  assert.equal(admissions(), 0);
  assert.equal(calls, 0);
}));

const examples: Record<string, Record<string, unknown>> = {
  workspace_open: { path: 'example' }, wincode_workspace_open: { path: 'example' },
  wincode_list_directory: { path: '.', maxDepth: 1 }, wincode_hello_world: { greeting: 'hello' },
  wincode_analyze_workspace: { maxDepth: 2 }, wincode_prepare_context: { task: 'Inspect Target', scopeFiles: ['Target.ts'] },
  wincode_find_code_symbol: { query: 'Target', kind: 'class' }, wincode_find_references: { symbolName: 'Target', relativePath: 'Target.ts' },
  analyze_change_impact: { target: 'Target' }, wincode_analyze_change_impact: { target: 'Target' },
  wincode_diagnose_project: {}, wincode_plan_refactoring: { target: 'Target', goal: 'Improve reliability' },
  wincode_safe_move_to_trash: { filePath: 'Target.ts', reason: 'fixture' },
  wincode_ui_list_windows: { pid: 5 }, wincode_ui_inspect: { pid: 5, query: { name: 'Save' } },
  wincode_ui_review: { pid: 5, candidateFiles: ['View.xaml'], candidateCodeFiles: ['View.cs'], textQueries: ['Save'] },
};

// Independent expectations: equally shaped fixture responses must not conceal a miswired handler.
const expectedCalls: Record<string, { method: string; args: unknown[] }> = {
  workspace_open: { method: 'openWorkspace', args: ['example', { includeTree: undefined, maxOutputChars: undefined }, '<signal>'] },
  wincode_workspace_open: { method: 'openWorkspace', args: ['example', { includeTree: undefined, maxOutputChars: undefined }, '<signal>'] },
  wincode_list_directory: { method: 'listDirectory', args: [{ path: '.', maxDepth: 1 }, '<signal>'] },
  wincode_hello_world: { method: 'getRuntimeHealth', args: [] },
  wincode_analyze_workspace: { method: 'analyzeWorkspace', args: [2, '<signal>'] },
  wincode_prepare_context: { method: 'prepareContext', args: [{ task: 'Inspect Target', scopeFiles: ['Target.ts'] }, '<signal>'] },
  wincode_find_code_symbol: { method: 'findCodeSymbols', args: ['Target', 'class', '<signal>'] },
  wincode_find_references: { method: 'findCodeReferences', args: ['Target', 'Target.ts', '<signal>'] },
  analyze_change_impact: { method: 'analyzeChangeImpact', args: ['Target', '<signal>'] },
  wincode_analyze_change_impact: { method: 'analyzeChangeImpact', args: ['Target', '<signal>'] },
  wincode_diagnose_project: { method: 'diagnoseProject', args: [] },
  wincode_plan_refactoring: { method: 'planRefactoring', args: ['Target', 'Improve reliability', '<signal>'] },
  wincode_safe_move_to_trash: { method: 'moveToTrash', args: ['Target.ts', 'fixture'] },
  wincode_ui_list_windows: { method: 'listUiWindows', args: [{ pid: 5 }, '<signal>'] },
  wincode_ui_inspect: { method: 'inspectUi', args: [{ pid: 5, query: { name: 'Save' }, hwnd: undefined }, '<signal>'] },
  wincode_ui_review: { method: 'reviewUi', args: [{ pid: 5, hwnd: undefined }, ['View.xaml'], '<signal>', ['Save'], ['View.cs']] },
};

it('calls all 15 published tools and the hidden alias; unknown fields do not reach use cases', async () => fixture(async (client, router) => {
  await fs.writeFile(path.join(router.config.workspaceRoot, 'Target.ts'), 'export class Target {}');
  const prepared = await router.prepareContext(examples.wincode_prepare_context as any);
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const stub = (method: string, result: unknown) => {
    (router as any)[method] = async (...args: unknown[]) => { calls.push({ method, args }); return structuredClone(result); };
  };
  for (const method of ['openWorkspace', 'listDirectory', 'analyzeWorkspace', 'findCodeSymbols', 'findCodeReferences', 'diagnoseProject', 'planRefactoring'])
    stub(method, { success: true });
  stub('prepareContext', prepared);
  stub('moveToTrash', { success: true });
  stub('analyzeChangeImpact', { formattedReport: 'Fixture report' });
  stub('getRuntimeHealth', { status: 'ok', text: {}, repomix: {}, flaui: {} });
  stub('listUiWindows', { success: true, windows: [] });
  stub('inspectUi', { success: true });
  stub('reviewUi', { success: true });
  const published = (await client.listTools()).tools;
  assert.equal(published.length, 15);
  assert.ok(!published.some(tool => tool.name === 'wincode_workspace_open'));
  assert.deepEqual(new Set([...published.map(tool => tool.name), 'wincode_workspace_open']), new Set(Object.keys(examples)));
  const responses = new Map<string, unknown>();
  for (const [name, args] of Object.entries(examples)) {
    calls.length = 0;
    const baseline: any = await client.callTool({ name, arguments: args });
    assert.notEqual(baseline.isError, true, `${name}: ${JSON.stringify(baseline)}`);
    responses.set(name, baseline);
    assert.equal(calls.length, 1, name);
    // AbortSignal is transport-owned and differs for every call; normalize only that field.
    const comparable = (call: { method: string; args: unknown[] }) => ({ method: call.method,
      args: call.args.map(value => value instanceof AbortSignal ? '<signal>' : value) });
    const expected = expectedCalls[name];
    assert.deepEqual(comparable(calls[0]), expected, `${name} dispatch`);
    calls.length = 0;
    const extended: any = await client.callTool({ name, arguments: { ...args, futureOption: { enabled: true } } });
    assert.notEqual(extended.isError, true, `${name}: ${JSON.stringify(extended)}`);
    assert.equal(calls.length, 1, name);
    assert.deepEqual(comparable(calls[0]), expected, `${name} with extra fields`);
  }
  assert.deepEqual(responses.get('workspace_open'), responses.get('wincode_workspace_open'));
  assert.deepEqual(responses.get('analyze_change_impact'), responses.get('wincode_analyze_change_impact'));
}));

it('validates every declared top-level argument without coercion before admission', async () => fixture(async (client, router, admissions) => {
  let calls = 0;
  for (const method of ['openWorkspace', 'listDirectory', 'analyzeWorkspace', 'findCodeSymbols', 'findCodeReferences', 'diagnoseProject',
    'planRefactoring', 'prepareContext', 'moveToTrash', 'analyzeChangeImpact', 'getRuntimeHealth', 'listUiWindows', 'inspectUi', 'reviewUi'])
    (router as any)[method] = async () => { calls++; return {}; };
  const tools = (await client.listTools()).tools;
  const workspace = tools.find(tool => tool.name === 'workspace_open')!;
  for (const tool of [...tools, { ...workspace, name: 'wincode_workspace_open' }]) {
    for (const [key, definition] of Object.entries(tool.inputSchema.properties || {})) {
      const type = (definition as { type: string }).type;
      const wrong = ['integer', 'number'].includes(type) ? '5' : type === 'boolean' ? 'false' : type === 'array' ? {} : 42;
      const before = admissions();
      const result: any = await client.callTool({ name: tool.name, arguments: { ...examples[tool.name], [key]: wrong } });
      assert.equal(result.isError, true, `${tool.name}.${key} accepted ${JSON.stringify(wrong)}`);
      assert.equal(admissions(), before, `${tool.name}.${key} acquired a slot`);
      if (tool.name.startsWith('wincode_ui_')) assert.equal(JSON.parse(result.content[0].text).errorCode, 'INVALID_ARGUMENT');
    }
    for (const key of tool.inputSchema.required || []) {
      const args = { ...examples[tool.name] };
      delete args[key];
      const before = admissions();
      const result = await client.callTool({ name: tool.name, arguments: args });
      assert.equal(result.isError, true, `${tool.name} accepted missing ${key}`);
      assert.equal(admissions(), before);
    }
    // No-argument tools have no declared properties to corrupt, but still reject a non-object envelope.
    if (!Object.keys(tool.inputSchema.properties || {}).length) {
      const before = admissions();
      await assert.rejects(client.callTool({ name: tool.name, arguments: [] as any }));
      assert.equal(admissions(), before);
    }
  }
  assert.equal(calls, 0);
}));

it('rejects context and UI cross-field conflicts before request admission', async () => fixture(async (client, router, admissions) => {
  let calls = 0;
  router.prepareContext = async () => { calls++; throw new Error('must not execute'); };
  router.inspectUi = async () => { calls++; throw new Error('must not execute'); };
  const badContext = [
    { task: 'x', scopeFiles: ['A.cs'], focusAreas: ['src'] },
    { task: 'x', symbol: 'Save' },
    { task: 'x', scopeFiles: ['A.cs'], candidateFiles: ['B.cs'] },
    { task: 'x', lineRanges: [{ file: 'A.cs', startLine: 5, endLine: 4 }] },
    { task: 'x', lineRanges: [{ file: 'A.cs', startLine: 1, endLine: 2 }, { file: './A.cs', startLine: 3, endLine: 4 }] },
    { task: 'x', includeFullText: true, lineRanges: [{ file: 'A.cs', startLine: 1, endLine: 2 }] },
  ];
  for (const args of badContext) {
    const result = await client.callTool({ name: 'wincode_prepare_context', arguments: args });
    assert.equal(result.isError, true, JSON.stringify(args));
  }
  for (const args of [{ pid: 5, backgroundOnly: true }, { pid: 5, query: { maxSearchNodes: 5 } }, { hwnd: ' ' }]) {
    const result = await client.callTool({ name: 'wincode_ui_inspect', arguments: args });
    assert.equal(result.isError, true, JSON.stringify(args));
  }
  assert.equal(calls, 0);
  assert.equal(admissions(), 0);
}));

it('rejects blank required operation text before admission', async () => fixture(async (client, _router, admissions) => {
  for (const [name, key] of [['wincode_find_code_symbol', 'query'], ['wincode_find_references', 'symbolName'],
    ['analyze_change_impact', 'target'], ['wincode_analyze_change_impact', 'target'], ['wincode_plan_refactoring', 'target'],
    ['wincode_plan_refactoring', 'goal'], ['wincode_safe_move_to_trash', 'filePath']]) {
    for (const blank of ['', ' \t\n ']) {
      const result = await client.callTool({ name, arguments: { ...examples[name], [key]: blank } });
      assert.equal(result.isError, true, `${name}.${key}`);
    }
  }
  assert.equal(admissions(), 0);
}));

it('rejects declared enum, range and nested type violations before admission', async () => fixture(async (client, _router, admissions) => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['wincode_list_directory', { maxDepth: 6 }], ['workspace_open', { path: 'example', maxOutputChars: 2047 }],
    ['wincode_prepare_context', { task: 'x', responseFormat: 'yaml' }], ['wincode_prepare_context', { task: 'x', maxTokens: 511 }],
    ['wincode_prepare_context', { task: 'x', lineRanges: [{ file: 'A.cs', startLine: '1', endLine: 3 }] }],
    ['wincode_ui_inspect', { pid: 5, capture: 'interactive' }], ['wincode_ui_inspect', { pid: 5, query: { name: 'Save', maxMatches: 21 } }],
    ['wincode_ui_inspect', { pid: 5, query: { name: 42 } }], ['wincode_ui_review', { pid: 5, candidateFiles: ['../View.xaml'] }],
  ];
  for (const [name, args] of cases) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, `${name}: ${JSON.stringify(args)}`);
  }
  assert.equal(admissions(), 0);
}));

it('validates directory and trash lexical scope before admission while preserving trash errors', async () => fixture(async (client, router, admissions) => {
  let calls = 0;
  router.listDirectory = async () => { calls++; return {} as any; };
  router.moveToTrash = async () => { calls++; return { success: true, trashPath: '', message: '', outcome: 'completed' }; };
  for (const requested of ['../outside', 'src/../inside']) {
    const result = await client.callTool({ name: 'wincode_list_directory', arguments: { path: requested } });
    assert.equal(result.isError, true, requested);
  }
  for (const filePath of ['../outside.cs', 'C:outside.cs', path.resolve(router.config.workspaceRoot, 'Target.cs')]) {
    const result: any = await client.callTool({ name: 'wincode_safe_move_to_trash', arguments: { filePath } });
    assert.equal(result.isError, true, filePath);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.success, false);
    assert.equal(body.trashPath, '');
    assert.match(body.message, /Failed to move file to trash:/);
  }
  assert.equal(admissions(), 0);
  assert.equal(calls, 0);
  const legal = await client.callTool({ name: 'wincode_safe_move_to_trash', arguments: { filePath: 'nested/../Target.cs' } });
  assert.notEqual(legal.isError, true, 'existing in-workspace trash normalization stays valid');
  assert.equal(calls, 1);
}));

it('published schemas, hello hashes and validation keep the same instance snapshot', async () => fixture(async (client, router, admissions) => {
  router.getRuntimeHealth = async () => ({ status: 'ok', text: {}, repomix: {}, flaui: {} }) as any;
  const tools = (await client.listTools()).tools;
  const exported = WINCODE_TOOLS.find(tool => tool.name === 'wincode_find_code_symbol')!;
  const original = structuredClone(exported.inputSchema);
  try {
    exported.inputSchema.properties!.query = { type: 'number' };
    const hello: any = await client.callTool({ name: 'wincode_hello_world', arguments: { toolName: 'wincode_find_code_symbol' } });
    const data = JSON.parse(hello.content[0].text);
    assert.equal(data.toolContract.schemaHash, toolsContractHash(tools));
    assert.deepEqual(data.toolContract.tool.inputSchema, tools.find(tool => tool.name === 'wincode_find_code_symbol')!.inputSchema);
    const before = admissions();
    const bad = await client.callTool({ name: 'wincode_find_code_symbol', arguments: { query: 42 } });
    assert.equal(bad.isError, true);
    assert.equal(admissions(), before);
  } finally { exported.inputSchema = original; }
}));

it('ignores unknown UI query properties without weakening the required known condition', async () => fixture(async (client, router, admissions) => {
  let captured: unknown;
  router.inspectUi = async input => { captured = input; return { success: true } as any; };
  const good = await client.callTool({ name: 'wincode_ui_inspect', arguments: { pid: 5, query: { name: 'Save', futureFlag: true }, futureOption: true } });
  assert.notEqual(good.isError, true);
  assert.deepEqual((captured as any).query, { name: 'Save' });
  assert.equal((captured as any).futureOption, undefined);
  const before = admissions();
  const bad = await client.callTool({ name: 'wincode_ui_inspect', arguments: { pid: 5, query: { futureFlag: true } } });
  assert.equal(bad.isError, true);
  assert.equal(admissions(), before);
}));

it('returns unknown tools as protocol errors before admission and keeps the connection usable', async () => fixture(async (client, router, admissions) => {
  await assert.rejects(client.callTool({ name: 'missing_tool', arguments: {} }), (error: any) => error.code === -32602);
  assert.equal(admissions(), 0);
  router.findCodeSymbols = async () => ({ symbols: [], queryComplete: true }) as any;
  const result = await client.callTool({ name: 'wincode_find_code_symbol', arguments: { query: 'Known' } });
  assert.notEqual(result.isError, true);
}));

it('returns impact evidence once for both canonical name and alias', async () => fixture(async (client, router) => {
  const impact = { target: 'Same', references: [{ file: 'Use.cs', line: 5 }], risk: 'UNKNOWN', formattedReport: 'REPORT_ONCE' };
  router.analyzeChangeImpact = async () => impact as any;
  for (const name of ['analyze_change_impact', 'wincode_analyze_change_impact']) {
    const result: any = await client.callTool({ name, arguments: { target: 'Same' } });
    assert.equal(result.content.length, 1);
    assert.deepEqual(JSON.parse(result.content[0].text), impact);
    assert.equal(result.content[0].text.split('REPORT_ONCE').length, 2);
  }
}));
