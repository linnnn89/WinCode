import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { getDefaultConfig } from '../src/Core/Config.js';
import { WorkspaceManager } from '../src/Core/Workspace.js';
import { ToolRouter } from '../src/Core/ToolRouter.js';
import { WinCodeMcpServer } from '../src/Gateway/McpServer.js';

const body = (result: any) => JSON.parse(result.content[0].text);
const mismatch = (error: any) => error.errorCode === 'WORKSPACE_MISMATCH';

async function fixture(run: (a: string, b: string, connect: (root: string) => Promise<any>) => Promise<void>) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-fixed-'));
  const a = path.join(parent, '项目 A'), b = path.join(parent, '项目 B');
  const connections: Array<{ client: Client; server: WinCodeMcpServer }> = [];
  for (const [root, marker] of [[a, 'ONLY_A'], [b, 'ONLY_B']]) {
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, 'Api.cs'), `public class Api { public string Marker = "${marker}"; }\n`);
  }
  const connect = async (root: string) => {
    const config = getDefaultConfig(root);
    config.adapters.flaui.enabled = false;
    config.adapters.repomix.useCli = false;
    const router = new ToolRouter(config), server = new WinCodeMcpServer(router);
    const client = new Client({ name: 'fixed-workspace-fixture', version: '1' });
    connections.push({ client, server });
    await router.initialize();
    const [left, right] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(left), (server as any).server.connect(right)]);
    const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
    return { router, call };
  };
  try { await run(a, b, connect); }
  finally {
    for (const { client, server } of connections) { await client.close(); await server.stop(); }
    assert.equal(path.dirname(parent), path.resolve(os.tmpdir()));
    assert.ok(path.basename(parent).startsWith('wincode-fixed-'));
    await fs.rm(parent, { recursive: true, force: true });
  }
}

it('internal workspace entry points and shared configuration cannot rebind the startup root', async () => fixture(async (a, b) => {
  const config = getDefaultConfig(a), workspace = new WorkspaceManager(config);
  const trash = config.trashDir;
  assert.throws(() => workspace.setRoot(b), mismatch);
  await assert.rejects(workspace.openWorkspace(b), mismatch);
  assert.equal(Reflect.set(config, 'workspaceRoot', b), false);
  assert.equal(workspace.root, a);
  assert.equal(config.workspaceRoot, a);
  assert.equal(config.trashDir, trash);
}));

it('both MCP open names reject a different root before draining, fingerprinting or touching resources', async t => fixture(async (a, b, connect) => {
  const { router, call } = await connect(a);
  const before = await router.getRuntimeHealth();
  const resources = router.resources.list();
  const trash = router.config.trashDir;
  const probes = [t.mock.method(router, 'waitForIdle', async () => { throw new Error('Unexpected drain'); }),
    t.mock.method(router.cache, 'computeWorkspaceFingerprint', async () => { throw new Error('Unexpected fingerprint'); }),
    t.mock.method(router.workspace, 'openWorkspace', async () => { throw new Error('Unexpected workspace overview'); })];
  await router.acquireRequestSlot();
  try {
    for (const name of ['workspace_open', 'wincode_workspace_open']) {
      const result = await call(name, { path: b });
      assert.equal(result.isError, true);
      const error = body(result);
      assert.equal(error.errorCode, 'WORKSPACE_MISMATCH');
      assert.equal(error.activeWorkspace, a);
      assert.equal(error.requestedWorkspace, b);
      assert.equal(error.recoveryAction, 'select_workspace_connection');
      assert.deepEqual(result.structuredContent, error);
    }
    const after = await router.getRuntimeHealth();
    assert.equal(after.inFlightRequests, 1, 'the pre-existing request remains owned');
    assert.deepEqual(after.session, before.session);
    assert.deepEqual(after.workspaceWatch, before.workspaceWatch);
    assert.equal(after.cache.namespace, before.cache.namespace);
    assert.equal(after.workspaceRecovery, null);
    assert.equal(router.config.trashDir, trash);
    assert.deepEqual(router.resources.list(), resources);
    for (const probe of probes) assert.equal(probe.mock.callCount(), 0);
  } finally { router.endRequest(); for (const probe of probes) probe.mock.restore(); }
}));

