import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/client';
import { getDefaultConfig } from '../src/Core/Config.js';
import { ToolRouter } from '../src/Core/ToolRouter.js';
import { WinCodeMcpServer } from '../src/Gateway/McpServer.js';

type Call = (name: string, args?: Record<string, unknown>) => Promise<any>;

async function fixture(run: (root: string, router: ToolRouter, call: Call) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-summary-'));
  const config = getDefaultConfig(root);

  config.adapters.flaui.enabled = false;
  config.adapters.repomix.useCli = false;
  const router = new ToolRouter(config);
  const server = new WinCodeMcpServer(router);
  const client = new Client({ name: 'workspace-summary-test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await fs.writeFile(path.join(root, 'package.json'), '{"name":"isolated-summary-fixture"}');
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'src', 'index.ts'), 'export const entry = true;');
    await Promise.all([client.connect(left), (server as any).server.connect(right)]);
    await run(root, router, (name, args = {}) => client.callTool({ name, arguments: args }));
  } finally {
    await client.close();
    await server.stop();
    // Only the freshly-created synthetic fixture is removed.
    assert.equal(path.dirname(root), os.tmpdir());
    await fs.rm(root, { recursive: true, force: true });
  }
}

function payload(result: any, budget = 8000) {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  assert.ok(result.content[0].text.length <= budget, 'all JSON text must fit the budget');
  return JSON.parse(result.content[0].text);
}

it('workspace summary keeps identity and useful entries without inventory or tree construction', async () => fixture(async (root, router, call) => {
  await Promise.all(['README.md', 'README.zh-CN.md', 'README.zh-TW.md', 'README.ja-JP.md', 'README.en.md']
    .map(name => fs.writeFile(path.join(root, name), '# Fixture')));
  router.workspace.getMetadata = async () => { throw new Error('must not inventory the workspace'); };
  router.workspace.getDirectoryTree = async () => { throw new Error('must not build the legacy tree'); };
  const data = payload(await call('workspace_open', { path: root }));
  assert.equal(path.resolve(data.workspace), root);
  assert.equal(data.type, 'node');
  assert.equal(data.fileTree, undefined);
  assert.equal(data.metadata.totalFiles, null);
  assert.equal(data.metadata.totalSizeBytes, null);
  assert.ok(data.entryPoints.length <= 8);
  assert.ok(data.entryPoints.includes('src/index.ts'), 'an actual source entry must survive');
  assert.ok(!data.entryPoints.includes('README.zh-CN.md'), 'translated readmes must not crowd out source entries');
  assert.equal(typeof data.projectScanComplete, 'boolean');
}));

it('wide publishing folders do not inflate open output and work sources remain accessible', async () => fixture(async (root, _router, call) => {
  await fs.mkdir(path.join(root, '.publish-verify'));
  await fs.mkdir(path.join(root, 'work', 'source'), { recursive: true });
  await fs.writeFile(path.join(root, 'work', 'source', 'Important.cs'), 'class Important {}');
  for (let batch = 0; batch < 8; batch++) {
    await Promise.all(Array.from({ length: 40 }, (_, i) => fs.writeFile(
      path.join(root, '.publish-verify', `library-${batch * 40 + i}.dll`), 'fixture')));
  }
  const result = await call('workspace_open', { path: root });
  const data = payload(result);
  assert.equal(data.type, 'node');
  assert.ok(!result.content[0].text.includes('library-'), 'opening is not a DLL listing');
  const sources = payload(await call('wincode_list_directory', { path: 'work/source' }));
  assert.ok(sources.entries.some((entry: any) => entry.path === 'work/source/Important.cs'));
  assert.equal(sources.scanComplete, true);
}));

it('directory entry and text limits describe actual partial results including Unicode escaping', async () => fixture(async (root, _router, call) => {
  await fs.mkdir(path.join(root, 'wide'));
  for (let i = 0; i < 24; i++) await fs.writeFile(path.join(root, 'wide', `${i}-${'资料'.repeat(40)}.ts`), '// fixture');
  const byEntries = payload(await call('wincode_list_directory', { path: 'wide', maxEntries: 7 }));
  assert.ok(byEntries.visitedEntries <= 7);
  assert.ok(byEntries.returnedEntries <= byEntries.visitedEntries);
  assert.equal(byEntries.returnedEntries, byEntries.entries.length);
  assert.equal(byEntries.scanComplete, false);
  assert.equal(byEntries.truncated, true);
  const byText = payload(await call('wincode_list_directory', { path: 'wide', maxOutputChars: 2048 }), 2048);
  assert.equal(byText.truncated, true);
  assert.equal(byText.returnedEntries, byText.entries.length);
  assert.ok(byText.returnedEntries < 24);
  assert.ok(byText.outputOmissions.length > 0);
}));

