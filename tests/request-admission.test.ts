import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { getDefaultConfig } from '../src/Core/Config.js';
import { ToolRouter } from '../src/Core/ToolRouter.js';
import { WinCodeMcpServer } from '../src/Gateway/McpServer.js';
import { Mutex, AbortError } from '../src/Core/ResourceManager.js';

const body = (response: any) => JSON.parse(response.content[0].text);
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
async function until(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 2500;
  while (!predicate()) { if (Date.now() > deadline) assert.fail(message); await new Promise(r => setTimeout(r, 5)); }
}
async function fixture(run: (f: { root: string; router: ToolRouter; server: WinCodeMcpServer; client: Client; call: (name: string, args?: any, signal?: AbortSignal) => Promise<any> }) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-admission-'));
  const config = getDefaultConfig(root); config.adapters.flaui.enabled = false; config.adapters.repomix.useCli = false;
  const router = new ToolRouter(config), server = new WinCodeMcpServer(router);
  const client = new Client({ name: 'bounded-admission-fixture', version: '1' });
  try {
    await router.initialize();
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), (server as any).server.connect(b)]);
    await run({ root, router, server, client, call: (name, args = {}, signal) => client.callTool({ name, arguments: args }, { signal, timeout: 8000 }) });
  } finally {
    await client.close(); await server.stop();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('wincode-admission-'));
    await fs.rm(root, { recursive: true, force: true });
  }
}

it('raw UTF-8 argument budget applies before unknown fields are discarded', async () => fixture(async ({ call, router }) => {
  let invoked = false;
  router.findCodeSymbols = async () => { invoked = true; throw new Error('must not execute'); };
  const args = { query: 'Api', unknownPadding: '中'.repeat(22000) };
  const result = await call('wincode_find_code_symbol', args);
  assert.equal(result.isError, true); assert.equal(body(result).errorCode, 'INVALID_ARGUMENT');
  assert.equal(body(result).maxArgumentBytes, 65536);
  assert.equal(body(result).argumentBytes, Buffer.byteLength(JSON.stringify(args)));
  assert.equal(invoked, false);
  const legal = await call('wincode_hello_world', { ignored: 'a'.repeat(64000) });
  assert.notEqual(legal.isError, true);
}));

for (const count of [4, 8, 16]) it(`${count} ordinary queued calls complete in FIFO order without overload`, async () => fixture(async ({ router, call }) => {
  const hold = deferred(), mutex = new Mutex(), order: string[] = [];
  (router.text as any).findSymbolsDetailed = (query: string, _kind: unknown, _path: unknown, operation: any) =>
    mutex.runExclusive(async () => { order.push(query); if (query === 'q0') await hold.promise;
      return { symbols: [], source: 'local-text', queryComplete: true }; }, operation?.signal, operation?.queue);
  const pending = Array.from({ length: count }, (_, i) => call('wincode_find_code_symbol', { query: `q${i}` }));
  try { await until(() => mutex.pendingCount === count - 1, 'normal burst should queue'); }
  finally { hold.resolve(); }
  for (const result of await Promise.all(pending)) assert.notEqual(result.isError, true);
  assert.deepEqual(order, Array.from({ length: count }, (_, i) => `q${i}`));
  assert.equal(router.admission.snapshot().business.rejected, 0); assert.equal(router.admission.pendingCount, 0);
}));

