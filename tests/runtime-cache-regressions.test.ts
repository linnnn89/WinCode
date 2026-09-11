import { it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { getDefaultConfig } from '../src/Core/Config.js';
import { CacheManager } from '../src/Core/Cache.js';
import { RepomixAdapter } from '../src/Adapters/RepomixAdapter.js';
import { ToolRouter } from '../src/Core/ToolRouter.js';
import { WinCodeMcpServer } from '../src/Gateway/McpServer.js';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const body = (result: any) => result.structuredContent ?? JSON.parse(result.content[0].text);

async function cacheStateFixture(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-cache-state-'));
  try { await run(root); } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('wincode-cache-state-'));
    await fs.rm(root, { recursive: true, force: true });
  }
}

// Pause after the real file has been read and closed, so Windows can replace it.
function pauseCacheFileRead(t: TestContext, file: string) {
  const entered = deferred(), release = deferred();
  const open = fs.open.bind(fs);
  let paused = false;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (!paused && String(args[0]) === file && args[1] === 'r') {
      paused = true;
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); entered.resolve(); await release.promise; };
    }
    return handle;
  });
  return { entered: entered.promise, release: release.resolve };
}

for (const change of ['replacement', 'eviction', 'clear', 'namespace-reset']) {
  it(`cache state: an awaiting memory hit cannot undo ${change}`, async () => cacheStateFixture(async root => {
    const cache = new CacheManager(root, 1);
    await cache.set('key', 'old');
    const reading = cache.get('key');
    if (change === 'replacement') await cache.set('key', 'new');
    else if (change === 'eviction') await cache.set('other', 'B');
    else if (change === 'clear') await cache.clear();
    else cache.setNamespace(path.join(root, 'workspace'));
    assert.equal(await reading, null, 'an invalidated read must become a miss');
    assert.equal(cache.memoryEntryCount, change === 'replacement' || change === 'eviction' ? 1 : 0);
    assert.equal(cache.estimatedMemoryBytes, change === 'replacement' ? 6 : change === 'eviction' ? 2 : 0);
    if (change === 'replacement') {
      assert.equal(await cache.get('key'), 'new');
      assert.equal(await new CacheManager(root).get('key'), 'new');
    } else if (change === 'eviction') assert.equal(await cache.get('other'), 'B');
    else assert.equal(await cache.get('key'), null);
  }));
}

for (const change of ['replacement', 'clear', 'namespace-roundtrip', 'rebind']) {
  it(`cache state: a suspended disk read cannot undo ${change}`, { timeout: 10000 }, async t => cacheStateFixture(async root => {
    const writer = new CacheManager(root), reader = new CacheManager(root);
    writer.setNamespace(root); reader.setNamespace(root);
    await writer.set('key', 'old');
    const file = path.join(root, (await fs.readdir(root)).find(name => name.endsWith('.json'))!);
    const pause = pauseCacheFileRead(t, file);
    const reading = reader.get('key');
    try {
      await pause.entered;
      if (change === 'replacement') await reader.set('key', 'new');
      else if (change === 'clear') await reader.clear();
      else if (change === 'rebind') await reader.rebind(path.join(root, 'rebound'));
      else { reader.setNamespace(path.join(root, 'other')); reader.setNamespace(root); }
    } finally { pause.release(); }
    assert.equal(await reading, null, 'previous directory/namespace/value must not be hydrated');
    assert.equal(reader.memoryEntryCount, change === 'replacement' ? 1 : 0);
    assert.equal(reader.estimatedMemoryBytes, change === 'replacement' ? 6 : 0);
    const expected = change === 'replacement' ? 'new' : change === 'namespace-roundtrip' ? 'old' : null;
    assert.equal(await reader.get('key'), expected, 'later valid reads still work');
  }));
}

it('cache state: failed backing validation cannot delete a replacement in memory', { timeout: 10000 }, async t => cacheStateFixture(async root => {
  const cache = new CacheManager(root);
  const overflowPath = await cache.writeOverflow('old');
  await cache.set('key', { overflowPath });
  await fs.writeFile(overflowPath, 'bad');
  const pause = pauseCacheFileRead(t, overflowPath);
  const reading = cache.get('key');
  try { await pause.entered; await cache.set('key', 'new'); }
  finally { pause.release(); }
  assert.equal(await reading, null);
  assert.equal(cache.memoryEntryCount, 1);
  assert.equal(cache.estimatedMemoryBytes, 6);
  assert.equal(await cache.get('key'), 'new');
}));

