import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mapUiSources, validateCandidateFiles } from '../src/Core/UiSourceMapper.js';
import { UiNode } from '../src/Core/UiContracts.js';
import { reviewUi } from '../src/CompositeTools/UiReview.js';
import { ToolRouter } from '../src/Core/ToolRouter.js';
import { getDefaultConfig } from '../src/Core/Config.js';
import { WinCodeMcpServer } from '../src/Gateway/McpServer.js';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/client';

const node = (id: number, automationId?: string): UiNode => ({ id, parentId: null, automationId, children: [] });

it('optional text evidence never overrides contradictory identity candidates', async () => fixture(async root => {
  await fs.writeFile(path.join(root, 'view.xaml'), '<Grid>\n<Button AutomationProperties.AutomationId="Save" Content="Cancel"/>\n<Button AutomationProperties.AutomationId="Other" Content="Save"/>\n<Button Content="Save"/></Grid>');
  const plain = await mapUiSources(root, ['view.xaml'], node(1, 'Save'));
  assert.equal(plain.textSearch, undefined);
  const result = await mapUiSources(root, ['view.xaml'], node(1, 'Save'), undefined, ['Save']);
  assert.deepEqual(result.nodes, plain.nodes);
  assert.equal(result.nodes[0].candidates[0].line, 2);
  assert.equal(result.textSearch!.identityMatch, false);
  assert.deepEqual(result.textSearch!.matches.map(hit => hit.line), [3, 4]);
  assert.ok(result.textSearch!.matches.every(hit => !('nodeId' in hit)));
}));

it('text search ignores pseudo declarations and reports unresolved resource references', async () => fixture(async root => {
  await fs.writeFile(path.join(root, 'view.xaml'), [
    '<Grid>', '<!-- <TextBlock Text="Save"/> -->', '<![CDATA[<Button Content="Save"/>]]>',
    '<Button Tag=" Content=\'Save\'"/>', '<TextBlock', ' Text="Save.*"/>',
    '<Window Title="{DynamicResource Save.Title}"/>', '<Button Content="{Binding Save}"/>', '</Grid>',
  ].join('\n'));
  const result = await mapUiSources(root, ['view.xaml'], node(1), undefined, ['Save', 'Save.*', '保存']);
  assert.equal(result.textSearch!.totalMatches, 4);
  assert.deepEqual(result.textSearch!.matches.map(hit => hit.line), [6, 6, 7, 8]);
  assert.deepEqual(result.textSearch!.matches.map(hit => hit.kind), ['literal', 'literal', 'resource-reference', 'binding-expression']);
  assert.ok(result.textSearch!.matches.every(hit => hit.fileSha256.length === 64));
}));

it('text match cap preserves totals and clips around the actual keyword', async () => fixture(async root => {
  await fs.writeFile(path.join(root, 'view.xaml'), '<Grid>' + (`<Button Content="${'x'.repeat(300)}命中"/>`).repeat(45) + '</Grid>');
  const result = await mapUiSources(root, ['view.xaml'], node(1), undefined, ['命中', '命中']);
  assert.equal(result.textSearch!.totalMatches, 45);
  assert.equal(result.textSearch!.matches.length, 40);
  assert.equal(result.textSearch!.truncated, true);
  assert.ok(result.textSearch!.matches.every(hit => hit.snippet.includes('命中')));
}));

it('invalid text queries reject before acquiring a UI snapshot', async () => {
  let calls = 0;
  for (const queries of [[' '], ['a\nb'], ['x'.repeat(81)], Array(6).fill('a'), [3]]) {
    await assert.rejects(reviewUi(async () => { calls++; throw new Error('must not inspect'); },
      '.', { pid: 1 }, ['view.xaml'], undefined, queries as string[]), /textQueries/);
  }
  assert.equal(calls, 0);
});

