import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CacheManager } from '../src/Core/Cache.js';
import { ToolRouter } from '../src/Core/ToolRouter.js';
import { getDefaultConfig } from '../src/Core/Config.js';
import { WorkspaceManager } from '../src/Core/Workspace.js';
import { ArchitectureAnalyzer } from '../src/CompositeTools/ArchitectureAnalyzer.js';

it('workspace browsing skips verified local SDKs with reasons but preserves ordinary .dotnet sources', async () => isolated(async root => {
  const workspace = new WorkspaceManager(getDefaultConfig(root));
  const sdk = path.join(root, '.dotnet');
  await fs.mkdir(path.join(sdk, 'sdk'), { recursive: true });
  await fs.mkdir(path.join(sdk, 'host'));
  await fs.writeFile(path.join(sdk, 'dotnet.exe'), 'marker');
  await fs.writeFile(path.join(sdk, 'sdk', 'large.bin'), 'x'.repeat(5000));
  await fs.writeFile(path.join(root, 'source.cs'), 'code');
  const identity = await workspace.identifyProject();
  const tree = await workspace.getDirectoryTree();
  const metadata = await workspace.getMetadata(identity);
  assert.ok(!tree.children?.some(item => item.name === '.dotnet'));
  assert.deepEqual(tree.omittedDirectories, [{ path: '.dotnet', reason: 'local-dotnet-sdk' }]);
  assert.deepEqual(metadata.omittedDirectories, tree.omittedDirectories);
  assert.equal(metadata.totalFiles, 1);
  assert.equal(metadata.totalSizeBytes, 4);
  await fs.unlink(path.join(sdk, 'dotnet.exe'));
  await fs.writeFile(path.join(sdk, 'ordinary.cs'), 'source');
  const visible = await workspace.getDirectoryTree();
  assert.ok(visible.children?.some(item => item.name === '.dotnet'));
  assert.equal((await workspace.getMetadata(identity)).totalFiles, 3);
}));

it('project summaries use WPF build declarations despite an unrelated directory name', async () => isolated(async root => {
  await fs.mkdir(path.join(root, 'ArbitraryName'));
  await fs.writeFile(path.join(root, 'ArbitraryName', 'Example.csproj'),
    '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><UseWPF>true</UseWPF><OutputType>WinExe</OutputType><TargetFramework>net10.0-windows</TargetFramework></PropertyGroup></Project>');
  const workspace = new WorkspaceManager(getDefaultConfig(root));
  const report = await new ArchitectureAnalyzer(workspace).analyze();
  assert.equal(report.projectSummaries[0].kind, 'WPF executable');
  assert.equal(report.projectSummaries[0].file, 'ArbitraryName/Example.csproj');
  assert.ok(report.projectSummaries[0].evidence.includes('UseWPF=true'));
  assert.ok(report.recommendedAgentFocus.includes('not an architecture judgment'));
}));

it('workspace metadata failure restores root and trash paths before rejecting', async () => isolated(async root => {
  const config = getDefaultConfig(root);
  const previousTrash = config.trashDir;
  const workspace = new WorkspaceManager(config);
  const next = path.join(root, 'next');
  await fs.mkdir(next);
  (workspace as any).discoverProject = async () => { throw new Error('simulated read failure'); };
  await assert.rejects(workspace.openWorkspace(next), /simulated read failure/);
  assert.equal(config.workspaceRoot, root);
  assert.equal(config.trashDir, previousTrash);
}));

it('oversized cache replacement invalidates both the previous memory and disk value', async () => isolated(async root => {
  const cache = new CacheManager(root, 5, 5, { maxEntryBytes: 256 });
  await cache.initialize();
  await cache.set('same', 'old');
  await cache.set('same', 'x'.repeat(500));
  assert.equal(await cache.get('same'), null);
  const reopened = new CacheManager(root, 5, 5, { maxEntryBytes: 256 });
  assert.equal(await reopened.get('same'), null);
}));

it('heap quota remains valid when a single entry exceeds total memory or disk metadata lies', async () => isolated(async root => {
  const cache = new CacheManager(root, 5, 5, { maxMemoryBytes: 20, maxEntryBytes: 2048 });
  await cache.initialize();
  await cache.set('large', 'old');
  await cache.set('large', 'x'.repeat(80));
  assert.equal(cache.memoryEntryCount, 0);
  const json = (await fs.readdir(root)).find(file => file.endsWith('.json'))!;
  const entry = JSON.parse(await fs.readFile(path.join(root, json), 'utf8'));
  entry.byteSize = -100000;
  await fs.writeFile(path.join(root, json), JSON.stringify(entry));
  assert.equal(await cache.get('large'), 'x'.repeat(80));
  assert.equal(cache.memoryEntryCount, 0);
  assert.equal(cache.estimatedMemoryBytes, 0);
}));

