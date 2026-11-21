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
async function fixture(run: (f: { root: string; router: ToolRouter; server: WinCodeMcpServer; client: Client; call: (name: string, args?: any, signal?: AbortSignal) => Promise<any> }) => Promise<void>, ...subdirectories: string[]) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-admission-'));
  const root = path.join(temporary, ...subdirectories);
  if (subdirectories.length) await fs.mkdir(root, { recursive: true });
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
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir())); assert.ok(path.basename(temporary).startsWith('wincode-admission-'));
    await fs.rm(temporary, { recursive: true, force: true });
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

it('trash retains completed and partial file outcomes when metadata finalization crosses the deadline', async t => fixture(async ({ root, router, call }) => {
  const now = Date.now.bind(Date), write = fs.writeFile.bind(fs);
  let advance = 0, failMetadata = false;
  router.config.timeouts.fileScanMs = 1000;
  t.mock.method(Date, 'now', () => now() + advance);
  const metadataWrite = t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
    if (String(args[0]).startsWith(root + path.sep) && String(args[0]).endsWith('.meta.json')) {
      advance = 2000;
      if (failMetadata) throw new Error('fixture metadata failure after deadline');
    }
    return write(...args);
  });
  try {
    for (const partial of [false, true]) {
      advance = 0; failMetadata = partial;
      const file = partial ? 'partial.txt' : 'completed.txt';
      const originalPath = path.join(root, file);
      await write(originalPath, 'preserve this payload');
      const response = await call('wincode_safe_move_to_trash', { filePath: file });
      const result = body(response);
      assert.equal(result.outcome, partial ? 'partial' : 'completed');
      assert.equal(response.isError, partial);
      assert.equal(result.originalPath, originalPath);
      await assert.rejects(fs.stat(originalPath), { code: 'ENOENT' });
      assert.equal(path.dirname(result.trashPath), router.config.trashDir);
      assert.equal(await fs.readFile(result.trashPath, 'utf8'), 'preserve this payload');
      if (partial) {
        assert.equal(result.errorCode, 'TRASH_METADATA_FAILED');
        assert.equal(result.failureStage, 'metadata');
        assert.deepEqual(response.structuredContent, result);
        await assert.rejects(fs.stat(result.metadataPath), { code: 'ENOENT' });
      } else assert.equal(JSON.parse(await fs.readFile(result.metadataPath, 'utf8')).originalPath, originalPath);
    }
    assert.equal(router.admission.snapshot().business.timedOut, 2);
    assert.equal(router.admission.pendingCount, 0);
  } finally { advance = 0; metadataWrite.mock.restore(); }
}));