async function fixture(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-source-'));
  try { await run(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

it('literal candidates preserve lines, attribute evidence and ambiguity without claiming identity', async () => fixture(async root => {
  await fs.writeFile(path.join(root, '页面.xaml'), [
    '<Grid>', '<!-- <Button AutomationProperties.AutomationId="Save"/> -->',
    '<Button Command="{Binding Save}"', ' AutomationProperties.AutomationId="Save" Content="a > b"/>',
    '<Button AutomationProperties.AutomationId="Save"/>',
    '<Button x:Name="NameOnly"/>', '</Grid>',
  ].join('\n'));
  const tree = node(1, 'Save'); tree.children = [node(2, 'NameOnly'), node(3, 'x'.repeat(256))];
  const result = await mapUiSources(root, ['页面.xaml', './页面.xaml'], tree);
  assert.equal(result.files.length, 1);
  assert.equal(result.runtimeSourceVerified, false);
  assert.equal(result.fileScanComplete, true);
  assert.equal(result.nodes[0].status, 'ambiguous');
  assert.equal(result.nodes[0].candidateCount, 2);
  assert.equal(result.nodes[0].candidates[0].line, 3);
  assert.equal(result.nodes[0].candidates[0].declarations.Command, '{Binding Save}');
  assert.equal(result.nodes[0].candidates[0].fileSha256.length, 64);
  assert.equal(result.nodes[0].candidates[0].automationId, 'Save');
  assert.equal(result.nodes[1].status, 'not-found');
  assert.equal(result.nodes[2].status, 'unsupported');
}));

it('CDATA and quoted pseudo-attributes do not create candidates; cross-file duplicates survive', async () => fixture(async root => {
  await fs.writeFile(path.join(root, 'a.xaml'), `<Grid><![CDATA[<Button AutomationProperties.AutomationId="Fake"/>]]><Button Tag=" AutomationProperties.AutomationId='Fake'" AutomationProperties.AutomationId="Real"/></Grid>`);
  await fs.writeFile(path.join(root, 'b.xaml'), '<Button AutomationProperties.AutomationId="Real"/>');
  const tree = node(1, 'Real'); tree.children = [node(2, 'Fake')];
  const result = await mapUiSources(root, ['a.xaml', 'b.xaml'], tree);
  assert.equal(result.nodes[0].candidateCount, 2);
  assert.equal(result.nodes[1].candidateCount, 0);
}));

it('invalid scopes reject and junctions outside workspace are not read', async () => fixture(async root => {
  for (const value of [[], ['../a.xaml'], ['C:foo.xaml'], ['/a.xaml'], ['a.cs'], ['a.xaml', 2]]) {
    assert.throws(() => validateCandidateFiles(value));
  }
  await fixture(async outside => {
    await fs.writeFile(path.join(outside, 'a.xaml'), '<Button AutomationProperties.AutomationId="Save"/>');
    await fs.symlink(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = await mapUiSources(root, ['link/a.xaml', 'missing.xaml'], node(1, 'Save'));
    assert.equal(result.files[0].status, 'outside-workspace');
    assert.equal(result.files[1].status, 'unreadable');
    assert.equal(result.fileScanComplete, false);
    assert.equal(result.nodes[0].candidateCount, 0);
  });
}));

it('source size, encoding and cancellation boundaries are explicit', async () => fixture(async root => {
  await fs.writeFile(path.join(root, 'large.xaml'), 'x'.repeat(256 * 1024 + 1));
  await fs.writeFile(path.join(root, 'utf16.xaml'), Buffer.from('<Grid/>', 'utf16le'));
  const result = await mapUiSources(root, ['large.xaml', 'utf16.xaml'], node(1, 'Save'));
  assert.equal(result.truncated, true);
  assert.equal(result.files[1].status, 'unsupported-encoding');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(mapUiSources(root, ['large.xaml'], node(1), controller.signal), { name: 'AbortError' });
}));

it('review inspects once and keeps the snapshot if source lookup is unavailable', async () => {
  let calls = 0;
  const snapshot = { schemaVersion: '1.0', protocolVersion: '1.0', requestId: 'one', success: true,
    tree: node(1, 'Save'), screenshotPngBase64: 'AAAA' };
  const result = await reviewUi(async () => { calls++; return snapshot; },
    path.join(os.tmpdir(), 'absent-' + Date.now()), { pid: 1 }, ['View.xaml']);
  assert.equal(calls, 1);
  assert.equal(result.tree, snapshot.tree);
  assert.equal(result.screenshotPngBase64, 'AAAA');
  assert.ok(result.sourceEvidenceOmitted);
});

it('MCP review validates scope before inspection and fits candidates around the unchanged snapshot', async () => fixture(async root => {
  await fs.writeFile(path.join(root, 'view.xaml'), '<Grid><Button AutomationProperties.AutomationId="Save"/>' + '<Button Content="保存"/>'.repeat(45) + '</Grid>');
  const router = new ToolRouter(getDefaultConfig(root));
  const server = new WinCodeMcpServer(router);
  const client = new Client({ name: 'source-review-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await (server as any).server.connect(b); await client.connect(a);
  let calls = 0;
  router.inspectUi = async () => {
    calls++;
    return { schemaVersion: '1.0', protocolVersion: '1.0', requestId: 'one', success: true,
      tree: { ...node(1, 'Save'), name: '汉'.repeat(42000) }, screenshotPngBase64: 'AAAA' };
  };
  try {
    const tools = await client.listTools();
    assert.ok(tools.tools.some(tool => tool.name === 'wincode_ui_review'));
    const invalid = await client.callTool({ name: 'wincode_ui_review', arguments: { pid: 1 } });
    assert.equal(invalid.isError, true); assert.equal(calls, 0);
    const invalidQuery = await client.callTool({ name: 'wincode_ui_review', arguments: { pid: 1, candidateFiles: ['view.xaml'], textQueries: [' '] } });
    assert.equal(invalidQuery.isError, true); assert.equal(calls, 0);
    const invalidCode = await client.callTool({ name: 'wincode_ui_review', arguments: { pid: 1, candidateFiles: ['view.xaml'], candidateCodeFiles: ['../Secret.cs'] } });
    assert.equal(invalidCode.isError, true); assert.equal(calls, 0);
    const result = await client.callTool({ name: 'wincode_ui_review', arguments: { pid: 1, candidateFiles: ['view.xaml'], textQueries: ['保存'] } });
    assert.equal(result.isError, false); assert.equal(calls, 1);
    const content = result.content as Array<{ type: string; text: string }>;
    assert.equal(content[1].type, 'image');
    assert.ok(Buffer.byteLength(content[0].text, 'utf8') <= 128 * 1024);
    const parsed = JSON.parse(content[0].text);
    assert.equal(parsed.tree.name.length, 42000);
    assert.equal(parsed.sourceEvidence.runtimeSourceVerified, false);
    assert.equal(parsed.sourceEvidence.nodes[0].status, 'single-candidate');
    assert.equal(parsed.sourceEvidence.textSearch.totalMatches, 45);
    assert.equal(parsed.sourceEvidence.textSearch.truncated, true);
    assert.ok(parsed.sourceEvidence.textSearch.matches.length < 40);
    assert.equal(parsed.sourceEvidence.textSearch.identityMatch, false);
    assert.ok(!content[0].text.includes('AAAA'));
    router.inspectUi = async () => ({
      schemaVersion: '1.0', protocolVersion: '1.0', requestId: 'budget', success: true,
      tree: { ...node(1, 'Save'), name: '汉'.repeat(39000),
        children: Array.from({ length: 99 }, (_, i) => node(i + 2, 'Save')) },
      screenshotPngBase64: 'AAAA',
    });
    const limited = await client.callTool({ name: 'wincode_ui_review', arguments: { pid: 1, candidateFiles: ['view.xaml'] } });
    const blocks = limited.content as Array<{ type: string; text: string }>;
    const bounded = JSON.parse(blocks[0].text);
    assert.equal(limited.isError, false);
    assert.ok(Buffer.byteLength(blocks[0].text, 'utf8') <= 128 * 1024);
    assert.equal(bounded.tree.children.length, 99, 'Source budget must not trim image-associated UI nodes');
    assert.equal(bounded.sourceEvidence.truncated, true);
    assert.ok(bounded.sourceEvidence.nodes.length < 100);
    assert.equal(bounded.sourceEvidence.coverage.evaluatedNodes, 100);
    assert.equal(bounded.sourceEvidence.coverage.returnedNodes, bounded.sourceEvidence.nodes.length);
    assert.equal(blocks[1].type, 'image');
    await fs.writeFile(path.join(root, 'view.xaml'), '<Button AutomationProperties.AutomationId="Save" Command="{Binding SaveCommand}"/>');
    await fs.writeFile(path.join(root, 'Model.cs'), 'public ICommand SaveCommand { get; }');
    const withCode = await client.callTool({ name: 'wincode_ui_review', arguments: {
      pid: 1, candidateFiles: ['view.xaml'], candidateCodeFiles: ['Model.cs'],
    } });
    const codeBlocks = withCode.content as Array<{ type: string; text: string }>;
    const clipped = JSON.parse(codeBlocks[0].text);
    assert.equal(withCode.isError, false);
    assert.equal(clipped.tree.children.length, 99);
    assert.equal(clipped.codeEvidence, undefined, 'C# metadata is omitted before existing UI/XAML evidence');
    assert.ok(Buffer.byteLength(codeBlocks[0].text, 'utf8') <= 128 * 1024);
    assert.equal(codeBlocks[1].type, 'image');
    router.inspectUi = async () => ({ schemaVersion: '1.0', protocolVersion: '1.0', requestId: 'small', success: true, tree: node(1, 'Save') });
    const small = await client.callTool({ name: 'wincode_ui_review', arguments: {
      pid: 1, candidateFiles: ['view.xaml'], candidateCodeFiles: ['Model.cs'],
    } });
    const mapped = JSON.parse((small.content as Array<{ text: string }>)[0].text);
    assert.equal(mapped.codeEvidence.clues[0].candidates[0].identifier, 'SaveCommand');
    assert.equal(mapped.codeEvidence.runtimeSourceVerified, false);
  } finally { await client.close(); await server.stop(); }
}));
