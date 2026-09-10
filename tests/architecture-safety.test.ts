import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { WorkspaceManager } from '../src/Core/Workspace.js';
import { WorkspaceFingerprint } from '../src/Core/WorkspaceFingerprint.js';
import { CacheManager } from '../src/Core/Cache.js';
import { getDefaultConfig } from '../src/Core/Config.js';
import { ArchitectureAnalyzer } from '../src/CompositeTools/ArchitectureAnalyzer.js';
import { loadDotNetProjectGraph } from '../src/Core/DotNetGraph.js';
import { ToolRouter } from '../src/Core/ToolRouter.js';
import { WinCodeMcpServer } from '../src/Gateway/McpServer.js';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

async function fixture(run: (root: string) => Promise<void>) {
  const parent = path.resolve('test-tmp');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'architecture-safety-'));
  try { await run(root); }
  finally {
    const relative = path.relative(await fs.realpath(parent), await fs.realpath(root));
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
}

it('workspace Git probes never execute a repository-local git.cmd', { skip: process.platform !== 'win32' }, async () => fixture(async root => {
  await fs.mkdir(path.join(root, '.git'));
  const marker = path.join(root, 'executed.txt');
  await fs.writeFile(path.join(root, 'git.cmd'), '@echo off\r\n>>"%~dp0executed.txt" echo UNSAFE\r\nexit /b 0\r\n');
  await new WorkspaceManager(getDefaultConfig(root)).getGitStatus();
  await new WorkspaceFingerprint(0).computeWorkspaceFingerprint(root);
  assert.equal(await fs.stat(marker).then(() => true, () => false), false);
}));

it('cache initialization rejects a junction before touching unrelated files', async () => fixture(async root => {
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  const marker = path.join(outside, 'ordinary-unrelated.json');
  await fs.writeFile(marker, 'not a cache');
  const cacheDir = path.join(root, 'cache');
  await fs.symlink(outside, cacheDir, process.platform === 'win32' ? 'junction' : 'dir');
  const failure = await new CacheManager(cacheDir).initialize().then(() => null, error => error);
  assert.equal(await fs.readFile(marker, 'utf8').catch(() => 'MISSING'), 'not a cache');
  assert.ok(failure, 'an unsafe configured cache must not initialize successfully');
}));

it('cache pruning and clearing preserve unowned JSON, temporary and overflow files', async () => fixture(async root => {
  const cache = new CacheManager(root, 4, 0);
  await cache.initialize();
  await fs.mkdir(path.join(root, 'overflow'));
  const files = ['unrelated.json', 'unrelated.tmp.1', 'overflow/unrelated.txt', 'wincode-v1_unowned_0123456789abcdef.json'];
  for (const file of files) {
    await fs.writeFile(path.join(root, file), 'ordinary content');
    await fs.utimes(path.join(root, file), new Date(0), new Date(0));
  }
  await cache.set('own', 'value');
  await cache.pruneDiskCache({ orphanGraceMs: 0 });
  await cache.clear();
  for (const file of files) assert.equal(await fs.readFile(path.join(root, file), 'utf8').catch(() => 'MISSING'), 'ordinary content');
}));

it('cache mutations reject a replaced root and an overflow junction', async () => fixture(async root => {
  const cacheDir = path.join(root, 'cache'), outside = path.join(root, 'outside');
  const cache = new CacheManager(cacheDir);
  await cache.initialize();
  await cache.set('entry', 'owned');
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(cacheDir, 'overflow'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(cache.writeOverflow('never outside'), /link|junction/i);
  assert.deepEqual(await fs.readdir(outside), []);
  // Both paths are verified generated children of the fixture before the move.
  const moved = path.join(root, 'old-cache');
  assert.equal(path.dirname(await fs.realpath(cacheDir)), await fs.realpath(root));
  assert.equal(path.dirname(moved), root);
  await fs.rename(cacheDir, moved);
  await fs.mkdir(cacheDir);
  await fs.writeFile(path.join(cacheDir, 'keep.json'), 'preserve replacement');
  await assert.rejects(cache.pruneDiskCache(), /identity changed/);
  await assert.rejects(cache.clear(), /identity changed/);
  assert.equal(await fs.readFile(path.join(cacheDir, 'keep.json'), 'utf8'), 'preserve replacement');
}));

it('declaration parsing and the real MCP heartbeat survive the blocking whitespace counterexample', async t => fixture(async root => {
  const stdout = execFileSync(process.execPath, ['--import', 'tsx', 'tests/fixtures/declaration-budget-probe.mjs', root],
    { encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 32768, stdio: 'pipe' });
  const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!);
  assert.deepEqual(result.samples.map((sample: any) => sample.size), [128, 2048, 16384, 65536]);
  assert.ok(result.heartbeatMs < 1000);
  t.diagnostic(JSON.stringify(result));
}));