it('repeated queued cancellation frees real nodes and permits replacement while the owner stays active', async () => fixture(async ({ call, router }) => {
  const hold = deferred(), mutex = new Mutex(), order: string[] = [];
  (router.text as any).findSymbolsDetailed = (query: string, _kind: unknown, _path: unknown, operation: any) =>
    mutex.runExclusive(async () => { order.push(query); await hold.promise;
      return { symbols: [], source: 'local-text', queryComplete: true }; }, operation?.signal, operation?.queue);
  const owner = call('wincode_find_code_symbol', { query: 'owner' });
  try {
    await until(() => order.length === 1, 'owner should enter');
    for (let round = 0; round < 3; round++) {
      const controllers = Array.from({ length: 31 }, () => new AbortController());
      const pending = controllers.map((c, i) => call('wincode_find_code_symbol', { query: `cancel-${round}-${i}` }, c.signal).catch(e => e));
      await until(() => mutex.pendingCount === 31, 'replacement calls should fit the released capacity');
      controllers.forEach(c => c.abort()); await Promise.all(pending);
      await until(() => mutex.pendingCount === 0 && router.admission.pendingCount === 1, 'cancelled nodes and capacity must both disappear');
      assert.deepEqual(order, ['owner']);
    }
    assert.equal(router.admission.snapshot().business.cancelled, 93);
  } finally { hold.resolve(); await owner; }
  assert.equal(router.admission.pendingCount, 0);
}));

it('a cancelled running call holds its capacity until asynchronous cleanup actually finishes', async () => fixture(async ({ call, router }) => {
  const entered = deferred(), cleanup = deferred(), mutex = new Mutex(), controller = new AbortController();
  (router.text as any).findSymbolsDetailed = (query: string, _kind: unknown, _path: unknown, operation: any) =>
    mutex.runExclusive(async () => {
      if (query === 'owner') {
        entered.resolve();
        await new Promise<void>(resolve => operation.signal.addEventListener('abort', () => resolve(), { once: true }));
        await cleanup.promise; throw new AbortError('cancelled after cleanup');
      }
      return { symbols: [], source: 'local-text', queryComplete: true };
    }, operation?.signal, operation?.queue);
  const owner = call('wincode_find_code_symbol', { query: 'owner' }, controller.signal).catch(e => e);
  await entered.promise;
  const pending = Array.from({ length: 31 }, (_, i) => call('wincode_find_code_symbol', { query: `q${i}` }));
  try {
    await until(() => mutex.pendingCount === 31, 'queue should fill'); controller.abort(); await owner;
    assert.equal(router.admission.pendingCount, 32, 'client cancellation is earlier than actual cleanup');
    assert.equal(body(await call('wincode_find_code_symbol', { query: 'overflow' })).errorCode, 'SERVER_BUSY');
    assert.equal((await router.releaseRoslynMemory()).status, 'busy');
  } finally { cleanup.resolve(); await Promise.all(pending); }
  assert.equal(router.admission.pendingCount, 0); assert.equal(mutex.pendingCount, 0);
}));

it('queue wait consumes the request deadline and expiry removes the unexecuted adapter node', async () => fixture(async ({ call, router }) => {
  const hold = deferred(), mutex = new Mutex(), order: string[] = [];
  (router.text as any).findSymbolsDetailed = (query: string, _kind: unknown, _path: unknown, operation: any) =>
    mutex.runExclusive(async () => { order.push(query); if (query === 'owner') await hold.promise;
      return { symbols: [], source: 'local-text', queryComplete: true }; }, operation?.signal, operation?.queue);
  const owner = call('wincode_find_code_symbol', { query: 'owner' });
  try {
    await until(() => order.length === 1, 'owner should enter'); router.config.timeouts.fileScanMs = 80;
    const expired = await call('wincode_find_code_symbol', { query: 'expired' });
    assert.equal(body(expired).errorCode, 'REQUEST_TIMEOUT'); assert.equal(body(expired).retryable, false);
    assert.deepEqual(order, ['owner']); assert.equal(mutex.pendingCount, 0);
    assert.equal(router.admission.snapshot().business.active, 1); assert.equal(router.admission.snapshot().business.timedOut, 1);
  } finally { hold.resolve(); await owner; }
}));

