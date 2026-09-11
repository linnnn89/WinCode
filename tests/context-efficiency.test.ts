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
import { RefactorAssistant } from '../src/CompositeTools/RefactorAssistant.js';
import { ContextManager } from '../src/Core/Context.js';
import { WorkspaceManager } from '../src/Core/Workspace.js';
import { contextResponse } from '../src/Gateway/ContextResponse.js';

it('exclusive scope and exact line ranges avoid all workspace symbol queries', async () => {
  await fixture(async (_root, router, call) => {
    let queries = 0;
    router.text.findSymbolsDetailed = async () => { queries++; throw new Error('unexpected workspace query'); };
    const scoped = payload(await call({ task: 'Review SaveTarget behavior', scopeFiles: ['Service.ts'] })).data;
    assert.deepEqual(scoped.relatedFiles.map((f: any) => f.path), ['Service.ts']);
    const ranged = payload(await call({ task: 'Review SaveTarget behavior', lineRanges: [{ file: 'Service.ts', startLine: 50, endLine: 50 }] })).data;
    assert.equal(ranged.evidence[0].startLine, 50);
    assert.equal(ranged.evidence[0].endLine, 50);
    assert.equal(ranged.evidence[0].locationKind, 'line-range');
    assert.match(ranged.evidence[0].snippet, /TARGET_BODY/);
    assert.equal(queries, 0);
  });
});

it('scoped symbol lookup preserves local fallback limits and rejects ambiguity', async () => {
  await fixture(async (root, router, call) => {
    router.text.findSymbolsDetailed = async () => { throw new Error('unexpected workspace query'); };
    const args = { task: 'Review target', scopeFiles: ['Service.ts'], symbol: 'SaveTarget' };
    const unique = payload(await call(args)).data;
    assert.equal(unique.evidence[0].symbol, 'SaveTarget');
    assert.equal(unique.evidence[0].line, 50);
    assert.equal(unique.queryComplete, false);
    assert.ok(unique.limitations.some((s: string) => s.includes('not semantic')));
    await fs.appendFile(path.join(root, 'Service.ts'), '\nexport function SaveTarget() {}');
    const duplicate = payload(await call(args)).data;
    assert.equal(duplicate.evidence.length, 0);
    assert.ok(duplicate.fileIssues.some((i: any) => i.reason === 'ambiguous-symbol:2'));
    const missing = payload(await call({ ...args, symbol: 'MissingTarget' })).data;
    assert.equal(missing.evidence.length, 0);
    assert.ok(missing.fileIssues.some((i: any) => i.reason === 'symbol-not-found'));
    await fs.writeFile(path.join(root, 'Other.ts'), 'export function SaveTarget() {}');
    const multiple = payload(await call({ ...args, scopeFiles: ['Service.ts', 'Other.ts'] })).data;
    assert.equal(multiple.evidence.length, 0);
  });
});

it('precise retrieval validates scope and ranges before any workspace query', async () => {
  await fixture(async (_root, router, call) => {
    let queries = 0;
    router.text.findSymbolsDetailed = async () => { queries++; return { symbols: [] } as any; };
    for (const options of [
      { scopeFiles: [] },
      { scopeFiles: ['Service.ts'], candidateFiles: ['Other.ts'] },
      { scopeFiles: ['Service.ts'], focusAreas: ['.'] },
      { symbol: 'SaveTarget' },
      { lineRanges: [{ file: '../outside.ts', startLine: 1, endLine: 2 }] },
      { lineRanges: [{ file: 'Service.ts', startLine: 2, endLine: 1 }] },
      { lineRanges: [{ file: 'Service.ts', startLine: 1, endLine: 501 }] },
      { lineRanges: [{ file: 'Service.ts', startLine: 1, endLine: 2 }], includeFullText: true },
      { scopeFiles: ['Other.ts'], lineRanges: [{ file: 'Service.ts', startLine: 1, endLine: 2 }] },
      { lineRanges: [{ file: 'Service.ts', startLine: 1, endLine: 2 }, { file: './Service.ts', startLine: 3, endLine: 4 }] },
    ]) assert.equal((await call({ task: 'Review SaveTarget', ...options })).isError, true, JSON.stringify(options));
    assert.equal(queries, 0);
    const out = payload(await call({ task: 'Review range', lineRanges: [{ file: 'Service.ts', startLine: 90, endLine: 91 }] })).data;
    assert.equal(out.evidence.length, 0);
    assert.equal(out.fileIssues[0].reason, 'line-range-out-of-bounds');
  });
});

