import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nativeFs from 'node:fs';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { ToolRouter, WorkspaceRecoveryRequiredError } from '../src/Core/ToolRouter.js';
import { getDefaultConfig } from '../src/Core/Config.js';
import { WinCodeMcpServer } from '../src/Gateway/McpServer.js';

async function fixture(run: (router: ToolRouter, a: string, b: string, client: Client) => Promise<void>, expectedCleanupFailure = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-recovery-'));
  const a = path.join(root, 'a'), b = path.join(root, 'b');
  await fs.mkdir(a); await fs.mkdir(b);
  await fs.writeFile(path.join(a, 'OnlyA.cs'), 'class OnlyA {}');
  await fs.writeFile(path.join(b, 'OnlyB.cs'), 'class OnlyB {}');
  const config = getDefaultConfig(a);
  config.adapters.serena.enabled = false; config.adapters.flaui.enabled = false;
  config.adapters.repomix.useCli = false;
  const router = new ToolRouter(config);
  const server = new WinCodeMcpServer(router);
  const client = new Client({ name: 'recovery-fixture', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await router.initialize();
    await Promise.all([client.connect(left), (server as any).server.connect(right)]);
    await run(router, a, b, client);
  } finally {
    await client.close();
    if (expectedCleanupFailure) await assert.rejects(server.stop(), /Gateway shutdown failed/);
    else await server.stop();
    assert.equal(router.inFlightRequests, 0);
    assert.equal((await router.getRuntimeHealth()).workspaceWatch.active, false);
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative.startsWith('wincode-recovery-') && !relative.includes(path.sep));
    await fs.rm(root, { recursive: true, force: true });
  }
}

const body = (result: any) => JSON.parse(result.content[0].text);

it('internal Serena close failure requests Gateway restart instead of repeating an unrecoverable reset', async () => fixture(async (router, _a, b, client) => {
  let closes = 0;
  (router.serena as any).serenaClient = {
    close: async () => { closes++; if (closes === 1) throw new Error('fixture transient client close failure'); },
  };
  const failed = await client.callTool({ name: 'workspace_open', arguments: { path: b } });
  assert.equal(failed.isError, true);
  assert.equal(body(failed).workspaceRecovery.recoveryAction, 'restart_gateway');
  assert.match(body(failed).errorMessage, /restart the Gateway/);
  const sessionId = router.session.current?.id;
  for (let attempt = 0; attempt < 2; attempt++) {
    const repeated = await client.callTool({ name: 'workspace_open', arguments: { path: b } });
    assert.equal(body(repeated).workspaceRecovery.recoveryAction, 'restart_gateway');
    assert.equal(router.session.current?.id, sessionId, 'permanent failure must not mutate the session again');
  }
  assert.equal(closes, 1);
  await assert.rejects(router.acquireRequestSlot(), WorkspaceRecoveryRequiredError);
  const health = body(await client.callTool({ name: 'wincode_hello_world', arguments: {} })).health;
  assert.equal(health.workspaceRecovery.recoveryAction, 'restart_gateway');
}, true));

it('native watcher creation failure blocks queries and a later open recreates the watcher', async t => fixture(async (router, _a, b) => {
  const failed = t.mock.method(nativeFs, 'watch', () => { throw new Error('fixture native watch creation failure'); });
  try { await assert.rejects(router.openWorkspace(b), WorkspaceRecoveryRequiredError); }
  finally { failed.mock.restore(); }
  assert.equal(router.workspaceRecoveryState?.recoveryAction, 'workspace_open');
  assert.equal((await router.getRuntimeHealth()).workspaceWatch.active, false);
  await assert.rejects(router.acquireRequestSlot(), WorkspaceRecoveryRequiredError);
  await router.openWorkspace(b);
  assert.equal(router.workspaceRecoveryState, null);
  assert.equal((await router.getRuntimeHealth()).workspaceWatch.active, true);
  assert.equal((await router.getRuntimeHealth()).workspaceWatch.root, b);
}));

it('a retained native watcher close failure requires restart and is not advertised as reopenable', async t => {
  const native = new EventEmitter() as nativeFs.FSWatcher;
  native.close = () => { throw new Error('fixture native close failure'); };
  const mock = t.mock.method(nativeFs, 'watch', () => native);
  try {
    await fixture(async (router, _a, b) => {
      await assert.rejects(router.openWorkspace(b), WorkspaceRecoveryRequiredError);
      assert.equal(router.workspaceRecoveryState?.recoveryAction, 'restart_gateway');
      const sessionId = router.session.current?.id;
      await assert.rejects(router.openWorkspace(b), WorkspaceRecoveryRequiredError);
      assert.equal(router.session.current?.id, sessionId);
    }, true);
  } finally { mock.mock.restore(); }
});