it('clear is ordered after already accepted writes so old values cannot reappear', async () => isolated(async root => {
  const cache = new CacheManager(root);
  await cache.initialize();
  let release!: () => void;
  (cache as any).writeChain = new Promise<void>(resolve => { release = resolve; });
  const writing = cache.set('old', 'value');
  const clearing = cache.clear();
  release();
  await Promise.all([writing, clearing]);
  assert.equal(await cache.get('old'), null);
  assert.equal((await fs.readdir(root)).filter(file => file.endsWith('.json')).length, 0);
}));

it('shutdown attempts every owner and flushes cache even when an adapter throws', async () => isolated(async root => {
  const router = new ToolRouter(getDefaultConfig(root));
  const calls: string[] = [];
  router.repomix.dispose = async () => { calls.push('repomix'); throw new Error('simulated cleanup failure'); };
  router.text.dispose = async () => { calls.push('text'); };
  router.flaui.dispose = async () => { calls.push('flaui'); };
  router.extensions.disposeAll = async () => { calls.push('extensions'); };
  router.cache.flush = async () => { calls.push('cache'); };
  router.resources.register('disposable', 'test', () => { calls.push('resources'); });
  await assert.rejects(router.dispose(), AggregateError);
  await assert.rejects(router.dispose(), AggregateError);
  assert.deepEqual(calls, ['repomix', 'text', 'flaui', 'extensions', 'cache', 'resources']);
  assert.equal(router.resources.isDisposed, true);
}));

async function isolated(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-cleanup-'));
  try { await run(root); } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('wincode-cleanup-'));
    await fs.rm(root, { recursive: true, force: true });
  }
}

it('capacity eviction invalidates the memory snapshot as well as its file', async () => isolated(async root => {
  const cache = new CacheManager(root, 50, 50, { maxDiskBytes: 1000 });
  await cache.initialize();
  await fs.mkdir(path.join(root, 'overflow'));
  const snapshot = path.join(root, 'overflow', 'pack.txt');
  await fs.writeFile(snapshot, 'x'.repeat(2000));
  await cache.set('pack', { overflowPath: snapshot });
  await cache.pruneDiskCache();
  assert.equal(await cache.get('pack'), null);
  assert.equal(cache.memoryEntryCount, 0);
  await assert.rejects(fs.stat(snapshot), { code: 'ENOENT' });
}));

it('capacity and TTL cleanup preserve paths outside overflow', async () => isolated(async root => {
  const asset = path.join(root, 'asset.txt');
  await fs.writeFile(asset, 'preserve');
  for (const mode of ['capacity', 'ttl']) {
    const dir = path.join(root, mode);
    const cache = new CacheManager(dir, 50, 50, { maxDiskBytes: mode === 'capacity' ? 1 : 10000 });
    await cache.initialize();
    await cache.set('pack', { overflowPath: asset }, mode === 'ttl' ? { ttlMs: 1 } : undefined);
    if (mode === 'ttl') {
      await new Promise(resolve => setTimeout(resolve, 10));
      // Fresh reader exercises disk get's expiration path.
      assert.equal(await new CacheManager(dir).get('pack'), null);
    } else await cache.pruneDiskCache();
    assert.equal(await fs.readFile(asset, 'utf8'), 'preserve');
  }
}));

it('cleanup does not follow an overflow directory junction', async () => isolated(async root => {
  const dir = path.join(root, 'cache');
  const outside = path.join(root, 'assets');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'asset.txt'), 'preserve');
  const cache = new CacheManager(dir, 50, 50, { maxDiskBytes: 1 });
  await cache.initialize();
  const link = path.join(dir, 'overflow');
  await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    await cache.set('pack', { overflowPath: path.join(link, 'asset.txt') });
    await cache.pruneDiskCache({ orphanGraceMs: 0 });
    assert.equal(await fs.readFile(path.join(outside, 'asset.txt'), 'utf8'), 'preserve');
  } finally { await fs.unlink(link); }
}));

it('shutdown waits for the active switch and rejects its queued queries', async () => isolated(async root => {
  const router = new ToolRouter(getDefaultConfig(root));
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const events: string[] = [];
  router.workspace.openWorkspace = async () => { entered(); await blocked; return {} as any; };
  router.cache.computeWorkspaceFingerprint = async () => 'fixture';
  router.repomix.dispose = async () => { events.push('dispose'); };
  router.repomix.initialize = async () => { events.push('initialize'); };
  router.text.initialize = async () => {};
  const switching = router.openWorkspace(root);
  await started;
  const rejected = assert.rejects(router.acquireRequestSlot(), /shutting down/);
  const shutdown = router.dispose();
  assert.deepEqual(events, []);
  release();
  await Promise.all([switching, shutdown, rejected]);
  assert.deepEqual(events, ['dispose', 'initialize', 'dispose']);
  assert.equal(router.inFlightRequests, 0);
  assert.equal(router.resources.isDisposed, true);
  await assert.rejects(router.acquireRequestSlot(), /shutting down/);
}));
