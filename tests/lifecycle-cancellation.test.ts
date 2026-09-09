import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { getDefaultConfig } from '../src/Core/Config.js';
import { ToolRouter } from '../src/Core/ToolRouter.js';
import { WinCodeMcpServer } from '../src/Gateway/McpServer.js';
import { ResourceManager, killProcessTree, withTimeout } from '../src/Core/ResourceManager.js';
import { checkOperation } from '../src/Core/OperationContext.js';

it('a stuck adapter cannot prevent other owners and a real child from closing within the shared budget', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-stuck-stop-'));
  const config = getDefaultConfig(root); config.timeouts.shutdownMs = 600;
  const router = new ToolRouter(config);
  const child = cp.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
  const exited = once(child, 'exit');
  router.resources.registerProcess('stuck-stop-fixture', child);
  let closed = false;
  t.mock.method(router.repomix, 'dispose', () => new Promise<void>(() => {}));
  t.mock.method(router.flaui, 'dispose', async () => { closed = true; });
  try {
    await assert.rejects(withTimeout(router.dispose(), 2000, 'test-stop'), /resources failed/);
    await withTimeout(exited, 1000, 'test-child-exit');
    assert.equal(closed, true);
    assert.equal(router.resources.childProcessCount(), 0);
    await assert.rejects(router.dispose(), /resources failed/);
  } finally { await killProcessTree(child); await fs.rm(root, { recursive: true, force: true }); }
});

it('shutdown during initialization prevents later stages and releases late resources', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-init-stop-'));
  const config = getDefaultConfig(root);
  config.adapters.flaui.enabled = false;
  const router = new ToolRouter(config);
  let release!: () => void, entered!: () => void, closed = 0, laterStages = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entry = new Promise<void>(resolve => { entered = resolve; });
  t.mock.method(router.repomix, 'initialize', async () => {
    entered(); await gate;
    router.resources.register('disposable', 'late-init', () => { closed++; });
  });
  t.mock.method(router.text, 'initialize', async () => { laterStages++; });
  try {
    const start = router.initialize();
    const rejection = assert.rejects(start, /shutting down|cancelled/i);
    await entry;
    const stop = router.dispose();
    release();
    await Promise.all([rejection, stop]);
    assert.equal(laterStages, 0);
    assert.equal(closed, 1);
    assert.equal((await router.getRuntimeHealth()).workspaceWatch.active, false);
    assert.equal(router.resources.list().length, 0);
  } finally { release(); await router.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});

async function fixture(run: (router: ToolRouter, server: WinCodeMcpServer, client: Client) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-wp3-'));
  const config = getDefaultConfig(root);
  config.adapters.repomix.useCli = false;

  config.adapters.flaui.enabled = false;
  const router = new ToolRouter(config);
  const server = new WinCodeMcpServer(router);
  const client = new Client({ name: 'wp3-fixture', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(a), (server as any).server.connect(b)]);
    await run(router, server, client);
  } catch (error) {
    console.error('Lifecycle fixture assertion:', error);
    throw error;
  } finally {
    await client.close();
    await server.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
}

it('hello reads unknown or stale snapshots without invoking probes or spawning processes', async t => fixture(async (router, _server, client) => {
  router.config.adapters.flaui.enabled = true;
  router.config.adapters.repomix.useCli = true;
  for (const adapter of [router.text, router.repomix, router.flaui])
    t.mock.method(adapter, 'checkHealth', async () => { throw new Error('hello must not probe'); });
  const spawn = t.mock.method(cp, 'spawn', () => { throw new Error('unexpected child process'); });
  const execSync = t.mock.method(cp, 'execSync', () => { throw new Error('unexpected command probe'); });
  syncBuiltinESMExports();
  try {
    const result: any = await client.callTool({ name: 'wincode_hello_world', arguments: {} });
    assert.notEqual(result.isError, true);
    const health = JSON.parse(result.content[0].text).health;
    assert.equal(health.repomix.available, null);
    assert.equal(health.flaui.available, null);
    assert.equal(health.text.semanticConfigured, false);
    assert.equal(health.healthObservation.repomix.state, 'unknown');
    (router.repomix as any).healthCache = { at: 1, value: { available: true, source: 'installed' } };
    const snapshot = await router.getRuntimeHealth();
    assert.equal(snapshot.repomix.source, 'installed');
    assert.equal(snapshot.healthObservation.repomix.observedAt, new Date(1).toISOString());
    assert.equal(spawn.mock.callCount(), 0);
    assert.equal(execSync.mock.callCount(), 0);
  } finally { spawn.mock.restore(); execSync.mock.restore(); syncBuiltinESMExports(); }
}));