it('watcher failure during adapter initialization cannot commit a successful workspace switch', async t => fixture(async (router, _a, b) => {
  const original = nativeFs.watch;
  let targetWatch: nativeFs.FSWatcher | undefined;
  t.mock.method(nativeFs, 'watch', (...args: Parameters<typeof original>) => { targetWatch = original(...args); return targetWatch; });
  const initialize = router.serena.initialize.bind(router.serena);
  const fault = t.mock.method(router.serena, 'initialize', async () => {
    await initialize();
    targetWatch!.emit('error', new Error('fixture asynchronous watch failure'));
  });
  try { await assert.rejects(router.openWorkspace(b), WorkspaceRecoveryRequiredError); }
  finally { fault.mock.restore(); }
  assert.equal(router.workspaceRecoveryState?.phase, 'watch-confirmation');
  await assert.rejects(router.acquireRequestSlot(), WorkspaceRecoveryRequiredError);
  await router.openWorkspace(b);
  assert.equal(router.workspaceRecoveryState, null);
}));

it('invalid target preserves the old workspace and still admits requests', async () => fixture(async (router, a, b) => {
  const before = router.session.current?.id;
  await assert.rejects(router.openWorkspace(path.join(b, 'missing')), /Invalid workspace/);
  assert.equal(router.config.workspaceRoot, a);
  assert.equal(router.session.current?.id, before);
  assert.equal(router.workspaceRecoveryState, null);
  await router.acquireRequestSlot(); router.endRequest();
}));

for (const stage of ['namespace', 'session', 'watch', 'dispose', 'reset', 'initialize', 'serena', 'composites']) {
  it(`failure at ${stage} blocks queries; same-root recovery performs a full rebind`, async t => fixture(async (router, a, b, client) => {
    await router.cache.set('isolation', 'A');
    const targets: Record<string, [any, string]> = {
      namespace: [router.cache, 'setNamespace'], session: [router.session, 'open'],
      watch: [router, 'bindWatch'], dispose: [router.repomix, 'dispose'],
      reset: [router.serena, 'resetConnection'], initialize: [router.repomix, 'initialize'],
      serena: [router.serena, 'initialize'], composites: [router, 'bindCompositeTools'],
    };
    const [target, method] = targets[stage];
    const fault = t.mock.method(target, method, () => { throw new Error(`fixture:${stage}`); });
    try { await assert.rejects(router.openWorkspace(b), WorkspaceRecoveryRequiredError); }
    finally { fault.mock.restore(); }
    assert.equal(router.config.workspaceRoot, b);
    await assert.rejects(router.acquireRequestSlot(), WorkspaceRecoveryRequiredError);
    assert.equal(router.inFlightRequests, 0);
    const query = await client.callTool({ name: 'wincode_list_directory', arguments: {} });
    assert.equal(query.isError, true);
    assert.equal(body(query).errorCode, 'WORKSPACE_RECOVERY_REQUIRED');
    const hello = await client.callTool({ name: 'wincode_hello_world', arguments: {} });
    assert.notEqual(hello.isError, true);
    assert.equal(body(hello).status, 'recovery_required');
    assert.equal(body(hello).health.workspaceRecovery.recoveryAction, 'workspace_open');
    // An invalid recovery attempt must never reopen admission.
    await assert.rejects(router.openWorkspace(path.join(b, 'missing')));
    await assert.rejects(router.acquireRequestSlot(), WorkspaceRecoveryRequiredError);
    const resets = t.mock.method(router.serena, 'resetConnection', router.serena.resetConnection.bind(router.serena));
    const opened = await client.callTool({ name: 'wincode_workspace_open', arguments: { path: b } });
    assert.notEqual(opened.isError, true);
    // Router resets explicitly; Serena.initialize also disposes its prior connection.
    assert.equal(resets.mock.callCount(), 2);
    assert.equal(router.workspaceRecoveryState, null);
    const health = await router.getRuntimeHealth();
    assert.equal(health.session?.workspaceRoot, b);
    assert.equal(health.workspaceWatch.root, b);
    assert.equal(health.session?.cacheNamespace, router.cache.currentNamespace);
    assert.equal(await router.cache.get('isolation'), null);
    const listing = body(await client.callTool({ name: 'wincode_list_directory', arguments: {} }));
    assert.ok(listing.entries.some((entry: any) => entry.path === 'OnlyB.cs'));
    assert.ok(!listing.entries.some((entry: any) => entry.path === 'OnlyA.cs'));
    await router.openWorkspace(a);
  }));
}

it('cancellation after root preparation rejects queued queries until recovery', async t => fixture(async (router, a, b) => {
  const controller = new AbortController();
  const original = router.workspace.openWorkspace.bind(router.workspace);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const proceed = new Promise<void>(resolve => { release = resolve; });
  const fault = t.mock.method(router.workspace, 'openWorkspace', async (...args: Parameters<typeof original>) => {
    const result = await original(...args); entered(); await proceed; return result;
  });
  const switching = assert.rejects(router.openWorkspace(b, {}, controller.signal), /cancel|abort/i);
  await started;
  const query = assert.rejects(router.acquireRequestSlot(), WorkspaceRecoveryRequiredError);
  controller.abort(); release();
  try { await Promise.all([switching, query]); } finally { fault.mock.restore(); }
  assert.equal(router.config.workspaceRoot, b);
  assert.equal(router.workspaceRecoveryState?.phase, 'workspace');
  await router.openWorkspace(a);
  await router.acquireRequestSlot(); router.endRequest();
}));