it('cache state: an earlier failed backing write cannot delete a later accepted value', { timeout: 10000 }, async t => cacheStateFixture(async root => {
  const cache = new CacheManager(root);
  const overflowPath = await cache.writeOverflow('old');
  await fs.unlink(overflowPath);
  const entered = deferred(), release = deferred(), lstat = fs.lstat.bind(fs);
  let paused = false;
  t.mock.method(fs, 'lstat', async (...args: Parameters<typeof fs.lstat>) => {
    if (!paused && String(args[0]) === overflowPath) { paused = true; entered.resolve(); await release.promise; }
    return lstat(...args);
  });
  const first = cache.set('key', { overflowPath });
  let second: Promise<void> | undefined;
  try { await entered.promise; second = cache.set('key', 'new'); }
  finally { release.resolve(); }
  await Promise.all([first, second]);
  assert.equal(cache.memoryEntryCount, 1);
  assert.equal(cache.estimatedMemoryBytes, 6);
  assert.equal(await cache.get('key'), 'new');
  assert.equal(await new CacheManager(root).get('key'), 'new');
}));

it('cache state: expiration of a suspended disk read cannot unlink a newer write', { timeout: 10000 }, async t => cacheStateFixture(async root => {
  const writer = new CacheManager(root), reader = new CacheManager(root);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  await writer.set('key', 'old', { ttlMs: 10 });
  now += 20;
  const file = path.join(root, (await fs.readdir(root)).find(name => name.endsWith('.json'))!);
  const pause = pauseCacheFileRead(t, file), reading = reader.get('key');
  try { await pause.entered; await reader.set('key', 'new'); }
  finally { pause.release(); }
  assert.equal(await reading, null);
  assert.equal(await reader.get('key'), 'new');
  assert.equal(await new CacheManager(root).get('key'), 'new', 'cleanup must preserve the replacement on disk');
}));

it('cache state: an obsolete oversized stat cannot unlink a newer write', { timeout: 10000 }, async t => cacheStateFixture(async root => {
  const cache = new CacheManager(root, 5, 5, { maxEntryBytes: 1024 });
  await cache.set('key', 'old');
  const file = path.join(root, (await fs.readdir(root)).find(name => name.endsWith('.json'))!);
  await fs.appendFile(file, ' '.repeat(2048));
  const reader = new CacheManager(root, 5, 5, { maxEntryBytes: 1024 });
  const entered = deferred(), release = deferred(), lstat = fs.lstat.bind(fs);
  let paused = false;
  t.mock.method(fs, 'lstat', async (...args: Parameters<typeof fs.lstat>) => {
    const stat = await lstat(...args);
    if (!paused && String(args[0]) === file) { paused = true; entered.resolve(); await release.promise; }
    return stat;
  });
  const reading = reader.get('key');
  try { await entered.promise; await reader.set('key', 'new'); }
  finally { release.resolve(); }
  assert.equal(await reading, null);
  assert.equal(await new CacheManager(root).get('key'), 'new', 'cleanup must preserve the replacement on disk');
}));

for (const change of ['clear', 'disk-only-write']) {
  it(`cache state: disk reads drain an already accepted ${change}`, async t => cacheStateFixture(async root => {
    const cache = new CacheManager(root, 5, 5, { maxMemoryBytes: 0 });
    await cache.set('key', 'old');
    const release = deferred();
    // Hold the existing writer queue, as in the accepted-write/clear lifecycle regression.
    (cache as any).writeChain = release.promise;
    const lstat = fs.lstat.bind(fs);
    let filesystemReads = 0;
    t.mock.method(fs, 'lstat', (...args: Parameters<typeof fs.lstat>) => { filesystemReads++; return lstat(...args); });
    const writing = change === 'clear' ? cache.clear() : cache.set('key', 'new');
    const reading = cache.get('key');
    let prematureReads: number;
    try {
      await Promise.resolve(); await Promise.resolve();
      prematureReads = filesystemReads;
    } finally { release.resolve(); }
    const [, result] = await Promise.all([writing, reading]);
    assert.equal(prematureReads, 0, 'disk reads must not bypass the accepted writer queue');
    assert.equal(result, change === 'clear' ? null : 'new');
    assert.equal(cache.memoryEntryCount, 0);
    assert.equal(cache.estimatedMemoryBytes, 0);
  }));
}