it('architecture shares bounded streaming discovery and rejects depth values before scanning', async t => fixture(async root => {
  const workspace = new WorkspaceManager(getDefaultConfig(root));
  const analyzer = new ArchitectureAnalyzer(workspace);
  let reads = 0, closes = 0;
  t.mock.method(fs, 'opendir', async () => ({
    read: async () => { reads++; return { name: `source-${reads}.cs`, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }; },
    close: async () => { closes++; },
  }) as any);
  for (const depth of [-1, 0, 1.5, 6, Infinity, NaN]) await assert.rejects(analyzer.analyze(depth), /maxDepth/);
  assert.equal(reads, 0);
  const report = await analyzer.analyze();
  assert.equal(reads, 2500, 'discovery and directory view each stop at their declared entry cap');
  assert.equal(closes, 2);
  assert.equal(report.scanComplete, false);
  assert.ok(report.omissions.some(item => item.reason === 'entry-budget'));
  assert.ok(JSON.stringify(report).length <= 32768);
}));

it('project graph enforces descriptor and project budgets without reading oversized bodies', async () => fixture(async root => {
  const project = '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType></PropertyGroup></Project>';
  const files: string[] = [];
  for (let i = 0; i < 20; i++) { const name = `Project${i}.csproj`; files.push(name); await fs.writeFile(path.join(root, name), project); }
  const graph = await loadDotNetProjectGraph(root, [], files);
  assert.equal(graph.projects.length, 16);
  assert.equal(graph.scanComplete, false);
  assert.ok(graph.omissions.some(item => item.reason === 'project-budget'));
  await fs.writeFile(path.join(root, 'Large.csproj'), 'x'.repeat(65537));
  const large = await loadDotNetProjectGraph(root, [], ['Large.csproj']);
  assert.equal(large.descriptorBytesRead, 0);
  assert.equal(large.projects.length, 0);
  assert.ok(large.omissions.some(item => item.reason === 'descriptor-too-large'));
}));