it('diagnose retains active checks while hello remains passive', async t => fixture(async (router, _server, client) => {
  const calls: string[] = [];
  t.mock.method(router.diagnostics, 'runDiagnostics', async () => { await router.text.checkHealth(); return { fixture: true } as any; });
  for (const [name, adapter] of Object.entries({ text: router.text, repomix: router.repomix, flaui: router.flaui }))
    t.mock.method(adapter, 'checkHealth', async () => { calls.push(name); return { available: true, source: 'installed' as const }; });
  const result = await client.callTool({ name: 'wincode_diagnose_project', arguments: {} });
  assert.notEqual(result.isError, true);
  assert.deepEqual(calls, ['text', 'repomix', 'flaui']);
}));

it('cleanup retains failure, finishes other owners, and does not claim repeated success', async () => {
  const resources = new ResourceManager();
  const calls: string[] = [];
  resources.register('disposable', 'last', async () => { await new Promise(resolve => setImmediate(resolve)); calls.push('last'); });
  resources.register('disposable', 'broken', () => { calls.push('broken'); throw new Error('x'.repeat(2000)); });
  const failures = await Promise.allSettled([resources.dispose(), resources.dispose()]);
  assert.deepEqual(calls, ['broken', 'last']);
  assert.ok(failures.every(result => result.status === 'rejected'));
  await assert.rejects(resources.dispose(), /Resource cleanup failed/);
  const report = resources.getCloseReport();
  assert.deepEqual(report.results.map(result => [result.owner, result.outcome]), [['broken', 'failed'], ['last', 'closed']]);
  assert.equal(report.results[0].error?.length, 1024);
  assert.equal(resources.list().length, 1);
});

it('gateway still closes transport when router disposal fails and retains the failure', async () => {
  const router = new ToolRouter(getDefaultConfig(process.cwd()));
  router.dispose = async () => { throw new Error('fixture cleanup failure'); };
  const server = new WinCodeMcpServer(router);
  let closes = 0;
  (server as any).server.close = async () => { closes++; };
  await assert.rejects(server.stop(), /Gateway shutdown failed/);
  await assert.rejects(server.stop(), /Gateway shutdown failed/);
  assert.equal(closes, 1);
});