it('cache state: parallel valid hits still return data and respect the shared LRU budget', async () => cacheStateFixture(async root => {
  const writer = new CacheManager(root), reader = new CacheManager(root, 1, 20, { maxMemoryBytes: 4 });
  await writer.set('a', 'A'); await writer.set('b', 'BB');
  assert.deepEqual(await Promise.all([reader.get('a'), reader.get('b')]), ['A', 'BB']);
  assert.equal(reader.memoryEntryCount, 1);
  assert.ok(reader.estimatedMemoryBytes === 2 || reader.estimatedMemoryBytes === 4);
  await reader.set('a', 'A');
  assert.deepEqual(await Promise.all([reader.get('a'), reader.get('a')]), ['A', 'A']);
  assert.equal(reader.memoryEntryCount, 1);
  assert.equal(reader.estimatedMemoryBytes, 2);
}));

it('process observation excludes stale parent PID edges without hiding real descendants', async () => {
  const { selectOwnedProcesses } = await import(pathToFileURL(path.resolve('scripts/lib/owned-processes.mjs')).href);
  const proc = (ProcessId: number, ParentProcessId: number, time: number) => ({ ProcessId, ParentProcessId, CreationDate: `/Date(${time})/` });
  const rows = [proc(752, 744, 100), proc(876, 744, 101), proc(972, 876, 102),
    proc(2648, 7864, 1000), proc(5696, 2648, 1100), proc(7640, 5696, 1200),
    proc(744, 7640, 1300), proc(7020, 7640, 1301)];
  assert.deepEqual(selectOwnedProcesses(rows, 2648).map((item: any) => item.ProcessId), [2648, 5696, 7640, 744, 7020]);
  assert.deepEqual(selectOwnedProcesses(rows, 9999), []);
  assert.throws(() => selectOwnedProcesses([...rows, { ProcessId: 777, ParentProcessId: 744 }], 2648), /Missing process creation identity/);
});

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

for (const layer of ['memory', 'disk']) it(`corrupted overflow is rebuilt before a ${layer} cache hit even when size and mtime match`, async () => fixture(async (router, root) => {
  await fs.writeFile(path.join(root, 'Large.cs'), 'class Large {}\n' + '// evidence\n'.repeat(2000));
  const cache = new CacheManager(router.config.cacheDir, 20, 20, { maxEntryBytes: 8192 });
  const adapter = new RepomixAdapter(router.config, cache);
  const options = { candidateFiles: ['Large.cs'] };
  let reader = adapter;
  try {
    const first = await adapter.packWorkspace(options);
    assert.ok(first.overflowPath); assert.equal((await adapter.packWorkspace(options)).fromCache, true);
    const before = await fs.stat(first.overflowPath);
    const content = await fs.readFile(first.overflowPath, 'utf8');
    await fs.writeFile(first.overflowPath, content.replace('class Large', 'class Wrong'));
    await fs.utimes(first.overflowPath, before.atime, before.mtime);
    assert.equal((await fs.stat(first.overflowPath)).size, before.size);
    if (layer === 'disk') reader = new RepomixAdapter(router.config,
      new CacheManager(router.config.cacheDir, 20, 20, { maxEntryBytes: 8192 }));
    const repaired = await reader.packWorkspace(options);
    assert.equal(repaired.fromCache, false, 'existing corrupted file cannot count as a valid cache hit');
    assert.ok(repaired.overflowPath);
    assert.notEqual(repaired.overflowPath, first.overflowPath);
    assert.equal(await fs.readFile(repaired.overflowPath, 'utf8'), content);
  } finally { if (reader !== adapter) await reader.dispose(); await adapter.dispose(); await cache.flush(); }
}));

for (const damage of ['changed-body', 'other-key']) it(`disk cache rejects valid JSON with ${damage} before exposing its data`, async () => fixture(async (router) => {
  const cache = new CacheManager(router.config.cacheDir);
  const reader = new CacheManager(router.config.cacheDir);
  await cache.set('wanted', { source: 'A' }, { fingerprint: 'same' });
  await cache.set('other', { source: 'B' }, { fingerprint: 'same' });
  const files = (await fs.readdir(cache.directory)).filter(file => file.endsWith('.json'));
  const records = await Promise.all(files.map(async file => ({ file: path.join(cache.directory, file),
    entry: JSON.parse(await fs.readFile(path.join(cache.directory, file), 'utf8')) })));
  const wanted = records.find(record => record.entry.data?.source === 'A')!;
  const other = records.find(record => record.entry.data?.source === 'B')!;
  if (damage === 'changed-body') { wanted.entry.data.source = 'B'; await fs.writeFile(wanted.file, JSON.stringify(wanted.entry)); }
  else await fs.copyFile(other.file, wanted.file);
  assert.equal(await reader.get('wanted', 'same'), null, 'readers must return a miss instead of another payload');
  assert.deepEqual(await reader.get('other', 'same'), { source: 'B' });
}));