it('metadata failure returns partial with durable location; retry and restart preserve moved bytes', async t => fixture(async (router, a, _b, client) => {
  const original = fs.writeFile;
  const fault = t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
    if (String(args[0]).endsWith('.meta.json')) throw new Error('fixture metadata failure');
    return original(...args);
  });
  let result: any;
  try {
    const response = await client.callTool({ name: 'wincode_safe_move_to_trash', arguments: { filePath: 'OnlyA.cs' } });
    assert.equal(response.isError, true); result = body(response);
  } finally { fault.mock.restore(); }
  assert.equal(result.success, false); assert.equal(result.outcome, 'partial');
  assert.equal(result.errorCode, 'TRASH_METADATA_FAILED');
  assert.equal(result.failureStage, 'metadata');
  assert.equal(result.originalPath, path.join(a, 'OnlyA.cs'));
  await assert.rejects(fs.stat(result.originalPath), { code: 'ENOENT' });
  assert.equal(await fs.readFile(result.trashPath, 'utf8'), 'class OnlyA {}');
  const retry = await router.moveToTrash('OnlyA.cs');
  assert.equal(retry.outcome, 'not_moved'); assert.equal(retry.trashPath, '');
  assert.equal(await fs.readFile(result.trashPath, 'utf8'), 'class OnlyA {}');
  // Simulate a fresh manager without relying on any in-memory recovery state.
  const { WorkspaceManager } = await import('../src/Core/Workspace.js');
  const restarted = new WorkspaceManager(getDefaultConfig(a));
  const repeated = await restarted.moveToTrash('OnlyA.cs');
  assert.equal(repeated.outcome, 'not_moved');
  assert.equal(await fs.readFile(result.trashPath, 'utf8'), 'class OnlyA {}');
}));

for (const stage of ['prepare', 'move'] as const) {
  it(`trash ${stage} failure leaves source intact and does not advertise a destination`, async t => fixture(async (router, a) => {
    const method = stage === 'prepare' ? 'mkdir' : 'rename';
    const fault = t.mock.method(fs, method, async () => { throw new Error(`fixture ${stage}`); });
    let result;
    try { result = await router.moveToTrash('OnlyA.cs'); } finally { fault.mock.restore(); }
    assert.equal(result.outcome, 'not_moved'); assert.equal(result.failureStage, stage);
    assert.equal(result.trashPath, '');
    assert.equal(await fs.readFile(path.join(a, 'OnlyA.cs'), 'utf8'), 'class OnlyA {}');
    const retry = await router.moveToTrash('OnlyA.cs');
    assert.equal(retry.outcome, 'completed'); assert.equal(retry.success, true);
    assert.equal(JSON.parse(await fs.readFile(retry.metadataPath!, 'utf8')).originalPath, path.join(a, 'OnlyA.cs'));
  }));
}

it('same-named files moved in the same timestamp retain separate contents and metadata', async t => fixture(async (router, a) => {
  await fs.mkdir(path.join(a, 'nested'));
  await fs.writeFile(path.join(a, 'nested', 'OnlyA.cs'), 'second file');
  t.mock.method(Date.prototype, 'toISOString', () => '2026-09-09T00:00:00.000Z');
  const first = await router.moveToTrash('OnlyA.cs');
  const second = await router.moveToTrash('nested/OnlyA.cs');
  assert.equal(first.outcome, 'completed'); assert.equal(second.outcome, 'completed');
  assert.notEqual(first.trashPath, second.trashPath);
  assert.equal(await fs.readFile(first.trashPath, 'utf8'), 'class OnlyA {}');
  assert.equal(await fs.readFile(second.trashPath, 'utf8'), 'second file');
  assert.equal(JSON.parse(await fs.readFile(second.metadataPath!, 'utf8')).originalPath, path.join(a, 'nested', 'OnlyA.cs'));
}));

it('long ASCII and Unicode names retain complete payload and metadata without name overflow', async () => fixture(async (router, a) => {
  const names = [183, 184, 190, 193, 194, 200, 220, 255].map(length => 'x'.repeat(length - 4) + '.txt');
  // UTF-8 and UTF-16 limits differ: avoid splitting Unicode code points when shortening.
  names.push('汉'.repeat(80) + '.txt', '😀'.repeat(60) + '.txt');
  for (const [index, name] of names.entries()) {
    const source = path.join(a, name);
    const content = `original content ${index}`;
    await fs.writeFile(source, content);
    const result = await router.moveToTrash(name);
    assert.equal(result.outcome, 'completed', `${name.length}: ${result.message}`);
    assert.ok(Buffer.byteLength(path.basename(result.metadataPath!)) <= 255);
    assert.equal(await fs.readFile(result.trashPath, 'utf8'), content);
    assert.equal(JSON.parse(await fs.readFile(result.metadataPath!, 'utf8')).originalPath, source);
    await assert.rejects(fs.stat(source), { code: 'ENOENT' });
  }
}));