it('trash cancellation during path validation leaves the source untouched and releases admission after cleanup', async t => fixture(async ({ root, router, call }) => {
  const originalPath = path.join(root, 'keep.txt');
  await fs.writeFile(originalPath, 'keep');
  const entered = deferred(), resume = deferred(), controller = new AbortController();
  const realpath = fs.realpath.bind(fs), move = router.moveToTrash.bind(router);
  let operationSignal: AbortSignal | undefined;
  t.mock.method(router, 'moveToTrash', (file: string, reason?: string, signal?: AbortSignal) => {
    operationSignal = signal;
    return (move as any)(file, reason, signal);
  });
  const heldPath = t.mock.method(fs, 'realpath', async (...args: Parameters<typeof fs.realpath>) => {
    const result = await realpath(...args);
    if (String(args[0]) === originalPath) { entered.resolve(); await resume.promise; }
    return result;
  });
  const rename = t.mock.method(fs, 'rename', fs.rename.bind(fs));
  const pending = call('wincode_safe_move_to_trash', { filePath: 'keep.txt' }, controller.signal).catch(error => error);
  try {
    await entered.promise;
    assert.ok(operationSignal, 'trash must receive the request cancellation signal');
    controller.abort();
    await until(() => operationSignal!.aborted, 'cancellation must reach the operation before validation resumes');
  } finally { resume.resolve(); await pending; heldPath.mock.restore(); }
  await until(() => router.admission.pendingCount === 0, 'cancelled operation must finish cleanup');
  assert.equal(rename.mock.callCount(), 0);
  assert.equal(await fs.readFile(originalPath, 'utf8'), 'keep');
  assert.equal(router.admission.snapshot().business.cancelled, 1);
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

it('workspace_open cancellation stops fingerprint, discovery and optional tree work at their current I/O', async t => fixture(async ({ root, call, router }) => {
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src', 'Api.ts'), 'export class Api {}');
  const originalSession = { ...router.session.current! };
  const open = router.openWorkspace.bind(router), list = router.workspace.listDirectory.bind(router.workspace);
  const readDir = fs.readdir.bind(fs), openDir = fs.opendir.bind(fs), stat = fs.stat.bind(fs);
  const gitStatus = router.workspace.getGitStatus.bind(router.workspace);
  let received: AbortSignal | undefined, tree = false, entered = deferred(), resume = deferred();
  let stage = '', lateStats = 0, lateDirectoryReads = 0, lateGit = 0, held = false;
  const pause = async () => { held = true; entered.resolve(); await resume.promise; };
  t.mock.method(router, 'openWorkspace', (target: string, options: any, signal?: AbortSignal) => {
    received = signal; return open(target, options, signal);
  });
  t.mock.method(router.workspace, 'listDirectory', (...args: Parameters<typeof list>) => { tree = true; return list(...args); });
  t.mock.method(router.workspace, 'getGitStatus', (...args: Parameters<typeof gitStatus>) => {
    if (received?.aborted) lateGit++; return gitStatus(...args);
  });
  t.mock.method(fs, 'readdir', async (...args: Parameters<typeof fs.readdir>) => {
    const entries = await readDir(...args);
    if (stage === 'fingerprint' && !held && String(args[0]) === root) await pause();
    return entries;
  });
  t.mock.method(fs, 'stat', (...args: Parameters<typeof fs.stat>) => {
    if (received?.aborted && held) lateStats++; return stat(...args);
  });
  t.mock.method(fs, 'opendir', async (...args: Parameters<typeof fs.opendir>) => {
    const directory = await openDir(...args);
    if ((stage === 'discovery' && !tree) || (stage === 'tree' && tree)) {
      const read = directory.read.bind(directory);
      directory.read = (async () => {
        if (received?.aborted && held) lateDirectoryReads++;
        const entry = await read();
        if (!held) await pause();
        return entry;
      }) as typeof directory.read;
    }
    return directory;
  });
  for (stage of ['fingerprint', 'discovery', 'tree']) {
    entered = deferred(); resume = deferred(); held = false; tree = false;
    const controller = new AbortController();
    const pending = call('workspace_open', { path: root, includeTree: true }, controller.signal).catch(error => error);
    try {
      await entered.promise; controller.abort();
      await until(() => received?.aborted === true, 'Cancellation should reach the MCP handler');
    } finally { resume.resolve(); await pending; }
    await until(() => router.admission.pendingCount === 0, 'Cancelled open must release admission');
    assert.deepEqual([lateStats, lateDirectoryReads, lateGit], [0, 0, 0], stage);
    assert.deepEqual(router.session.current, originalSession);
  }
  stage = ''; held = false;
  assert.equal(body(await call('workspace_open', { path: root })).workspace, root);
}));

it('workspace_open cancellation during root validation stops additional filesystem probes', async t => fixture(async ({ root, router, call }) => {
  const ancestor = path.resolve(root, '../../../..'), controller = new AbortController();
  const openWorkspace = router.workspace.openWorkspace.bind(router.workspace);
  const lstat = fs.lstat.bind(fs), stat = fs.stat.bind(fs);
  const late: string[] = [];
  let signal: AbortSignal | undefined;
  t.mock.method(router.workspace, 'openWorkspace', (...args: Parameters<typeof openWorkspace>) => {
    signal = args[2]?.signal;
    return openWorkspace(...args);
  });
  t.mock.method(fs, 'lstat', async (...args: Parameters<typeof fs.lstat>) => {
    if (signal?.aborted) late.push('lstat ' + path.basename(String(args[0])));
    const result = await lstat(...args);
    if (signal && !controller.signal.aborted && String(args[0]) === ancestor) {
      controller.abort();
      await until(() => signal?.aborted === true, 'Root validation must receive the MCP cancellation');
    }
    return result;
  });
  t.mock.method(fs, 'stat', (...args: Parameters<typeof fs.stat>) => {
    if (signal?.aborted) late.push('stat ' + path.basename(String(args[0])));
    return stat(...args);
  });
  const session = { ...router.session.current! };
  await assert.rejects(call('workspace_open', { path: root }, controller.signal));
  await until(() => router.admission.pendingCount === 0, 'The cancelled root check must settle');
  assert.equal(signal?.aborted, true);
  assert.deepEqual(late, []); assert.deepEqual(router.session.current, session);
  signal = undefined;
  assert.equal(body(await call('workspace_open', { path: root })).workspace, root);
  t.diagnostic(JSON.stringify({ remainingPathComponents: 4, filesystemProbesAfterCancellation: late.length }));
}, 'one', 'two', 'three', 'four'));

it('workspace_open cancellation between descriptor operations stops reads and closes acquired handles', async t => fixture(async ({ root, router, call }) => {
  const descriptor = path.join(root, 'Review.csproj');
  await fs.writeFile(descriptor, '<Project><!--' + 'x'.repeat(70 * 1024) + '--></Project>');
  const openWorkspace = router.workspace.openWorkspace.bind(router.workspace);
  const realpath = fs.realpath.bind(fs), open = fs.open.bind(fs);
  const stages = ['realpath', 'open', 'stat', 'read'] as const;
  type Stage = typeof stages[number];
  let stopAt: Stage | undefined, signal: AbortSignal | undefined, controller = new AbortController();
  let opened = 0, closed = 0;
  const late: string[] = [];
  async function observe<T>(stage: Stage, run: () => Promise<T>): Promise<T> {
    if (signal?.aborted) late.push(stage);
    const value = await run();
    if (signal && stage === stopAt) {
      controller.abort();
      await until(() => signal?.aborted === true, 'Descriptor read must receive the MCP cancellation');
    }
    return value;
  }
  t.mock.method(router.workspace, 'openWorkspace', (...args: Parameters<typeof openWorkspace>) => {
    signal = args[2]?.signal;
    return openWorkspace(...args);
  });
  t.mock.method(fs, 'realpath', (...args: Parameters<typeof fs.realpath>) =>
    String(args[0]) === descriptor ? observe('realpath', () => realpath(...args)) : realpath(...args));
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]) !== descriptor) return open(...args);
    const handle = await observe('open', () => open(...args));
    opened++;
    const stat = handle.stat.bind(handle), read = handle.read.bind(handle), close = handle.close.bind(handle);
    t.mock.method(handle, 'stat', () => observe('stat', stat));
    t.mock.method(handle, 'read', (buffer: Buffer, offset: number, length: number, position: number) =>
      observe('read', () => read(buffer, offset, length, position)));
    t.mock.method(handle, 'close', async () => { await close(); closed++; });
    return handle;
  });
  const session = { ...router.session.current! };
  for (const stage of stages) {
    stopAt = stage; signal = undefined; controller = new AbortController();
    await assert.rejects(call('workspace_open', { path: root }, controller.signal));
    await until(() => router.admission.pendingCount === 0, 'The cancelled descriptor request must settle');
    assert.equal(controller.signal.aborted, true, stage);
    assert.deepEqual(late, [], stage); assert.equal(closed, opened, stage);
    assert.deepEqual(router.session.current, session);
  }
  t.diagnostic(JSON.stringify({ cancelAfter: stages, descriptorOperationsAfterCancellation: late.length, opened, closed }));
  stopAt = undefined; signal = undefined;
  assert.equal(body(await call('workspace_open', { path: root })).workspace, root);
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

it('admitted queue expiry stays a timeout when the clock advances before adapter entry', async t => fixture(async ({ call, router }) => {
  const hold = deferred(), mutex = new Mutex(), order: string[] = [];
  (router.text as any).findSymbolsDetailed = (query: string, _kind: unknown, _path: unknown, operation: any) =>
    mutex.runExclusive(async () => { order.push(query); if (query === 'owner') await hold.promise;
      return { symbols: [], source: 'local-text', queryComplete: true }; }, operation?.signal, operation?.queue);
  const owner = call('wincode_find_code_symbol', { query: 'owner' });
  try {
    await until(() => order.length === 1, 'owner should enter');
    router.config.timeouts.fileScanMs = 1200;
    const now = Date.now.bind(Date), acquire = router.acquireRequestSlot.bind(router);
    let advance = 0;
    t.mock.method(Date, 'now', () => now() + advance);
    t.mock.method(router, 'acquireRequestSlot', async (...args: Parameters<typeof acquire>) => {
      await acquire(...args);
      // Force any second, remaining-budget timer to fire before the admitted timer.
      advance = 600;
    });
    const expired = await call('wincode_find_code_symbol', { query: 'expired' });
    assert.equal(body(expired).errorCode, 'REQUEST_TIMEOUT');
    assert.equal(body(expired).retryable, false);
    assert.deepEqual(order, ['owner']); assert.equal(mutex.pendingCount, 0);
    assert.equal(router.admission.snapshot().business.active, 1);
    assert.equal(router.admission.snapshot().business.timedOut, 1);
    assert.equal(router.admission.snapshot().business.cancelled, 0);
  } finally { hold.resolve(); await owner; }
}));

it('deadline outcome: expiry before adapter entry is counted even before its timer runs', async t => fixture(async ({ call, router }) => {
  const now = Date.now.bind(Date), acquire = router.acquireRequestSlot.bind(router);
  let advance = 0, invoked = false;
  router.config.timeouts.fileScanMs = 1000;
  t.mock.method(Date, 'now', () => now() + advance);
  t.mock.method(router, 'acquireRequestSlot', async (...args: Parameters<typeof acquire>) => {
    await acquire(...args); advance = 2000;
  });
  router.findCodeSymbols = async () => { invoked = true; throw new Error('Expired work must not start'); };
  const result = body(await call('wincode_find_code_symbol', { query: 'expired' }));
  assert.equal(result.errorCode, 'REQUEST_TIMEOUT'); assert.equal(result.workStarted, false);
  assert.equal(invoked, false);
  const state = router.admission.snapshot().business;
  assert.equal(state.active, 0); assert.equal(state.completed, 1);
  assert.equal(state.timedOut, 1); assert.equal(state.cancelled, 0);
}));

it('deadline outcome: status results completed after the deadline cannot be returned as success', async t => fixture(async ({ call, router }) => {
  const now = Date.now.bind(Date), health = router.getRuntimeHealth.bind(router);
  let advance = 0;
  router.config.timeouts.commandProbeMs = 1000;
  t.mock.method(Date, 'now', () => now() + advance);
  t.mock.method(router, 'getRuntimeHealth', async (...args: Parameters<typeof health>) => {
    const result = await health(...args); advance = 2000; return result;
  });
  const result = await call('wincode_hello_world');
  assert.equal(result.isError, true);
  assert.equal(body(result).errorCode, 'REQUEST_TIMEOUT');
  assert.equal(body(result).workStarted, true); assert.equal(body(result).retryable, false);
  const state = router.admission.snapshot().status;
  assert.equal(state.active, 0); assert.equal(state.completed, 1);
  assert.equal(state.timedOut, 1); assert.equal(state.cancelled, 0);
}));

it('deadline outcome: a shorter adapter queue deadline preserves timeout classification and counting', async () => fixture(async ({ call, router }) => {
  const hold = deferred(), mutex = new Mutex();
  const owner = mutex.runExclusive(() => hold.promise);
  let invoked = false;
  router.config.timeouts.fileScanMs = 40;
  router.requestBudget = () => 2000;
  (router.text as any).findSymbolsDetailed = (_q: string, _kind: unknown, _path: unknown, operation: any) =>
    mutex.runExclusive(async () => { invoked = true; return { symbols: [], source: 'local-text', queryComplete: true }; },
      operation.signal, operation.queue);
  try {
    const result = body(await call('wincode_find_code_symbol', { query: 'expired' }));
    assert.equal(result.errorCode, 'REQUEST_TIMEOUT'); assert.equal(result.retryable, false);
    assert.equal(invoked, false); assert.equal(mutex.pendingCount, 0);
    const state = router.admission.snapshot().business;
    assert.equal(state.active, 0); assert.equal(state.completed, 1);
    assert.equal(state.timedOut, 1); assert.equal(state.cancelled, 0);
  } finally { hold.resolve(); await owner; }
}));

it('cancelled startup waiters are removed and passive requests stay available during initialization', async () => fixture(async ({ call, router, server, client }) => {
  const startup = deferred(); (server as any).startPromise = startup.promise;
  try {
    for (let round = 0; round < 3; round++) {
      const controllers = Array.from({ length: 8 }, () => new AbortController());
      const pending = controllers.map(c => call('wincode_find_code_symbol', { query: 'Api' }, c.signal).catch(e => e));
      await until(() => router.admission.snapshot().sharedWaiters === 8, 'startup waiters must be observable');
      assert.notEqual((await call('wincode_hello_world')).isError, true); assert.equal((await client.listTools()).tools.length, 20);
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
    assert.equal((await client.listTools()).tools.length, 20);
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