it('precise retrieval remains bounded after response serialization', async () => {
  await fixture(async (root, _router, call) => {
    await fs.writeFile(path.join(root, 'Long.ts'), Array.from({ length: 200 }, (_, i) => `// ${i + 1}: ${'x'.repeat(100)}`).join('\n'));
    for (const responseFormat of ['compact', 'legacy']) {
      const data = payload(await call({ task: 'Review', lineRanges: [{ file: 'Long.ts', startLine: 80, endLine: 150 }], maxTokens: 512, responseFormat })).data;
      assert.equal(data.evidence[0].startLine, 80);
      assert.ok(data.evidence[0].endLine < 150);
      assert.equal(data.evidence[0].truncated, true);
      assert.equal(data.truncated, true);
    }
  });
});

async function fixture(run: (root: string, router: ToolRouter, call: (args: Record<string, unknown>, name?: string) => Promise<any>) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-context-'));
  const config = getDefaultConfig(root);

  config.adapters.flaui.enabled = false;
  const router = new ToolRouter(config);
  const server = new WinCodeMcpServer(router);
  const client = new Client({ name: 'context-efficiency-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await fs.writeFile(path.join(root, 'package.json'), '{"name":"isolated-context-fixture"}');
    await fs.writeFile(path.join(root, 'Service.ts'), Array.from({ length: 90 }, (_, i) =>
      i === 49 ? 'export function SaveTarget() { return "TARGET_BODY"; }' : `// fixture line ${i + 1}`).join('\n'));
    router.text.findSymbolsDetailed = async () => ({ symbols: [], limitations: [], queryComplete: true } as any);
    await Promise.all([client.connect(clientTransport), (server as any).server.connect(serverTransport)]);
    await run(root, router, (args, name = 'wincode_prepare_context') => client.callTool({ name, arguments: args }));
  } finally {
    await client.close();
    await server.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
}

function payload(result: any) {
  assert.ok(!result.isError, JSON.stringify(result));
  const texts = result.content.map((c: any) => c.text as string);
  const data = JSON.parse(texts[0]);
  const length = texts.reduce((n: number, text: string) => n + text.length, 0);
  assert.equal(data.metrics.totalCharacters, length, 'count every returned text block, including metrics');
  assert.equal(data.metrics.estimatedTokens, Math.ceil(length / 4));
  assert.equal(data.metrics.tokenEstimation, 'characters-divided-by-4');
  assert.ok(length <= data.metrics.budgetTokens * 4, `response ${length} exceeds total character budget`);
  return { data, texts };
}

it('scoped navigation finds a literal call, outlines its file and follows source without reading outside links', async t => fixture(async (root, _router, call) => {
  await fs.mkdir(path.join(root, 'src'));
  const source = 'public class Session {\n public void Save() {\n Cache[0].Save("marker");\n }\n}';
  await fs.writeFile(path.join(root, 'src/Session.cs'), source);
  await fs.writeFile(path.join(root, 'Decoy.cs'), 'Cache[0].Save("OUT_OF_SCOPE");');
  const decode = (result: any) => {
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  const found = decode(await call({ query: 'Cache[0].Save(', scopePaths: ['src', 'src/Session.cs'] }, 'wincode_search_text'));
  assert.equal(found.queryComplete, true);
  assert.equal(found.matches.length, 1, 'overlapping scopes must not duplicate matches');
  assert.equal(found.matches[0].file, 'src/Session.cs');
  assert.equal(found.matches[0].line, 3);
  assert.equal(found.matches[0].column, 2);
  assert.ok(!JSON.stringify(found).includes('OUT_OF_SCOPE'));
  const read = payload(await call(found.matches[0].nextRequest)).data;
  assert.equal(read.evidence[0].snippet, source);
  const outline = decode(await call({ file: path.join(root, 'src/Session.cs') }, 'wincode_file_outline'));
  assert.equal(outline.fileLineCount, 5);
  assert.equal(outline.sizeBytes, Buffer.byteLength(source));
  assert.deepEqual(outline.symbols.map((s: any) => [s.name, s.line]), [['Session', 1], ['Save', 2]]);
  const method = payload(await call(outline.symbols[1].nextRequest)).data;
  assert.ok(method.evidence[0].snippet.includes('public void Save()'));
  const none = decode(await call({ query: 'Cache0XSave(', scopePaths: ['src'] }, 'wincode_search_text'));
  assert.equal(none.matches.length, 0, 'query metacharacters must be literal');
  await fs.writeFile(path.join(root, 'src/Broken.ts'), 'const text = `unterminated');
  const broken = decode(await call({ file: 'src/Broken.ts' }, 'wincode_file_outline'));
  assert.equal(broken.fileLineCount, 1);
  assert.equal(broken.queryComplete, false);
  assert.ok(broken.fileIssues.some((i: any) => i.path === 'src/Broken.ts' && i.reason === 'lexical-uncertainty'));
  await fs.writeFile(path.join(root, 'src/Large.cs'), 'x'.repeat(256 * 1024 + 1));
  const external = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-navigation-outside-'));
  try {
    await fs.writeFile(path.join(external, 'Secret.cs'), 'Cache[0].Save("MUST_NOT_READ");');
    await fs.symlink(external, path.join(root, 'src/linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const opened: string[] = [];
    const realOpen = fs.open;
    const open = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      opened.push(String(args[0]));
      return realOpen(...args);
    });
    const linked = decode(await call({ query: 'Cache[0].Save(', scopePaths: ['src/linked'] }, 'wincode_search_text'));
    assert.equal(linked.queryComplete, false);
    assert.ok(linked.fileIssues.some((i: any) => i.reason === 'invalid-scope'));
    assert.ok(!opened.some(file => file.startsWith(external)), 'an outside file must never be opened');
    opened.length = 0;
    const invalid = await call({ query: 'Cache', scopePaths: ['src', '../outside'] }, 'wincode_search_text');
    assert.equal(invalid.isError, true);
    assert.equal(opened.length, 0, 'all scopes must validate before any file is opened');
    open.mock.restore();
    const boundedResult = await call({ query: 'x', scopePaths: ['src'], maxOutputChars: 2048 }, 'wincode_search_text');
    const bounded = decode(boundedResult);
    assert.ok(boundedResult.content[0].text.length <= 2048);
    assert.equal(bounded.queryComplete, false);
    assert.ok(bounded.fileIssues.some((i: any) => i.path === 'src/Large.cs' && i.reason === 'file-byte-limit'));
  } finally {
    assert.equal(path.dirname(external), path.resolve(os.tmpdir()));
    await fs.rm(external, { recursive: true, force: true });
  }
}));

it('compact MCP response returns file evidence once and accounts for its entire output', async () => fixture(async (_root, _router, call) => {
  const { data, texts } = payload(await call({ task: '查看文件', candidateFiles: ['Service.ts'], maxTokens: 2000 }));
  assert.equal(texts.length, 1);
  assert.equal(data.evidence.length, 1);
  assert.equal(data.evidence[0].startLine, 1);
  assert.equal(data.evidence[0].endLine, 24);
  assert.equal(texts[0].split('fixture line 5\\n').length - 1, 1);
  assert.equal(data.evidence[0].locationKind, 'file-start');
}));

it('legacy MCP response preserves two blocks while budgeting both', async () => fixture(async (_root, _router, call) => {
  const { texts } = payload(await call({ task: '查看文件', candidateFiles: ['Service.ts'], maxTokens: 2000, responseFormat: 'legacy' }));
  assert.equal(texts.length, 2);
  assert.ok(texts[1].includes('AI Agent Context Snapshot'));
}));

it('512-token budget remains valid with JSON escaping, Unicode and long task metadata', async () => fixture(async (root, _router, call) => {
  await fs.writeFile(path.join(root, 'Escapes.ts'), '"\\\t中文🧪'.repeat(1000));
  for (const responseFormat of ['compact', 'legacy']) {
    const { data } = payload(await call({ task: '中文问题'.repeat(500), candidateFiles: ['Escapes.ts'], maxTokens: 512, responseFormat }));
    assert.equal(data.truncated, true);
    assert.ok(data.omittedFiles.length > 0 || data.evidence.some((e: any) => e.truncated));
  }
}));

it('full-text mode returns a packed body once and explicitly reports budget truncation', async () => fixture(async (_root, router, call) => {
  router.repomix.packWorkspace = async () => ({ content: 'PACKED_UNIQUE_BODY\n' + 'x'.repeat(14000), fileCount: 1,
    totalCharacters: 14019, fromCache: false, source: 'builtin-fallback' });
  const { data, texts } = payload(await call({ task: '查看全文', candidateFiles: ['Service.ts'], includeFullText: true, maxTokens: 2000 }));
  assert.equal(texts[0].split('PACKED_UNIQUE_BODY').length - 1, 1);
  assert.equal(data.truncated, true);
  assert.ok(data.packedContent.startsWith('PACKED_UNIQUE_BODY'));
  assert.ok(data.evidence.every((e: any) => !e.snippet));
}));

it('an empty pack cannot masquerade as full-text evidence', async () => fixture(async (_root, router, call) => {
  router.repomix.packWorkspace = async () => ({ content: '# No files', fileCount: 0,
    totalCharacters: 10, fromCache: false, source: 'builtin-fallback' });
  const { data } = payload(await call({ task: '查看全文', candidateFiles: ['Service.ts'], includeFullText: true, maxTokens: 2000 }));
  assert.equal(data.evidenceInsufficient, true);
  assert.equal(data.truncated, true);
  assert.equal(data.packedContent, '');
}));

it('compact and legacy retain identical evidence with sufficient budget', async t => fixture(async (_root, _router, call) => {
  const request = { task: '查看文件', candidateFiles: ['Service.ts'], maxTokens: 4000 };
  const compact = payload(await call(request));
  const legacy = payload(await call({ ...request, responseFormat: 'legacy' }));
  assert.deepEqual(compact.data.evidence, legacy.data.evidence);
  assert.deepEqual(compact.data.limitations, legacy.data.limitations);
  assert.ok(compact.data.metrics.totalCharacters < legacy.data.metrics.totalCharacters);
  t.diagnostic(`Same fixture/evidence: compact=${compact.data.metrics.totalCharacters} characters; legacy=${legacy.data.metrics.totalCharacters} characters (not measured model tokens).`);
}));

it('unsupported focus globs and malformed options fail before any search', async () => fixture(async (_root, router, call) => {
  let searches = 0;
  router.text.findSymbolsDetailed = async () => { searches++; throw new Error('unexpected search'); };
  for (const extra of [{ focusAreas: ['src/*.ts'] }, { candidateFiles: ['../outside.ts'] },
    { candidateFiles: [42] }, { maxTokens: -1 }, { maxTokens: 1.5 }, { responseFormat: 'typo' }, { includeFullText: 'true' }]) {
    const result = await call({ task: 'SaveTarget', ...extra });
    assert.equal(result.isError, true, JSON.stringify(extra));
  }
  assert.equal(searches, 0);
}));

it('missing files and empty focus directories have distinct evidence issues', async () => fixture(async (root, _router, call) => {
  await fs.mkdir(path.join(root, 'empty'));
  const { data } = payload(await call({ task: '查看文件', candidateFiles: ['missing.ts'], focusAreas: ['empty'], maxTokens: 2000 }));
  assert.equal(data.evidenceInsufficient, true);
  assert.ok(data.fileIssues.some((e: any) => e.path === 'missing.ts' && e.reason === 'not-found'));
  assert.ok(data.fileIssues.some((e: any) => e.path === 'empty' && e.reason === 'no-matching-files'));
}));

it('small budgets disclose omitted metadata and retain the full omitted-file count', async () => fixture(async (_root, _router, call) => {
  const files = Array.from({ length: 20 }, (_, i) => `${i}-${'missing'.repeat(25)}.ts`);
  const { data } = payload(await call({ task: '查看文件', candidateFiles: files, maxTokens: 512 }));
  assert.equal(data.metadataTruncated, true);
  assert.equal(data.truncated, true);
  assert.equal(data.evidenceInsufficient, true);
  assert.equal(data.omittedFileCount, 20);
  assert.ok(data.omittedFiles.length < 20);
}));

it('missing-candidate metadata cannot evict a small useful body', async () => fixture(async (root, _router, call) => {
  await fs.writeFile(path.join(root, 'Service.ts'), 'export const READY_EVIDENCE = true;');
  const { data } = payload(await call({task:'查看实现',candidateFiles:['Service.ts', ...Array.from({length:19}, (_, i) => `Missing_${i}_${'module'.repeat(10)}.ts`)],maxTokens:512}));
  assert.ok(data.evidence.some((item: any) => item.snippet.includes('READY_EVIDENCE')));
  assert.equal(data.evidenceInsufficient, false);
  assert.equal(data.metadataTruncated, true);
}));

it('a prefix ending exactly at the declaration newline still returns the declaration', async () => fixture(async (root, router, call) => {
  await fs.writeFile(path.join(root,'Boundary.ts'), ['//intro', ...Array(8).fill('//'+'x'.repeat(497)), 'export function SaveTarget(){ return "TARGET_BODY"; }'].join('\n'));
  router.text.findSymbolsDetailed = async () => ({symbols:[{name:'SaveTarget',file:'Boundary.ts',line:10,kind:'function'}], queryComplete:true, limitations:[]} as any);
  const {data} = payload(await call({task:'SaveTarget',candidateFiles:['Boundary.ts'],maxTokens:8000}));
  assert.ok(data.evidence[0].snippet.includes('TARGET_BODY'));
  assert.equal(data.evidence[0].startLine,10);
}));

it('a workspace opened through a junction supports both file and directory focus', async () => fixture(async (root) => {
  const physical = path.join(root,'physical');
  const alias = path.join(root,'alias');
  await fs.mkdir(physical);
  await fs.writeFile(path.join(physical,'Service.ts'),'export const ALIAS_EVIDENCE = true;');
  await fs.symlink(physical,alias,'junction');
  const config = getDefaultConfig(alias);
  const manager = new ContextManager(config,new WorkspaceManager(config),null as any, {findSymbolsDetailed:async()=>({symbols:[],queryComplete:true,limitations:[]})} as any);
  for (const area of ['.','Service.ts']) {
    const data = await manager.prepareContext({task:'查看实现',focusAreas:[area],maxTokens:2000});
    assert.equal(data.evidence.length,1);
    assert.equal(data.fileIssues.length,0);
    assert.equal(data.evidence[0].file,'Service.ts');
  }
}));

it('actual packed counts and returned file bodies stay distinct under partial packing', async () => fixture(async (root,router,call) => {
  await fs.writeFile(path.join(root,'Second.ts'),'SECOND_BODY');
  const content='FIRST_BODY';
  router.repomix.packWorkspace=async()=>({content,fileCount:1,totalCharacters:content.length,fromCache:false,source:'builtin-fallback',fileSpans:[{file:'Service.ts',start:0,end:content.length}]});
  const {data}=payload(await call({task:'查看全文',candidateFiles:['Service.ts','Second.ts'],includeFullText:true,maxTokens:4000}));
  assert.equal(data.metrics.packedFiles,1);
  assert.equal(data.metrics.returnedFiles,1);
  assert.equal(data.relatedFiles.find((item:any)=>item.path==='Second.ts').included,false);
  assert.equal(data.relatedFiles.find((item:any)=>item.path==='Second.ts').bodyStatus,'omitted');
  assert.ok(data.omittedFiles.includes('Second.ts'));
}));

it('packed body spans remain correct after escaping and final prefix clipping', async () => fixture(async (_root,router) => {
  for (const format of ['markdown','xml'] as const) {
    const packed=await router.repomix.packWorkspace({candidateFiles:['Service.ts'],outputFormat:format});
    const span=packed.fileSpans![0];
    assert.ok(packed.content.slice(span.start,span.end).includes('TARGET_BODY'));
    const ctx=await router.context.prepareContext({task:'查看全文',candidateFiles:['Service.ts'],includeFullText:true,maxTokens:8000});
    ctx.packedContent=packed.content.slice(0,span.start);
    ctx.packedFileSpans=packed.fileSpans;
    const {data}=payload(contextResponse(ctx));
    assert.equal(data.metrics.returnedFiles,0);
    assert.equal(data.evidenceInsufficient,true);
    assert.equal(data.relatedFiles[0].included,false);
  }
}));

it('matched symbol, reason and actual source range refer to the same target', async () => fixture(async (_root, router, call) => {
  router.text.findSymbolsDetailed = async () => ({ queryComplete: true, limitations: [], symbols: [
    { name: 'UnrelatedOptions', file: 'Service.ts', line: 2, kind: 'interface' },
    { name: 'SaveTarget', file: 'Service.ts', line: 50, kind: 'function' },
  ] } as any);
  const { data } = payload(await call({ task: 'SaveTarget', candidateFiles: ['Service.ts'], maxTokens: 2000 }));
  const evidence = data.evidence[0];
  assert.equal(evidence.symbol, 'SaveTarget');
  assert.equal(evidence.line, 50);
  assert.equal(evidence.startLine, 42);
  assert.equal(evidence.endLine, 65);
  assert.equal(evidence.reason, 'symbol SaveTarget');
  assert.ok(evidence.snippet.includes('TARGET_BODY'));
}));

it('long preceding lines cannot crowd the matched declaration out of a clipped snippet', async () => fixture(async (root, router, call) => {
  await fs.writeFile(path.join(root, 'Service.ts'), Array.from({ length: 70 }, (_, i) =>
    i === 49 ? 'export function SaveTarget() { return "TARGET_BODY"; }' : '// ' + 'x'.repeat(800)).join('\n'));
  router.text.findSymbolsDetailed = async () => ({ queryComplete: true, limitations: [], symbols: [
    { name: 'SaveTarget', file: 'Service.ts', line: 50, kind: 'function' },
  ] } as any);
  const { data } = payload(await call({ task: 'SaveTarget', candidateFiles: ['Service.ts'], maxTokens: 512 }));
  assert.equal(data.evidence.length, 1);
  assert.ok(data.evidence[0].snippet.includes('TARGET_BODY'));
  assert.equal(data.evidence[0].startLine, 50);
}));

it('out-of-workspace junction candidates are reported and never packed', async () => fixture(async (root, router, call) => {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-context-outside-'));
  try {
    await fs.writeFile(path.join(outside, 'private.ts'), 'OUTSIDE_SECRET');
    await fs.symlink(outside, path.join(root, 'link'), 'junction');
    router.repomix.packWorkspace = async () => { throw new Error('Must not pack outside paths'); };
    const { data, texts } = payload(await call({ task: '查看全文', candidateFiles: ['link/private.ts'], includeFullText: true, maxTokens: 2000 }));
    assert.equal(data.evidenceInsufficient, true);
    assert.ok(data.fileIssues.some((item: any) => item.reason === 'outside-workspace'));
    assert.ok(!texts.join('').includes('OUTSIDE_SECRET'));
  } finally { await fs.rm(outside, { recursive: true, force: true }); }
}));

it('file truncation keeps exact displayed line ranges and incomplete query warnings', async () => fixture(async (root, router, call) => {
  await fs.writeFile(path.join(root, 'Large.ts'), Array.from({ length: 80 }, (_, i) => `// ${i + 1} ${'字'.repeat(400)}`).join('\n'));
  router.text.findSymbolsDetailed = async () => ({ symbols: [], queryComplete: false, limitations: ['Semantic query timed out.'] } as any);
  const { data } = payload(await call({ task: 'LargeTarget', candidateFiles: ['Large.ts'], maxTokens: 512 }));
  assert.equal(data.queryComplete, false);
  assert.ok(data.limitations.includes('Semantic query timed out.'));
  for (const evidence of data.evidence) {
    assert.equal(evidence.endLine, evidence.startLine + evidence.snippet.split('\n').length - 1);
    assert.equal(evidence.truncated, true);
  }
}));

it('focus directory cap counts added files, not previously selected candidates', async () => fixture(async (root, _router, call) => {
  await fs.mkdir(path.join(root, 'focus'));
  for (let i = 0; i < 10; i++) await fs.writeFile(path.join(root, 'focus', `${i}.ts`), `// ${i}`);
  const { data } = payload(await call({ task: '查看文件', candidateFiles: ['Service.ts'], focusAreas: ['focus'], maxTokens: 8000 }));
  assert.equal(data.relatedFiles.filter((e: any) => e.reason === 'focusAreas').length, 8);
  assert.ok(data.fileIssues.some((e: any) => e.reason === 'selection-limit'));
}));

it('refactoring retains uncertainty and gives a disambiguation step without prescribing an interface', async () => {
  const report = { referencesCount: 0, affectedFiles: [], riskLevel: 'UNKNOWN', riskReason: 'Duplicate types',
    confidence: 'UNCERTAIN', source: 'local-text', uniqueResolution: false, queryComplete: true,
    limitations: ['Text retrieval does not prove symbol identity.'], matchedSymbols: [
      { name: 'Service', file: 'a.ts', line: 1 }, { name: 'Service', file: 'b.ts', line: 2 }], recommendations: [] };
  const assistant = new RefactorAssistant(null as any, { analyzeImpact: async () => report } as any);
  const plan = await assistant.planRefactoring('Service', '简化条件判断');
  assert.equal(plan.evidence.riskLevel, 'UNKNOWN');
  assert.deepEqual(plan.evidence.limitations, report.limitations);
  assert.ok(plan.recommendedSteps.some(step => /a.ts|b.ts/.test(step)));
  assert.ok(!plan.recommendedSteps.some(step => /Extract Interface|Create an abstraction|zero regression/.test(step)));
});

it('refactoring with usable evidence names affected files and validates only the requested change', async () => {
  const report = { referencesCount: 2, affectedFiles: ['Caller.ts'], riskLevel: 'MEDIUM', riskReason: 'Two calls',
    confidence: 'HIGH', source: 'roslyn', uniqueResolution: true, queryComplete: true,
    limitations: [], matchedSymbols: [], recommendations: [] };
  const assistant = new RefactorAssistant(null as any, { analyzeImpact: async () => report } as any);
  const plan = await assistant.planRefactoring('Service', '简化条件判断');
  assert.ok(plan.recommendedSteps.some(step => step.includes('Caller.ts')));
  assert.ok(plan.recommendedSteps.some(step => step.includes('简化条件判断')));
  assert.ok(!plan.recommendedSteps.some(step => step.includes('Extract Interface')));
});