it('cancelled startup waiters are removed and passive requests stay available during initialization', async () => fixture(async ({ call, router, server, client }) => {
  const startup = deferred(); (server as any).startPromise = startup.promise;
  try {
    for (let round = 0; round < 3; round++) {
      const controllers = Array.from({ length: 8 }, () => new AbortController());
      const pending = controllers.map(c => call('wincode_find_code_symbol', { query: 'Api' }, c.signal).catch(e => e));
      await until(() => router.admission.snapshot().sharedWaiters === 8, 'startup waiters must be observable');
      assert.notEqual((await call('wincode_hello_world')).isError, true); assert.equal((await client.listTools()).tools.length, 15);
      controllers.forEach(c => c.abort()); await Promise.all(pending);
      await until(() => router.admission.pendingCount === 0, 'cancelled startup calls must release capacity');
      assert.equal(router.admission.snapshot().sharedWaiters, 0);
    }
  } finally { startup.resolve(); }
  assert.notEqual((await call('wincode_find_code_symbol', { query: 'Api' })).isError, true);
}));

it('startup waiting does not restart the operation budget at adapter entry', async () => fixture(async ({ call, router, server }) => {
  const startup = deferred(); (server as any).startPromise = startup.promise;
  router.config.timeouts.fileScanMs = 300;
  let remaining = Infinity;
  (router.text as any).findSymbolsDetailed = async (_q: string, _k: unknown, _p: unknown, operation: any) => {
    remaining = operation.deadline - Date.now();
    return { symbols: [], source: 'local-text', queryComplete: true };
  };
  const start = Date.now(); const pending = call('wincode_find_code_symbol', { query: 'Api' });
  try {
    await until(() => router.admission.snapshot().sharedWaiters === 1, 'request must be waiting before timing the release');
    await until(() => Date.now() - start >= 220, 'consume most of the shared budget');
  } finally { startup.resolve(); }
  assert.notEqual((await pending).isError, true); assert.ok(remaining > 0 && remaining < 110, `remaining=${remaining}`);
}));

it('four lightweight status slots are bounded independently from business admission', async () => fixture(async ({ call, router, client }) => {
  const hold = deferred(), original = router.getRuntimeHealth.bind(router); let entered = 0;
  router.getRuntimeHealth = async () => { entered++; await hold.promise; return original(); };
  const pending = Array.from({ length: 4 }, () => call('wincode_hello_world'));
  try {
    await until(() => entered === 4, 'status slots should be occupied');
    assert.equal(body(await call('wincode_hello_world')).errorCode, 'SERVER_BUSY');
    await assert.rejects(client.listTools(), (error: any) => error.data?.errorCode === 'SERVER_BUSY');
    assert.notEqual((await call('wincode_find_code_symbol', { query: 'Api' })).isError, true);
    assert.equal(router.admission.snapshot().status.active, 4);
  } finally { hold.resolve(); await Promise.all(pending); }
  assert.equal(router.admission.pendingCount, 0);
}));

it('same-root recovery has bounded cancellable waiters without counting itself in the drain', async () => fixture(async ({ call, router, root }) => {
  const hold = deferred(), entered = deferred();
  (router.text as any).findSymbolsDetailed = async () => { entered.resolve(); await hold.promise;
    return { symbols: [], source: 'local-text', queryComplete: true }; };
  const owner = call('wincode_find_code_symbol', { query: 'owner' }); await entered.promise;
  await (router as any).watch.stop();
  const recovery = call('workspace_open', { path: root });
  try {
    await until(() => router.isSwitchingWorkspace, 'same-root recovery should wait for the owner');
    for (let round = 0; round < 3; round++) {
      const controls = Array.from({ length: 8 }, () => new AbortController());
      const pending = controls.map(c => call('wincode_find_code_symbol', { query: 'queued' }, c.signal).catch(e => e));
      await until(() => (router as any).workspaceLock.pendingCount === 8, 'requests should queue on the recovery barrier');
      assert.notEqual((await call('wincode_hello_world')).isError, true);
      controls.forEach(c => c.abort()); await Promise.all(pending);
      await until(() => router.admission.pendingCount === 2, 'only the owner and recovery should retain admission');
      assert.equal((router as any).workspaceLock.pendingCount, 0); assert.equal(router.inFlightRequests, 1);
    }
  } finally { hold.resolve(); await owner; }
  assert.notEqual((await recovery).isError, true); assert.equal(router.workspaceRecoveryState, null);
  assert.equal(router.admission.pendingCount, 0); assert.equal(router.inFlightRequests, 0);
}));

