import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { getDefaultConfig } from '../src/Core/Config.js';
import { WorkspaceManager } from '../src/Core/Workspace.js';
import { ToolRouter } from '../src/Core/ToolRouter.js';
import { WinCodeMcpServer } from '../src/Gateway/McpServer.js';

const body = (result: any) => JSON.parse(result.content[0].text);
const mismatch = (error: any) => error.errorCode === 'WORKSPACE_MISMATCH';

it('TavernDesk acceptance binds the requested project without writing test data into it', { timeout: 30000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-acceptance-project-'));
  const sourceDirectory = path.join(root, 'src/TavernDesk.App/ViewModels');
  const file = path.join(sourceDirectory, 'MainWindowViewModel.cs');
  const source = ['class MainWindowViewModel {', '    private async Task ShowCharactersAsync()',
    '    {', '        await Task.CompletedTask;', '    }', '', '    private void Other() {}', '}',
    ...Array.from({ length: 240 }, () => '// fixture padding')].join('\n');
  try {
    await fs.mkdir(sourceDirectory, { recursive: true });
    await fs.writeFile(file, source);
    const result = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/verify-tavern-context.ts', root],
      { cwd: process.cwd(), encoding: 'utf8', windowsHide: true, timeout: 25000, maxBuffer: 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, 'passed');
    assert.equal(report.measurements.length, 8);
    assert.equal(await fs.readFile(file, 'utf8'), source);
    assert.deepEqual(await fs.readdir(root), ['src'], 'cache and trash must remain outside the source workspace');
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  }
});

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
    const wrongWrite = await call('wincode_safe_move_to_trash', { workspacePath: b, filePath: 'Api.cs' });
    assert.equal(body(wrongWrite).errorCode, 'WORKSPACE_MISMATCH');
    assert.match(await fs.readFile(path.join(a, 'Api.cs'), 'utf8'), /ONLY_A/);
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