it('a cache file growing after the opened-handle size check stays within its original read budget', async t => fixture(async router => {
  const cache = new CacheManager(router.config.cacheDir, 20, 20, { maxEntryBytes: 1024 });
  await cache.set('growing', { source: 'A' });
  const name = (await fs.readdir(cache.directory)).find(file => file.endsWith('.json'))!;
  const file = path.join(cache.directory, name), size = (await fs.stat(file)).size;
  const originalOpen = fs.open.bind(fs);
  let totalRead = 0, changed = false;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (args[0] === file) {
      const stat = handle.stat.bind(handle), read = handle.read.bind(handle);
      t.mock.method(handle, 'stat', async () => {
        const result = await stat();
        if (!changed) { changed = true; await fs.appendFile(file, ' '.repeat(8192)); }
        return result;
      });
      t.mock.method(handle, 'read', async (...readArgs: any[]) => {
        const result = await (read as any)(...readArgs); totalRead += result.bytesRead; return result;
      });
    }
    return handle;
  });
  assert.equal(await new CacheManager(cache.directory, 20, 20, { maxEntryBytes: 1024 }).get('growing'), null);
  assert.equal(changed, true); assert.ok(totalRead <= size + 1, `${totalRead} bytes read for original size ${size}`);
}));

for (const kind of ['inline', 'overflow']) it(`legacy ${kind} cache without integrity metadata is rebuilt and then reusable`, async () => fixture(async (router, root) => {
  await fs.writeFile(path.join(root, 'Legacy.cs'), 'class Legacy {}\n' + (kind === 'overflow' ? '// evidence\n'.repeat(2000) : ''));
  const cache = new CacheManager(router.config.cacheDir, 20, 20, { maxEntryBytes: 8192 });
  const adapter = new RepomixAdapter(router.config, cache);
  const reader = new RepomixAdapter(router.config,
    new CacheManager(router.config.cacheDir, 20, 20, { maxEntryBytes: 8192 }));
  const options = { candidateFiles: ['Legacy.cs'] };
  try {
    const original = await adapter.packWorkspace(options);
    assert.equal(Boolean(original.overflowPath), kind === 'overflow');
    const names = (await fs.readdir(cache.directory)).filter(name => name.endsWith('.json'));
    assert.equal(names.length, 1);
    const file = path.join(cache.directory, names[0]);
    const entry = JSON.parse(await fs.readFile(file, 'utf8'));
    delete entry.integrity; delete entry.backingFile;
    await fs.writeFile(file, JSON.stringify(entry));
    const rebuilt = await reader.packWorkspace(options);
    assert.equal(rebuilt.fromCache, false, 'legacy metadata must not establish a verified cache hit');
    if (kind === 'overflow') {
      assert.ok(original.overflowPath && rebuilt.overflowPath);
      assert.notEqual(rebuilt.overflowPath, original.overflowPath);
      assert.equal(await fs.readFile(rebuilt.overflowPath, 'utf8'), await fs.readFile(original.overflowPath, 'utf8'));
    } else assert.equal(rebuilt.content, original.content);
    assert.equal((await reader.packWorkspace(options)).fromCache, true, 'rebuilt data must remain cacheable');
  } finally { await reader.dispose(); await adapter.dispose(); await cache.flush(); }
}));

it('cache JSON growing after the path size check cannot exceed the entry budget and become a hit', async t => fixture(async router => {
  const cache = new CacheManager(router.config.cacheDir, 20, 20, { maxEntryBytes: 1024 });
  await cache.set('path-growth', { source: 'A' });
  const name = (await fs.readdir(cache.directory)).find(file => file.endsWith('.json'))!;
  const file = path.join(cache.directory, name), originalStat = fs.lstat.bind(fs);
  let changed = false;
  t.mock.method(fs, 'lstat', async (...args: Parameters<typeof fs.lstat>) => {
    const stat = await originalStat(...args);
    if (args[0] === file && !changed) {
      changed = true;
      // Legal trailing JSON whitespace keeps payload integrity unchanged while violating the read budget.
      await fs.appendFile(file, ' '.repeat(8192));
    }
    return stat;
  });
  assert.equal(await new CacheManager(cache.directory, 20, 20, { maxEntryBytes: 1024 }).get('path-growth'), null);
  assert.equal(changed, true, 'the growth must occur between observation and read');
  assert.ok((await fs.stat(file)).size > 1024);
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