it('rejected opens preserve A text, relative context and composites while an independent B connection remains usable', async () => fixture(async (a, b, connect) => {
  const left = await connect(a), right = await connect(b);
  const before = body(await left.call('wincode_find_code_symbol', { query: 'Api' }));
  assert.equal(before.totalFound, 1);
  const rejected = await left.call('workspace_open', { path: b });
  assert.equal(body(rejected).errorCode, 'WORKSPACE_MISMATCH');
  for (const [connection, root, marker, other] of [[left, a, 'ONLY_A', 'ONLY_B'], [right, b, 'ONLY_B', 'ONLY_A']] as const) {
    const hello = body(await connection.call('wincode_hello_world'));
    assert.equal(hello.workspace, root);
    assert.deepEqual(hello.health.workspaceBinding, { mode: 'fixed', root, source: 'configuration' });
    assert.equal(body(await connection.call('wincode_find_code_symbol', { query: 'Api' })).totalFound, 1);
    const context = await connection.call('wincode_prepare_context', { task: 'Read Api', lineRanges: [{ file: 'Api.cs', startLine: 1, endLine: 1 }] });
    assert.notEqual(context.isError, true);
    assert.ok(JSON.stringify(body(context)).includes(marker));
    assert.ok(!JSON.stringify(body(context)).includes(other));
    const architecture = await connection.call('wincode_analyze_workspace', { maxDepth: 1 });
    assert.notEqual(architecture.isError, true);
    const listing = body(await connection.call('wincode_list_directory'));
    assert.equal(listing.workspace, root);
    assert.ok(listing.entries.some((entry: any) => entry.path === 'Api.cs'));
    const impact = await connection.call('analyze_change_impact', { target: 'Api.cs' });
    assert.notEqual(impact.isError, true);
    const plan = await connection.call('wincode_plan_refactoring', { target: 'Api.cs', goal: 'Review Api' });
    assert.notEqual(plan.isError, true);
  }
}));

it('normalized same-root spellings preserve binding while parent, child and junction targets are rejected', async () => fixture(async (a, b, connect) => {
  const { router, call } = await connect(a);
  const before = await router.getRuntimeHealth();
  const aliases = [a + path.sep, path.join(a, '..', path.basename(a))];
  if (process.platform === 'win32') aliases.push(a.toUpperCase(), a.replace(/\\/g, '/'));
  for (const alias of aliases) assert.notEqual((await call('workspace_open', { path: alias })).isError, true);
  const link = path.join(path.dirname(a), 'alias-to-A');
  await fs.symlink(a, link, process.platform === 'win32' ? 'junction' : 'dir');
  for (const target of [path.dirname(a), path.join(a, 'child'), b, link]) {
    const result = await call('workspace_open', { path: target });
    assert.equal(body(result).errorCode, 'WORKSPACE_MISMATCH');
  }
  const after = await router.getRuntimeHealth();
  assert.equal(after.session.id, before.session.id);
  assert.equal(after.workspaceWatch.root, a);
  assert.equal(after.cache.namespace, before.cache.namespace);
  assert.equal(router.config.workspaceRoot, a);
}));

it('a missing startup directory is rejected before cache creation', async () => fixture(async (a) => {
  const missing = path.join(a, 'missing');
  const config = getDefaultConfig(missing);
  config.adapters.flaui.enabled = false;
  config.adapters.repomix.useCli = false;
  const router = new ToolRouter(config);
  try {
    await assert.rejects(router.initialize(), /Invalid workspace/);
    await assert.rejects(fs.stat(missing), { code: 'ENOENT' });
  } finally { await router.dispose(); }
}));

it('a startup junction is rejected even when the cache is configured on a separate safe path', async () => fixture(async (a, b) => {
  const alias = path.join(path.dirname(a), 'startup-alias');
  await fs.symlink(a, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const config = getDefaultConfig(alias);
  config.cacheDir = path.join(b, 'uncreated-cache');
  config.adapters.flaui.enabled = false; config.adapters.repomix.useCli = false;
  const router = new ToolRouter(config);
  try {
    await assert.rejects(router.initialize(), /link or junction/);
    await assert.rejects(fs.stat(config.cacheDir), { code: 'ENOENT' });
  } finally { await router.dispose(); }
}));

it('the production CLI reports cwd fallback and binds it without requiring workspace_open', async () => fixture(async (a, b) => {
  const client = new Client({ name: 'fixed-cwd-acceptance', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.resolve('dist/index.js')], cwd: a, stderr: 'pipe' });
  try {
    await client.connect(transport);
    const hello = body(await client.callTool({ name: 'wincode_hello_world', arguments: {} }));
    assert.deepEqual(hello.health.workspaceBinding, { mode: 'fixed', root: a, source: 'cwd' });
    assert.equal(hello.workspace, a);
    const rejected = await client.callTool({ name: 'workspace_open', arguments: { path: b } });
    assert.equal(body(rejected).errorCode, 'WORKSPACE_MISMATCH');
  } finally { await client.close(); }
}));

it('an explicit workspace flag requires an absolute value and fails before creating a default cache', async () => fixture(async (a) => {
  for (const args of [['--workspace'], ['--workspace', 'relative'], ['-w'], ['-w', '--development']]) {
    const result = spawnSync(process.execPath, [path.resolve('dist/index.js'), ...args],
      { cwd: a, input: '', encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 262144 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--workspace requires an absolute directory path/);
  }
  await assert.rejects(fs.stat(path.join(a, '.cache')), { code: 'ENOENT' });
}));
