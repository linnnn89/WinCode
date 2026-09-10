import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { getDefaultConfig } from '../src/Core/Config.js';
import { CacheManager } from '../src/Core/Cache.js';
import { RepomixAdapter } from '../src/Adapters/RepomixAdapter.js';
import { ToolRouter } from '../src/Core/ToolRouter.js';
import { WinCodeMcpServer } from '../src/Gateway/McpServer.js';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const body = (result: any) => result.structuredContent ?? JSON.parse(result.content[0].text);
async function fixture(run: (router: ToolRouter, root: string, client: Client) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-runtime-cache-'));
  const config = getDefaultConfig(root);
  config.adapters.flaui.enabled = false; config.adapters.repomix.useCli = false;
  const router = new ToolRouter(config), server = new WinCodeMcpServer(router);
  const client = new Client({ name: 'runtime-cache-regression', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await router.initialize();
    await Promise.all([client.connect(a), (server as any).server.connect(b)]);
    await run(router, root, client);
  } finally {
    await client.close(); await server.stop();
    assert.equal(path.dirname(root), os.tmpdir());
    await fs.rm(root, { recursive: true, force: true });
  }
}

for (const scenario of ['untracked-directory', 'deep-file', 'beyond-hint-budget']) {
  it(`public MCP returns current source and declarations without relying on watcher events: ${scenario}`, async () => fixture(async (router, root, client) => {
    if (scenario === 'untracked-directory') {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'pipe' });
      git('init'); await fs.writeFile(path.join(root, 'README.md'), 'fixture');
      git('add', 'README.md');
      git('-c', 'user.name=WinCode Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
    }
    if (scenario === 'beyond-hint-budget') {
      for (let i = 0; i < 110; i++) await fs.writeFile(path.join(root, `a${i}.txt`), 'hint');
    }
    const relative = scenario === 'deep-file' ? 'src/a/b/c/Target.cs' : 'src/Target.cs';
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'public class Gone { string Value = "OLD_VALUE"; }');
    const args = { task: 'Inspect source', scopeFiles: [relative], includeFullText: true, maxTokens: 8000 };
    const pack = async () => body(await client.callTool({ name: 'wincode_prepare_context', arguments: args }));
    const symbols = async () => body(await client.callTool({ name: 'wincode_find_code_symbol', arguments: { query: 'Gone' } }));
    assert.match((await pack()).packedContent, /OLD_VALUE/);
    assert.equal((await symbols()).totalFound, 1);
    // Same length and restored mtime make stat-only validation insufficient too.
    const stat = await fs.stat(file);
    await fs.writeFile(file, 'public class Live { string Value = "NEW_VALUE"; }');
    await fs.utimes(file, stat.atime, stat.mtime);
    const updated = await pack();
    assert.match(updated.packedContent, /NEW_VALUE/);
    assert.doesNotMatch(updated.packedContent, /OLD_VALUE/);
    assert.equal(updated.queryComplete, true);
    assert.equal((await symbols()).totalFound, 0);
    assert.equal((await pack()).metrics.fromCache, true, 'unchanged actual inputs still reuse the pack');
    await fs.writeFile(path.join(root, 'Added.cs'), 'class Gone {}');
    assert.equal((await symbols()).totalFound, 1, 'new files must join the scan');
    await fs.unlink(path.join(root, 'Added.cs'));
    assert.equal((await symbols()).totalFound, 0, 'deleted files must leave the scan');
  }));
}

it('cached references disappear after their file changes, while declaration parsing shares the existing byte budget', async () => fixture(async (router, root) => {
  const file = path.join(root, 'Caller.cs');
  await fs.writeFile(file, 'class Caller { void Run() { Gone(); } }');
  assert.equal((await router.text.findReferencesDetailed('Gone')).totalReferences, 1);
  await fs.writeFile(file, 'class Caller { void Run() { Live(); } }');
  assert.equal((await router.text.findReferencesDetailed('Gone')).totalReferences, 0);
  const cache = new CacheManager(path.join(root, 'limited'), 2, 2, { maxMemoryBytes: 256, maxEntryBytes: 256 });
  let parses = 0;
  const parse = () => { parses++; return ['Caller']; };
  cache.memoizeContent('file', 'old', parse); cache.memoizeContent('file', 'old', parse);
  assert.equal(parses, 1);
  cache.memoizeContent('file', 'new', parse);
  assert.equal(parses, 2);
  for (let i = 0; i < 20; i++) cache.memoizeContent(String(i), 'input', () => ['x'.repeat(30)]);
  assert.ok(cache.memoryEntryCount <= 2); assert.ok(cache.estimatedMemoryBytes <= 256);
}));