it('a production mismatch supplies a usable second connection without rebinding the first', async () => fixture(async (a, b) => {
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
    const guide = body(rejected).connectionGuide;
    assert.equal(guide.workspace, b);
    assert.equal(guide.configuration.command, process.execPath);
    assert.deepEqual(guide.configuration.args, [path.resolve('dist/index.js'), '--workspace', b]);
    const printed = spawnSync(process.execPath, [path.resolve('dist/index.js'), '--print-connection', '--workspace', b],
      { cwd: a, input: '', encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 262144 });
    assert.equal(printed.status, 0, printed.stderr);
    assert.deepEqual(JSON.parse(printed.stdout), guide);
    await assert.rejects(fs.stat(path.join(b, '.cache')), { code: 'ENOENT' });
    const second = new Client({ name: 'guided-second-connection', version: '1' });
    try {
      await second.connect(new StdioClientTransport({ ...guide.configuration, cwd: a, stderr: 'pipe' }));
      const secondHello = body(await second.callTool({ name: guide.verification.tool, arguments: guide.verification.arguments }));
      assert.equal(secondHello.workspace, guide.verification.expectedWorkspace);
      assert.notEqual(secondHello.runtime.instanceId, hello.runtime.instanceId);
      for (const [connection, expected, excluded] of [[client, 'ONLY_A', 'ONLY_B'], [second, 'ONLY_B', 'ONLY_A']] as const) {
        const result = body(await connection.callTool({ name: 'wincode_prepare_context', arguments: {
          task: 'Read the connected project', lineRanges: [{ file: 'Api.cs', startLine: 1, endLine: 1 }],
        } }));
        assert.ok(result.evidence[0].snippet.includes(expected));
        assert.ok(!result.evidence[0].snippet.includes(excluded));
      }
    } finally { await second.close(); }
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

async function withDynamicClient(cwd: string, options: string[], run: (client: Client) => Promise<void>) {
  const client = new Client({ name: 'dynamic-workspace-acceptance', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.resolve('dist/index.js'), '--dynamic-workspace', ...options], cwd, stderr: 'pipe' });
  try { await client.connect(transport); await run(client); }
  finally { await client.close(); }
}

function windowsShortPath(directory: string): string {
  const result = spawnSync('cmd.exe', ['/d', '/u', '/c', 'for %I in (.) do @echo %~fsI'],
    { cwd: directory, encoding: 'utf16le', windowsHide: true, timeout: 5000 });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  return result.stdout.trim();
}

it('Windows long and short paths share the explicitly configured dynamic workspace in either direction',
  { skip: process.platform !== 'win32', timeout: 30000 }, async t => fixture(async (a, b) => {
    const long = await fs.realpath(a);
    const short = windowsShortPath(long);
    assert.equal(await fs.realpath(short), long);
    if (path.relative(long, short) === '') { t.skip('The fixture volume did not supply a distinct 8.3 path'); return; }

    for (const [configured, alternate] of [[long, short], [short, long]]) {
      await withDynamicClient(path.dirname(a), ['--workspace', configured], async client => {
        const call = async (name: string, args: Record<string, unknown>) => {
          const result = await client.callTool({ name, arguments: args });
          assert.notEqual(result.isError, true, JSON.stringify(result.content));
          return body(result);
        };
        const [opened, neighbour] = await Promise.all([alternate, b].map(p => call('workspace_open', { path: p })));
        assert.equal(await fs.realpath(opened.workspace), long);
        assert.equal(await fs.realpath(neighbour.workspace), await fs.realpath(b));
        const [primary, alias, other] = await Promise.all([configured, alternate, b]
          .map(workspacePath => call('wincode_hello_world', { workspacePath })));
        assert.equal(alias.health.workspaceBinding.source, 'argument');
        assert.equal(alias.health.session.id, primary.health.session.id);
        assert.equal(alias.health.cache.namespace, primary.health.cache.namespace);
        assert.equal(other.health.workspaceBinding.source, 'request');
        assert.notEqual(other.health.session.id, primary.health.session.id);
        const confirmed = await call('workspace_open', { path: configured, workspacePath: alternate });
        assert.equal(await fs.realpath(confirmed.workspace), long);
        for (const workspacePath of [long, short]) for (const spelling of [long, short]) {
          const file = path.join(spelling, 'Api.cs');
          const [search, outline, context] = await Promise.all([
            call('wincode_search_text', { workspacePath, query: 'ONLY_A', scopePaths: [file] }),
            call('wincode_file_outline', { workspacePath, file }),
            call('wincode_prepare_context', { workspacePath, task: 'Read Api', candidateFiles: [file],
              scopeFiles: [path.join(workspacePath, 'Api.cs')], lineRanges: [{ file, startLine: 1, endLine: 1 }] }),
          ]);
          assert.equal(search.matches[0].file, 'Api.cs');
          assert.equal(outline.symbols[0].name, 'Api');
          assert.match(context.evidence[0].snippet, /ONLY_A/);
        }
        const missing = await call('wincode_prepare_context', { workspacePath: long, task: 'Read missing',
          scopeFiles: [path.join(short, 'missing.cs')] });
        assert.ok(missing.fileIssues.some((issue: { reason: string }) => issue.reason === 'not-found'));
        for (const file of [path.join(b, 'Api.cs'), short + '/sub/../Api.cs', path.join(short, 'Api.cs:stream')]) {
          assert.equal(body(await client.callTool({ name: 'wincode_file_outline', arguments: { workspacePath: long, file } })).errorCode, 'INVALID_ARGUMENT');
        }
      });
    }
  }));

it('one dynamic stdio connection reads the correct same-named file across sequential and overlapping workspace requests', { timeout: 45000 }, async t =>
  fixture(async (a, b) => withDynamicClient(path.dirname(a), [], async client => {
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, JSON.stringify(result.content));
      return body(result);
    };
    const read = async (root: string) => {
      const result = await call('wincode_prepare_context', { workspacePath: root, task: 'Read the project marker',
        lineRanges: [{ file: 'Api.cs', startLine: 1, endLine: 1 }] });
      assert.equal(result.evidence[0].snippet.trim(), `public class Api { public string Marker = "${root === a ? 'ONLY_A' : 'ONLY_B'}"; }`);
    };
    const hello = await call('wincode_hello_world', { toolName: 'wincode_prepare_context' });
    assert.equal(hello.health.workspaceBinding.mode, 'dynamic');
    assert.equal(hello.workspace, null);
    assert.ok(hello.toolContract.tool.inputSchema.required.includes('workspacePath'));
    await Promise.all([read(a), read(b)]);
    for (const root of [a, b, a]) {
      assert.equal((await call('workspace_open', { path: root })).workspace, await fs.realpath(root));
      await read(root);
    }
    await Promise.all(Array.from({ length: 16 }, (_, i) => read(i % 2 ? b : a)));
    await Promise.all([a, b].map(async workspacePath => {
      const [found, outline, correction] = await Promise.all([
        call('wincode_search_text', { workspacePath, query: 'Marker', scopePaths: ['Api.cs'] }),
        call('wincode_file_outline', { workspacePath, file: 'Api.cs' }),
        call('wincode_prepare_context', { workspacePath, task: 'Read Api', lineRanges: [{ file: 'Api.cs', startLine: 1, endLine: 20 }] }),
      ]);
      for (const next of [found.matches[0].nextRequest, outline.nextRequest, outline.symbols[0].nextRequest, correction.coverage.details[0].nextRequest]) {
        assert.equal(next.workspacePath, await fs.realpath(workspacePath));
        const read = await call('wincode_prepare_context', next);
        assert.match(read.evidence[0].snippet, workspacePath === a ? /ONLY_A/ : /ONLY_B/);
      }
    }));
    const [left, right] = await Promise.all([a, b].map(workspacePath => call('wincode_hello_world', { workspacePath })));
    for (const [health, root] of [[left, a], [right, b]] as const) {
      const physicalRoot = await fs.realpath(root);
      assert.equal(health.runtime.instanceId, hello.runtime.instanceId);
      assert.equal(health.workspace, physicalRoot);
      assert.equal(health.health.workspaceWatch.root, physicalRoot);
      assert.equal((await call('wincode_hello_world', { workspacePath: physicalRoot })).health.session.id, health.health.session.id);
      assert.ok(health.health.admission.business.peakActive >= 2);
    }
    assert.notEqual(left.health.cache.namespace, right.health.cache.namespace);
    assert.notEqual(left.health.session.id, right.health.session.id);
    await assert.rejects(fs.stat(path.join(path.dirname(a), '.cache')), { code: 'ENOENT' });
    t.diagnostic(JSON.stringify({ instanceId: hello.runtime.instanceId, sequential: ['ONLY_A', 'ONLY_B', 'ONLY_A'],
      parallelReads: 16, peakActive: left.health.admission.business.peakActive }));
  })));