it('ignored directories are recoverable explicitly and outside junctions are never traversed', async () => fixture(async (root, router, call) => {
  await fs.mkdir(path.join(root, 'dist'));
  await fs.writeFile(path.join(root, 'dist', 'artifact.js'), '// public build fixture');
  const omitted = payload(await call('wincode_list_directory', { maxDepth: 2 }));
  assert.ok(!omitted.entries.some((entry: any) => entry.path === 'dist/artifact.js'));
  const explicit = payload(await call('wincode_list_directory', { path: 'dist', includeIgnored: true }));
  assert.ok(explicit.entries.some((entry: any) => entry.path === 'dist/artifact.js'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-summary-outside-'));
  try {
    await fs.writeFile(path.join(outside, 'SECRET_FILENAME.ts'), 'secret');
    await fs.symlink(outside, path.join(root, 'link'), 'junction');
    const response = await call('wincode_list_directory', { maxDepth: 3, includeIgnored: true });
    payload(response);
    assert.ok(!JSON.stringify(response).includes('SECRET_FILENAME'));
    assert.equal((await call('wincode_list_directory', { path: 'link', includeIgnored: true })).isError, true);
    assert.equal(router.workspace.root, root);
  } finally {
    assert.equal(path.dirname(outside), os.tmpdir());
    await fs.rm(outside, { recursive: true, force: true });
  }
}));

it('invalid workspace and directory options fail without switching workspace', async () => fixture(async (root, router, call) => {
  const next = path.join(root, 'next');
  await fs.mkdir(next);
  for (const args of [{ maxOutputChars: 1 }, { maxOutputChars: 8000.5 }, { includeTree: 'yes' }]) {
    assert.equal((await call('workspace_open', { path: root, ...args })).isError, true, JSON.stringify(args));
    assert.equal(router.workspace.root, root);
  }
  for (const args of [{ path: '..' }, { path: 'src/../src' }, { path: 'C:relative' }, { path: 'a'.repeat(4097) }, { maxDepth: 0 }, { maxDepth: 6 }, { maxEntries: 501 }, { includeIgnored: 'yes' }, { maxOutputChars: 200 }]) {
    assert.equal((await call('wincode_list_directory', args)).isError, true, JSON.stringify(args));
  }
  const baseline = payload(await call('wincode_list_directory', { path: '.', maxDepth: 1 }));
  const extended = payload(await call('wincode_list_directory', { path: '.', maxDepth: 1, unsupported: true }));
  assert.deepEqual(extended.entries, baseline.entries, 'unknown fields cannot alter the directory scope');
  assert.notEqual((await call('workspace_open', { path: root, unsupported: true })).isError, true);
  const mismatch = await call('workspace_open', { path: next, unsupported: true });
  assert.equal(mismatch.isError, true);
  assert.equal(JSON.parse(mismatch.content[0].text).errorCode, 'WORKSPACE_MISMATCH');
  assert.equal(router.workspace.root, root, 'extra fields cannot enable switching');
}));

it('the opt-in tree is bounded and does not change the default summary contract', async () => fixture(async (root, _router, call) => {
  const detailed = payload(await call('workspace_open', { path: root, includeTree: true }));
  assert.ok(detailed.fileTree);
  assert.ok(detailed.fileTree.children.length > 0);
  const summary = payload(await call('workspace_open', { path: root }));
  assert.equal(summary.fileTree, undefined);
  assert.equal(summary.type, detailed.type);
  assert.equal(summary.solution, detailed.solution);
}));

it('oversized project descriptors are reported as incomplete instead of read without limit', async () => fixture(async (root, _router, call) => {
  await fs.writeFile(path.join(root, 'Large.sln'), ' '.repeat(2 * 1024 * 1024));
  const data = payload(await call('workspace_open', { path: root, maxOutputChars: 2048 }), 2048);
  assert.equal(data.projectScanComplete, false);
  assert.ok(data.metadata.projectDiscovery.descriptorBytesRead <= data.metadata.projectDiscovery.maxDescriptorBytes);
}));

it('solution XML entity paths identify the same real project without phantom duplicates', async () => fixture(async (root, _router, call) => {
  await fs.mkdir(path.join(root, 'A&B'));
  await fs.writeFile(path.join(root, 'A&B', 'Core.csproj'), '<Project Sdk="Microsoft.NET.Sdk"/>');
  await fs.writeFile(path.join(root, 'Test.slnx'), '<Solution><Project Path="A&amp;B/Core.csproj"/><Project Path="A&#38;B/Core.csproj"/></Solution>');
  const valid = payload(await call('workspace_open', { path: root }));
  assert.equal(valid.projects, 1);
  assert.deepEqual(valid.metadata.projectList, ['A&B/Core.csproj']);
  await fs.writeFile(path.join(root, 'Test.slnx'), '<Solution><Project Path="A&unknown;B/Core.csproj"/></Solution>');
  const invalid = payload(await call('workspace_open', { path: root }));
  assert.equal(invalid.projectScanComplete, false);
  assert.ok(!invalid.metadata.projectList.some((file: string) => file.includes('&unknown;')));
}));

it('project and omission metadata also fit the smallest budget while primary identity survives', async () => fixture(async (root, _router, call) => {
  const declarations = Array.from({ length: 90 }, (_, index) =>
    `Project("{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}") = "P${index}", "${'项目'.repeat(20)}-${index}.csproj"`).join('\n');
  await fs.writeFile(path.join(root, 'Main.sln'), declarations);
  const result = payload(await call('workspace_open', { path: root, maxOutputChars: 2048 }), 2048);
  assert.equal(result.solution, 'Main.sln');
  assert.equal(result.type, 'dotnet');
  assert.equal(result.projects, 90);
  assert.equal(result.truncated, true);
  assert.ok(result.metadata.projectList.length < 90);
  assert.ok(result.outputOmissions.includes('metadata.projectList'));
}));