it('peer eviction causes recomputation for both memory and disk hits with missing overflow', async () => fixture(async (router, root) => {
  await fs.writeFile(path.join(root, 'Large.cs'), 'class Large {}\n' + '// evidence\n'.repeat(2000));
  const cache = new CacheManager(router.config.cacheDir, 20, 1, { maxEntryBytes: 8192 });
  const peer = new CacheManager(router.config.cacheDir, 20, 1, { maxEntryBytes: 8192 });
  await cache.initialize(); await peer.initialize();
  const adapter = new RepomixAdapter(router.config, cache);
  const options = { candidateFiles: ['Large.cs'] };
  try {
    const first = await adapter.packWorkspace(options);
    assert.equal(first.contentOmitted, true); assert.ok(first.overflowPath);
    await peer.set('newer', { marker: 'peer' }); await peer.pruneDiskCache();
    await assert.rejects(fs.stat(first.overflowPath), { code: 'ENOENT' });
    const second = await adapter.packWorkspace(options);
    assert.equal(second.fromCache, false); assert.ok(second.overflowPath);
    assert.match(await fs.readFile(second.overflowPath, 'utf8'), /class Large/);
    // Persisted metadata alone must not be accepted by a new process-equivalent manager either.
    await fs.unlink(second.overflowPath);
    const cold = new RepomixAdapter(router.config, new CacheManager(router.config.cacheDir, 20, 1, { maxEntryBytes: 8192 }));
    try {
      const third = await cold.packWorkspace(options);
      assert.equal(third.fromCache, false); assert.ok(third.overflowPath);
      assert.match(await fs.readFile(third.overflowPath, 'utf8'), /class Large/);
    } finally { await cold.dispose(); }
  } finally { await adapter.dispose(); await cache.flush(); await peer.flush(); }
}));

it('cancelling same-root metadata confirmation leaves the healthy session usable', async () => fixture(async (router, root) => {
  const original = router.workspace.openWorkspace.bind(router.workspace);
  const entered = deferred(), finish = deferred(), controller = new AbortController();
  const session = router.session.current?.id, namespace = router.cache.currentNamespace;
  router.workspace.openWorkspace = async (...args) => { const result = await original(...args); entered.resolve(); await finish.promise; return result; };
  const pending = router.openWorkspace(root, {}, controller.signal);
  const cancelled = assert.rejects(pending, { name: 'AbortError' });
  try {
    await entered.promise; controller.abort(); finish.resolve(); await cancelled;
    assert.equal(router.workspaceRecoveryState, null);
    assert.equal(router.session.current?.id, session); assert.equal(router.cache.currentNamespace, namespace);
    await router.acquireRequestSlot(); router.endRequest();
  } finally { finish.resolve(); router.workspace.openWorkspace = original; }
}));

it('two real processes recover after peer eviction without returning a dangling cache hit', async () => fixture(async (_router, root) => {
  await fs.writeFile(path.join(root, 'Large.cs'), 'class Large {}\n' + '// evidence\n'.repeat(2000));
  const children: ChildProcess[] = [];
  const peers: Array<{ request: (operation: string) => Promise<any> }> = [];
  const start = async () => {
    const child = fork(path.resolve('tests/fixtures/cache-peer.mjs'), [root], {
      execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    children.push(child);
    let sequence = 0;
    const pending = new Map<number, { resolve: (data: unknown) => void; reject: (error: Error) => void }>();
    child.on('message', (message: any) => {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error)); else waiter.resolve(message.result);
    });
    child.on('exit', () => { for (const waiter of pending.values()) waiter.reject(new Error('Cache peer exited')); pending.clear(); });
    assert.equal((await once(child, 'message'))[0].ready, true);
    const peer = { request: (operation: string) => new Promise<any>((resolve, reject) => {
      const id = ++sequence; pending.set(id, { resolve, reject }); child.send({ id, operation });
    }) };
    peers.push(peer); return peer;
  };
  try {
    const a = await start(), b = await start();
    const first = await a.request('pack');
    assert.equal(first.backingFileExists, true);
    await b.request('prune');
    await assert.rejects(fs.stat(first.overflowPath), { code: 'ENOENT' });
    const second = await a.request('pack');
    assert.equal(second.fromCache, false); assert.equal(second.backingFileExists, true);
    assert.notEqual(second.overflowPath, first.overflowPath);
    assert.equal((await a.request('pack')).fromCache, true);
  } finally {
    for (const peer of peers) await peer.request('close');
    for (const child of children) if (child.exitCode === null) await once(child, 'exit');
  }
}));

it('same-root confirmation and heartbeat finish while an earlier business query remains blocked', async () => fixture(async (router, root, client) => {
  const entered = deferred(), finish = deferred();
  const original = router.text.findSymbolsDetailed.bind(router.text);
  router.text.findSymbolsDetailed = async (...args) => { entered.resolve(); await finish.promise; return original(...args); };
  const query = client.callTool({ name: 'wincode_find_code_symbol', arguments: { query: 'Target' } });
  try {
    await entered.promise;
    const results = await Promise.all([
      client.callTool({ name: 'workspace_open', arguments: { path: root } }),
      client.callTool({ name: 'wincode_hello_world', arguments: {} }),
    ]);
    for (const result of results) assert.notEqual(result.isError, true);
    assert.equal(router.inFlightRequests, 1, 'slow query is still active, rather than secretly drained/cancelled');
    assert.equal(router.workspaceRecoveryState, null);
  } finally { finish.resolve(); await query; router.text.findSymbolsDetailed = original; }
}));