it('MCP architecture cancellation retains ownership until a pending read finishes', async t => fixture(async root => {
  const config = getDefaultConfig(root); config.adapters.flaui.enabled = false; config.adapters.repomix.useCli = false;
  const router = new ToolRouter(config), server = new WinCodeMcpServer(router);
  const client = new Client({ name: 'architecture-cancel', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  let release!: () => void, entered!: () => void, closed = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entry = new Promise<void>(resolve => { entered = resolve; });
  t.mock.method(fs, 'opendir', async () => ({ read: async () => { entered(); await gate; return null; }, close: async () => { closed++; } }) as any);
  try {
    await Promise.all([client.connect(a), (server as any).server.connect(b)]);
    const controller = new AbortController();
    const call = client.callTool({ name: 'wincode_analyze_workspace', arguments: {} }, { signal: controller.signal }).catch(error => error);
    await entry; controller.abort(); await call;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((router as any).codeOperations.size, 1);
    const hello = await client.callTool({ name: 'wincode_hello_world', arguments: {} });
    assert.notEqual(hello.isError, true);
    release();
    for (let i = 0; i < 50 && (router as any).codeOperations.size; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal((router as any).codeOperations.size, 0);
    assert.equal(closed, 1);
    assert.equal((router as any).inFlight, 0);
  } finally { release(); await client.close(); await server.stop(); }
}));

it('the actual MCP architecture text, including formatting, stays within the report budget', async t => fixture(async root => {
  const config = getDefaultConfig(root); config.adapters.flaui.enabled = false; config.adapters.repomix.useCli = false;
  const router = new ToolRouter(config), server = new WinCodeMcpServer(router);
  const client = new Client({ name: 'architecture-output-budget', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(a), (server as any).server.connect(b)]);
    for (const count of [100, 128, 137, 160]) {
      const projects = Array.from({ length: count }, (_, i) => `P${i.toString().padStart(3, '0')}${'x'.repeat(170)}.csproj`);
      await fs.writeFile(path.join(root, 'Fixture.slnx'), `<Solution>${projects.map(file => `<Project Path="${file}" />`).join('')}</Solution>`);
      const response: any = await client.callTool({ name: 'wincode_analyze_workspace', arguments: {} });
      assert.notEqual(response.isError, true);
      const text = response.content[0].text;
      t.diagnostic(JSON.stringify({ count, textChars: text.length, compactChars: JSON.stringify(JSON.parse(text)).length }));
      assert.ok(text.length <= 32768, `${count} declarations returned ${text.length} characters`);
      assert.equal(JSON.parse(text).scanComplete, false, 'unreadable project bodies must remain incomplete');
    }
  } finally { await client.close(); await server.stop(); }
}));

it('trash rejects an external destination junction without moving the source', async () => fixture(async root => {
  const project = path.join(root, 'project'), outside = path.join(root, 'outside');
  await fs.mkdir(project); await fs.mkdir(outside);
  await fs.writeFile(path.join(project, 'keep.txt'), 'preserve');
  await fs.symlink(outside, path.join(project, 'trash'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await new WorkspaceManager(getDefaultConfig(project)).moveToTrash('keep.txt');
  assert.equal(result.success, false);
  assert.equal(result.outcome, 'not_moved');
  assert.equal(await fs.readFile(path.join(project, 'keep.txt'), 'utf8'), 'preserve');
  assert.deepEqual(await fs.readdir(outside), []);
}));

it('Git status recognizes linked worktrees and never reports clean after Git failure', async () => fixture(async root => {
  const main = path.join(root, 'main'), linked = path.join(root, 'linked'), hooks = path.join(root, 'hooks');
  await fs.mkdir(main); await fs.mkdir(hooks);
  // Resolve the test tool outside the generated repository; never resolve it in fixture cwd.
  const executable = process.platform === 'win32'
    ? execFileSync(path.join(process.env.SystemRoot!, 'System32', 'where.exe'), ['git.exe'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0]
    : '/usr/bin/git';
  const git = (...args: string[]) => execFileSync(executable, ['-c', `core.hooksPath=${hooks}`, '-c', 'commit.gpgsign=false', ...args],
    { cwd: main, windowsHide: true, timeout: 5000, stdio: 'pipe' });
  git('init'); await fs.writeFile(path.join(main, 'fixture.txt'), 'initial'); git('add', 'fixture.txt');
  git('-c', 'user.name=WinCode Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture');
  git('worktree', 'add', '--detach', linked, 'HEAD');
  assert.equal((await new WorkspaceManager(getDefaultConfig(linked)).getGitStatus()).isGit, true);
  await fs.writeFile(path.join(main, 'fixture.txt'), 'changed');
  const workspace = new WorkspaceManager(getDefaultConfig(main));
  assert.equal((await workspace.getGitStatus()).isClean, false);
  const monitor = path.join(main, 'fixture-fsmonitor');
  await fs.writeFile(monitor, '#!/bin/sh\nprintf called > fsmonitor-ran.txt\nexit 1\n', { mode: 0o755 });
  git('config', 'core.fsmonitor', "'" + monitor.replace(/\\/g, '/').replace(/'/g, "'\\''") + "'");
  git('status', '--porcelain');
  const marker = path.join(main, 'fsmonitor-ran.txt');
  assert.equal(await fs.readFile(marker, 'utf8'), 'called', 'positive control must execute the fixture monitor');
  await fs.unlink(marker);
  await workspace.getGitStatus();
  await new WorkspaceFingerprint(0).computeWorkspaceFingerprint(main);
  assert.equal(await fs.stat(marker).then(() => true, () => false), false, 'WinCode read-only probes must disable executable fsmonitor configuration');
  await fs.writeFile(path.join(main, '.git', 'config'), '[invalid config');
  assert.notEqual((await workspace.getGitStatus()).isClean, true);
}));

it('architecture analysis does not read external solution projects', async () => fixture(async root => {
  const project = path.join(root, 'project'), outside = path.join(root, 'outside');
  await fs.mkdir(project); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'Outside.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>OUTSIDE_SECRET</TargetFramework></PropertyGroup></Project>');
  await fs.writeFile(path.join(outside, 'Program.cs'), 'class Outside {}');
  await fs.writeFile(path.join(project, 'App.sln'), 'Project("{11111111-1111-1111-1111-111111111111}") = "Outside", "../outside/Outside.csproj", "{22222222-2222-2222-2222-222222222222}"\nEndProject');
  const report = await new ArchitectureAnalyzer(new WorkspaceManager(getDefaultConfig(project))).analyze();
  assert.doesNotMatch(JSON.stringify(report), /OUTSIDE_SECRET|\.\.\/outside\/Program\.cs/);
  assert.equal(report.projectGraph?.projects.length, 0);
}));