it('failed initialization cleans acquired resources before returning', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-init-fail-'));
  const router = new ToolRouter(getDefaultConfig(root));
  let closed = 0;
  t.mock.method(router.repomix, 'initialize', async () => {
    router.resources.register('disposable', 'init-fixture', () => { closed++; });
    throw new Error('fixture init failure');
  });
  try {
    await assert.rejects(router.initialize(), /fixture init failure/);
    assert.equal(closed, 1);
    assert.equal(router.isShuttingDown, true);
    await router.dispose();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('resource disposal verifies an owned real PID has exited', { timeout: 10000 }, async () => {
  const child = cp.spawn(process.execPath, ['-e', "console.log('ready');setInterval(()=>{},1000)"], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  try {
    await once(child.stdout!, 'data');
    const resources = new ResourceManager();
    resources.registerProcess('fixture-child', child);
    await resources.dispose();
    assert.throws(() => process.kill(child.pid!, 0), (error: any) => error.code === 'ESRCH');
    await closed;
    assert.equal(resources.getCloseReport().results[0].outcome, 'closed');
  } finally { await killProcessTree(child); }
});

it('MCP cancellation stops local scanning, releases the opened file and permits a next request', { timeout: 10000 }, async t => fixture(async (router, _server, client) => {
  await fs.writeFile(path.join(router.config.workspaceRoot, 'Target.cs'), 'class Target {}');
  let reached!: () => void;
  const reading = new Promise<void>(resolve => { reached = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let closed = 0;
  let reads = 0;
  let receivedSignal: AbortSignal | undefined;
  const query = router.findCodeSymbols.bind(router);
  t.mock.method(router, 'findCodeSymbols', (name: string, kind?: string, signal?: AbortSignal) => { receivedSignal = signal; return query(name, kind, signal); });
  const originalOpen = fs.open.bind(fs);
  const opened = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (!String(args[0]).endsWith('Target.cs')) return handle;
    const read = handle.read.bind(handle);
    const close = handle.close.bind(handle);
    handle.read = (async (...parameters: any[]) => { reads++; reached(); await gate; return (read as any)(...parameters); }) as any;
    handle.close = async () => { closed++; await close(); };
    return handle;
  });
  const controller = new AbortController();
  const request = client.callTool({ name: 'wincode_find_code_symbol', arguments: { query: 'Target' } }, { signal: controller.signal }).catch(error => error);
  try {
    await reading;
    controller.abort();
    await request;
    for (let attempt = 0; attempt < 20 && !receivedSignal?.aborted; attempt++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(receivedSignal?.aborted, true);
  } finally { release(); }
  assert.equal(await router.waitForIdle(2000), true);
  assert.equal(reads, 1);
  assert.equal(closed, 1);
  opened.mock.restore();
  const next: any = await client.callTool({ name: 'wincode_find_code_symbol', arguments: { query: 'Target' } });
  assert.notEqual(next.isError, true);
  assert.equal(JSON.parse(next.content[0].text).symbols[0].name, 'Target');
}));

it('cancelled queued workspace switch preserves the current workspace', async () => fixture(async router => {
  await router.acquireRequestSlot();
  const controller = new AbortController();
  const before = router.config.workspaceRoot;
  const pending = router.openWorkspace(path.join(before, 'other'), {}, controller.signal);
  controller.abort();
  await assert.rejects(pending, /cancel|abort/i);
  router.endRequest();
  assert.equal(router.config.workspaceRoot, before);
  assert.equal(router.isSwitchingWorkspace, false);
}));

it('operation deadlines reject before starting work', () => {
  assert.throws(() => checkOperation({ deadline: Date.now() - 1 }), /timed out/);
});

it('shutdown drains a resource registered during cleanup and retains its error', async () => {
  const resources = new ResourceManager();
  let finished = false;
  resources.register('disposable', 'parent', () => {
    resources.register('disposable', 'late', async () => {
      await new Promise(resolve => setImmediate(resolve));
      finished = true;
      throw undefined;
    });
  });
  await assert.rejects(resources.dispose(), /Resource cleanup failed/);
  assert.equal(finished, true);
  assert.equal(resources.getCloseReport().results.find(result => result.owner === 'late')?.outcome, 'failed');
  await assert.rejects(resources.dispose());
});

it('context cancellation during file reading does not continue to full-text packing', async t => fixture(async router => {
  await fs.writeFile(path.join(router.config.workspaceRoot, 'Target.cs'), 'class Target {}');
  const controller = new AbortController();
  const read = fs.readFile.bind(fs);
  t.mock.method(fs, 'readFile', (async (...args: any[]) => {
    if (String(args[0]).endsWith('Target.cs')) controller.abort();
    return (read as any)(...args);
  }) as any);
  let packs = 0;
  t.mock.method(router.repomix, 'packWorkspace', async () => { packs++; throw new Error('must not pack after abort'); });
  await assert.rejects(router.prepareContext({ task: 'Target', scopeFiles: ['Target.cs'], includeFullText: true }, controller.signal), /abort|cancel/i);
  assert.equal(packs, 0);
}));

it('cancelling one pack does not cancel another caller or reuse its pending result', async t => fixture(async router => {
  let entered = 0;
  let both!: () => void;
  const ready = new Promise<void>(resolve => { both = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(router.repomix as any, 'packWithFallback', async (_options: unknown, operation: any) => {
    if (++entered === 2) both();
    await gate;
    checkOperation(operation);
    return { content: 'peer content', fileCount: 1, totalCharacters: 12, fromCache: false, source: 'builtin-fallback' };
  });
  const controller = new AbortController();
  const first = router.repomix.packWorkspace({ candidateFiles: ['Target.cs'] }, { signal: controller.signal });
  const rejected = assert.rejects(first, /abort|cancel/i);
  const second = router.repomix.packWorkspace({ candidateFiles: ['Target.cs'] }, { signal: new AbortController().signal });
  await ready;
  controller.abort();
  release();
  await rejected;
  assert.equal((await second).content, 'peer content');
  assert.equal(entered, 2);
}));