it('shutdown cancels admitted queue nodes and waits for the active owner to finish', async () => fixture(async ({ call, router, server }) => {
  const entered = deferred(), mutex = new Mutex(); let started = 0;
  (router.text as any).findSymbolsDetailed = (_q: string, _k: unknown, _p: unknown, operation: any) => mutex.runExclusive(async () => {
    started++; entered.resolve();
    await new Promise<void>(resolve => operation.signal.addEventListener('abort', () => resolve(), { once: true }));
    throw new AbortError('shutdown');
  }, operation?.signal, operation?.queue);
  const pending = Array.from({ length: 16 }, () => call('wincode_find_code_symbol', { query: 'Api' }).catch(e => e));
  await entered.promise; await until(() => mutex.pendingCount === 15, 'queue should exist before disconnect');
  await server.stop(); await Promise.all(pending);
  assert.equal(started, 1); assert.equal(mutex.pendingCount, 0); assert.equal(router.admission.pendingCount, 0);
  assert.equal(router.inFlightRequests, 0); assert.equal(router.resources.childProcessCount(), 0);
}));

it('passive hello uses known cache observations without scanning disk', async () => fixture(async ({ call, router }) => {
  router.cache.getStats = async () => { throw new Error('unexpected cache enumeration'); };
  const result = await call('wincode_hello_world');
  assert.notEqual(result.isError, true);
  assert.equal(body(result).health.cache.diskObservation, 'not-observed');
  assert.equal(body(result).health.cache.diskEntries, null);
}));

it('128-call burst admits 32, rejects overflow before execution, and preserves FIFO and status access', async () => fixture(async ({ call, router, root, client }) => {
  const hold = deferred(), mutex = new Mutex(), order: string[] = [], replies: any[] = [];
  (router.text as any).findSymbolsDetailed = (query: string, _kind: unknown, _path: unknown, operation: any) =>
    mutex.runExclusive(async () => { order.push(query); if (query === 'q0') await hold.promise;
      return { symbols: [], source: 'local-text', queryComplete: true }; }, operation?.signal, operation?.queue);
  const pending = Array.from({ length: 128 }, (_, i) => call('wincode_find_code_symbol', { query: `q${i}` }).then(r => { replies.push(r); return r; }));
  try {
    await until(() => replies.length === 96, 'overflow must return while the accepted owner is still blocked');
    for (const response of replies) {
      assert.equal(response.isError, true); assert.equal(body(response).errorCode, 'SERVER_BUSY');
      assert.equal(body(response).workStarted, false); assert.equal(body(response).retryable, true);
      assert.deepEqual(response.structuredContent, body(response));
    }
    assert.equal(mutex.pendingCount, 31); assert.deepEqual(order, ['q0']);
    const health = body(await call('wincode_hello_world')).health;
    assert.equal(health.admission.business.active, 32); assert.equal(health.admission.business.waiting, 31);
    assert.equal(health.admission.business.executing, 1);
    assert.equal((await client.listTools()).tools.length, 15);
    assert.equal(body(await call('workspace_open', { path: path.join(root, 'other') })).errorCode, 'WORKSPACE_MISMATCH');
    assert.equal(body(await call('workspace_open', { path: root })).errorCode, 'SERVER_BUSY');
    assert.equal((await router.releaseRoslynMemory()).status, 'busy');
  } finally { hold.resolve(); await Promise.all(pending); }
  assert.equal(replies.filter(r => !r.isError).length, 32);
  assert.deepEqual(order, Array.from({ length: 32 }, (_, i) => `q${i}`)); assert.equal(mutex.pendingCount, 0);
  const after = body(await call('wincode_hello_world')).health.admission;
  assert.equal(after.business.active, 0); assert.equal(after.business.waiting, 0);
  assert.equal(after.business.accepted, 32); assert.equal(after.business.rejected, 97);
}));