it('failed workspace selections leave live projects usable and a concurrent trash move stays inside its selected project', { timeout: 45000 }, async () =>
  fixture(async (a, b) => withDynamicClient(path.dirname(a), [], async client => {
    const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
    const missing = path.join(path.dirname(a), 'missing');
    const link = path.join(path.dirname(a), 'alias');
    await fs.symlink(b, link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.notEqual((await call('workspace_open', { path: a })).isError, true);
    const original = body(await call('wincode_hello_world', { workspacePath: a })).health.session.id;
    for (const args of [{ path: missing }, { path: 'relative' }, { path: link }, { path: a, workspacePath: b }, { path: b, workspacePath: link }]) {
      const rejected = await call('workspace_open', args);
      assert.equal(rejected.isError, true);
      assert.equal(body(rejected).errorCode, 'INVALID_ARGUMENT');
    }
    assert.equal((await call('wincode_safe_move_to_trash', { filePath: 'Api.cs' })).isError, true);
    await assert.rejects(fs.stat(missing), { code: 'ENOENT' });
    assert.equal(body(await call('wincode_hello_world', { workspacePath: a })).health.session.id, original);
    const [readA, moveB] = await Promise.all([
      call('wincode_search_text', { workspacePath: a, query: 'ONLY_A', scopePaths: ['Api.cs'] }),
      call('wincode_safe_move_to_trash', { workspacePath: b, filePath: 'Api.cs' }),
    ]);
    assert.equal(body(readA).matches[0].file, 'Api.cs');
    const moved = body(moveB);
    const physicalB = await fs.realpath(b);
    assert.equal(moved.outcome, 'completed');
    assert.equal(moved.originalPath, path.join(physicalB, 'Api.cs'));
    assert.equal(path.dirname(moved.trashPath), path.join(physicalB, 'trash'));
    assert.match(await fs.readFile(moved.trashPath, 'utf8'), /ONLY_B/);
    assert.match(await fs.readFile(path.join(a, 'Api.cs'), 'utf8'), /ONLY_A/);
    await assert.rejects(fs.stat(path.join(b, 'Api.cs')), { code: 'ENOENT' });
    // Returning after idle eviction must still resolve Api.cs against A.
    for (const name of ['C', 'D', 'E', 'F']) {
      const root = path.join(path.dirname(a), name);
      await fs.mkdir(root);
      assert.notEqual((await call('workspace_open', { path: root })).isError, true);
    }
    assert.equal(body(await call('wincode_hello_world', { workspacePath: a })).health.session, null);
    const reopened = body(await call('wincode_search_text', { workspacePath: a, query: 'ONLY_A', scopePaths: ['Api.cs'] }));
    assert.equal(reopened.matches.length, 1);
    assert.notEqual(body(await call('wincode_hello_world', { workspacePath: a })).health.session.id, original);
  })));

it('an idle project with slow or failed cleanup does not block other projects on one connection', { timeout: 15000 }, async t =>
  fixture(async (projectA, projectB) => {
    const [a, b] = await Promise.all([fs.realpath(projectA), fs.realpath(projectB)]);
    const config = getDefaultConfig(); config.workspaceMode = 'dynamic';
    config.adapters.flaui.enabled = false; config.adapters.repomix.useCli = false;
    const primary = new ToolRouter(config), server = new WinCodeMcpServer(primary);
    const client = new Client({ name: 'dynamic-cleanup', version: '1' });
    const roots = ['C', 'D', 'E', 'F'].map(name => path.join(path.dirname(a), name));
    for (const root of roots) await fs.mkdir(root);
    let entered!: () => void, release!: () => void;
    const retiring = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
    const initialize = ToolRouter.prototype.initialize;
    let cleanupCalls = 0, openedE = 0, cleanupFinished = false;
    t.mock.method(ToolRouter.prototype, 'initialize', async function (this: ToolRouter) {
      await initialize.call(this);
      if (this.config.workspaceRoot === roots[2]) openedE++;
      if (this.config.workspaceRoot === a) this.resources.register('disposable', 'fixture', async () => {
        cleanupCalls++; entered(); await gate; cleanupFinished = true; throw new Error('Controlled cleanup failure');
      });
    });
    const list = async (workspacePath: string) => body(await client.callTool({ name: 'wincode_list_directory', arguments: { workspacePath } }));
    try {
      const [left, right] = InMemoryTransport.createLinkedPair();
      await Promise.all([client.connect(left), (server as any).server.connect(right)]);
      for (const root of [a, b, roots[0], roots[1]]) assert.equal((await list(root)).workspace, root);
      const firstE = list(roots[2]); await retiring;
      const secondE = list(roots[2]);
      const hotB = body(await client.callTool({ name: 'wincode_search_text', arguments: { workspacePath: b, query: 'ONLY_B', scopePaths: ['Api.cs'] } }));
      assert.equal(hotB.matches.length, 1); assert.equal(cleanupFinished, false);
      assert.equal(openedE, 0, 'the retiring router still occupies its slot');
      release();
      for (const result of await Promise.all([firstE, secondE])) assert.equal(result.workspace, roots[2]);
      assert.equal(openedE, 1);
      assert.equal((await list(roots[3])).workspace, roots[3]); assert.equal((await list(b)).workspace, b);
      const failed = await list(a);
      assert.equal(failed.errorCode, 'WORKSPACE_RECOVERY_REQUIRED'); assert.equal(failed.recoveryAction, 'restart_gateway');
      assert.equal(cleanupCalls, 1);
    } finally {
      release(); await client.close(); await assert.rejects(server.stop(), /Dynamic workspace cleanup failed|Gateway shutdown failed/);
    }
  }));

it('dynamic Roslyn evaluation is confined to the explicitly configured project across real stdio calls', { timeout: 120000 }, async t =>
  fixture(async (a, b) => {
    const repo = path.resolve(import.meta.dirname, '..');
    const { resolveDotnet, runDotnet } = await import(pathToFileURL(path.join(repo, 'scripts/lib/dotnet.mjs')).href);
    const sdk = resolveDotnet(repo);
    const project = '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>';
    for (const root of [a, b]) await fs.writeFile(path.join(root, 'Api.csproj'), project);
    const methods = Array.from({ length: 205 }, (_, i) => `public void ApiEarlyApiLateApiTwin${i}() {}`);
    await fs.writeFile(path.join(a, 'Types.cs'), ['public class ApiEarly {}', 'namespace One { public class ApiTwin {} }',
      'public class Container {', ...methods, 'public void MixedName() {}', 'public void Run(int n) {}', 'public void Run(string s) {}', '}',
      'public class MixedName {}', 'namespace Two { public class ApiTwin {} }', 'public class ApiLate {}',
      'public partial class Parts { public partial int SplitValue { get; } public partial int MyProp { get; } }',
      'public partial class Parts { public partial int MyProp => 4; }'].join('\n'));
    await fs.writeFile(path.join(a, 'Uses.cs'), ['public class Uses { public ApiEarly Early; public ApiLate Late;',
      'public One.ApiTwin Left; public Two.ApiTwin Right; public int Read(Parts p) => p.SplitValue + p.MyProp; }'].join('\n'));
    const secondPart = 'public partial class Parts { public partial int SplitValue => 7; }';
    await fs.writeFile(path.join(a, 'Second.cs'), secondPart);
    const emptySource = path.join(a, 'empty-source');
    await fs.mkdir(emptySource);
    await fs.copyFile(path.join(repo, 'global.json'), path.join(a, 'global.json'));
    runDotnet(sdk, ['restore', 'Api.csproj', '--source', emptySource, '--nologo'], a, 30000);
    const config = path.join(path.dirname(a), 'roslyn.json');
    await fs.writeFile(config, JSON.stringify({ enabled: true, allowProjectEvaluation: true, project: 'Api.csproj',
      configuration: 'Debug', targetFramework: 'net10.0', dotnetPath: sdk.dotnet,
      hostPath: path.join(repo, 'tools/WinCode.Code.Host/bin/Release/net10.0/publish/WinCode.Code.Host.dll') }));
    const unscoped = spawnSync(process.execPath, [path.join(repo, 'dist/index.js'), '--dynamic-workspace', '--roslyn-config', config],
      { cwd: path.dirname(a), input: '', encoding: 'utf8', timeout: 5000, windowsHide: true });
    assert.equal(unscoped.status, 1);
    assert.match(unscoped.stderr, /requires --workspace/);
    await withDynamicClient(path.dirname(a), ['--workspace', a, '--roslyn-config', config], async client => {
      const query = (workspacePath: string) => client.callTool({ name: 'wincode_find_code_symbol',
        arguments: { workspacePath, query: 'Api', kind: 'class' } }, { timeout: 110000 });
      const alternateA = process.platform === 'win32' ? windowsShortPath(a) : await fs.realpath(a);
      const [semantic, text] = await Promise.all([query(alternateA), query(b)]);
      assert.notEqual(semantic.isError, true, JSON.stringify(semantic.content));
      assert.notEqual(text.isError, true, JSON.stringify(text.content));
      const location = body(semantic).symbols.find((item: { name: string }) => item.name === 'Api')?.location;
      assert.ok(location?.snapshotId);
      assert.equal(body(text).source, 'local-text');
      const cross = await client.callTool({ name: 'wincode_find_references',
        arguments: { workspacePath: b, symbolName: 'Api', symbolLocation: location } });
      assert.equal(body(cross).errorCode, 'UNSUPPORTED_SYMBOL_LOCATION');
      assert.equal(body(await query(a)).symbols.find((item: { name: string }) => item.name === 'Api').location.snapshotId, location.snapshotId);
      const tool = async (name: string, args: Record<string, unknown>) => body(await client.callTool({ name, arguments: { workspacePath: a, ...args } }));
      const fuzzy = await tool('wincode_find_code_symbol', { query: 'ApiLate' });
      assert.equal(fuzzy.totalFound, 206); assert.equal(fuzzy.symbols.length, 200); assert.equal(fuzzy.truncated, true);
      const nameCounts: Record<string, number> = {};
      for (const target of ['ApiEarly', 'ApiLate']) {
        const exact = (await tool('wincode_find_code_symbol', { query: target, kind: 'class' })).symbols[0].location;
        const refs = await tool('wincode_find_references', { symbolName: target, symbolLocation: exact });
        assert.equal(refs.totalReferences, 1);
        const impact = await tool('analyze_change_impact', { target, symbolLocation: exact });
        assert.equal(impact.referencesCount, 1); assert.equal(impact.totalReferences, 1);
        assert.equal(impact.riskLevel, 'UNKNOWN'); assert.deepEqual(impact.symbolLocation, exact);
        const use = { ...exact, file: refs.references[0].file, position: refs.references[0].start };
        assert.equal((await tool('wincode_find_references', { symbolName: target, symbolLocation: use })).totalReferences, 1);
        assert.equal((await tool('analyze_change_impact', { target, symbolLocation: use })).errorCode, 'SYMBOL_MISMATCH');
        const named = await tool('analyze_change_impact', { target });
        assert.deepEqual(named.symbolLocation, exact, target);
        assert.deepEqual([named.uniqueResolution, named.referencesCount, named.totalReferences, named.riskLevel], [true, 1, 1, 'UNKNOWN'], target);
        nameCounts[target] = named.totalReferences;
      }
      const byName = await tool('wincode_find_references', { symbolName: 'ApiLate' });
      assert.equal(byName.candidateCount, 1); assert.equal(byName.candidates[0].name, 'ApiLate');
      const partial = { ...location, file: 'Second.cs', position: secondPart.indexOf('Parts') };
      assert.deepEqual((await tool('analyze_change_impact', { target: 'Parts', symbolLocation: partial })).symbolLocation, partial);
      for (const target of ['MyProp', 'SplitValue']) {
        const property = await tool('wincode_find_code_symbol', { query: target, kind: 'property' });
        assert.equal(property.totalFound, 1); assert.equal(property.symbols.length, 1);
        const impact = await tool('analyze_change_impact', { target });
        assert.deepEqual(impact.symbolLocation, property.symbols[0].location);
        assert.deepEqual([impact.uniqueResolution, impact.referencesCount, impact.totalReferences], [true, 1, 1]);
        nameCounts[target] = impact.totalReferences;
      }
      const implementation = { ...partial, position: secondPart.indexOf('SplitValue') };
      const selectedProperty = await tool('analyze_change_impact', { target: 'SplitValue', symbolLocation: implementation });
      assert.deepEqual(selectedProperty.symbolLocation, implementation); assert.equal(selectedProperty.totalReferences, 1);
      for (const target of ['ApiTwin', 'MixedName', 'Run', 'ApiEarlyApiLate']) {
        const result = await tool('analyze_change_impact', { target });
        assert.equal(result.uniqueResolution, false, target); assert.equal(result.riskLevel, 'UNKNOWN');
        assert.equal(result.symbolLocation, undefined); assert.equal(result.targetKind, undefined); assert.equal(result.totalReferences, null);
        const candidates = result.matchedSymbols;
        assert.equal(candidates.length, target === 'ApiEarlyApiLate' ? 0 : 2, target);
        assert.ok(candidates.every((s: { name: string }) => s.name === target));
        assert.equal(new Set(candidates.map((s: { location: unknown }) => JSON.stringify(s.location))).size, candidates.length);
        if (target === 'ApiTwin') {
          for (const candidate of candidates)
            assert.equal((await tool('analyze_change_impact', { target, symbolLocation: candidate.location })).totalReferences, 1);
        }
      }
      t.diagnostic(JSON.stringify({ similarMethods: methods.length, fuzzyCandidates: fuzzy.totalFound, nameCounts,
        ambiguousNames: ['ApiTwin', 'MixedName', 'Run'], partialImplementation: selectedProperty.symbolLocation.file }));
    });
  }));
