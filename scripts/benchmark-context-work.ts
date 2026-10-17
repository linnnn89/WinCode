/** Local, model-free paired experiment through real MCP handlers and in-memory transport. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { getDefaultConfig } from '../src/Core/Config.js';
import { ToolRouter } from '../src/Core/ToolRouter.js';
import { ContextManager } from '../src/Core/Context.js';
import { OperationMetrics } from '../src/Core/OperationMetrics.js';
import { WinCodeMcpServer } from '../src/Gateway/McpServer.js';

const root = path.resolve(import.meta.dirname, '..');
const mode = process.argv[2] ?? 'baseline';
const repetitions = Number(process.argv[3] ?? 5);
if (!['baseline', 'compare'].includes(mode) || !Number.isInteger(repetitions) || repetitions < 1 || repetitions > 100 || process.argv.length > 5)
  throw new Error('Usage: tsx scripts/benchmark-context-work.ts [baseline|compare] [1-100 repetitions] [existing workspace]');
const output = path.join(root, 'test-tmp', 'context-work', `${Date.now()}-${process.pid}`);
await fs.mkdir(output, { recursive: true });
const workspace = process.argv[4] ? path.resolve(process.argv[4]) : path.join(output, 'fixture');
if (!process.argv[4]) {
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, 'package.json'), '{"name":"context-work-fixture"}');
  for (let i = 0; i < 96; i++) {
    await fs.writeFile(path.join(workspace, `Service${String(i).padStart(3, '0')}.ts`),
      ['Alpha', 'Bravo', 'Charlie', 'Delta'].map(name => `export function ${name}${i}() { return '${name}-${i}'; }`).join('\n') +
      '\n' + Array.from({ length: 32 }, (_, n) => `// padding ${n} ${'x'.repeat(64)}`).join('\n'));
  }
  await fs.writeFile(path.join(workspace, 'Overflow.ts'), Array.from({ length: 510 }, (_, i) => `export function Overflow${i}() {}`).join('\n'));
}
const words = process.argv[4] ? ['ContextManager', 'LocalTextAdapter', 'OperationContext', 'scanLocalFiles'] : ['Alpha', 'Bravo', 'Charlie', 'Delta'];
const cases = [1, 2, 4].map(n => ({ id: `${n}-keywords`, args: { task: words.slice(0, n).join(' '), maxTokens: 8000 } as Record<string, unknown> }));
cases.push({ id: 'known-range', args: { task: 'Read exact source', lineRanges: [{ file: process.argv[4] ? 'src/Core/OperationContext.ts' : 'Service000.ts', startLine: 1, endLine: 4 }], maxTokens: 8000 } });
cases.push({ id: '4-keywords-fulltext', args: { task: words.join(' '), includeFullText: true, maxTokens: 16000 } });
if (!process.argv[4]) cases.push({ id: 'result-limit', args: { task: 'Overflow NoSuchSymbol', maxTokens: 8000 } });
const variants = mode === 'compare' ? ['sequential', 'batch'] : ['sequential'];
const samples: Array<Record<string, any>> = [];
const sourceFiles = ['scripts/benchmark-context-work.ts', 'src/Core/Context.ts', 'src/Core/LocalTextScanner.ts',
  'src/Core/OperationContext.ts', 'src/Core/OperationMetrics.ts', 'src/Adapters/LocalTextAdapter.ts', 'src/Adapters/RepomixAdapter.ts', 'src/Core/CodeQueries.ts'];
const hashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file =>
  [file, createHash('sha256').update(await fs.readFile(path.join(root, file))).digest('hex')])));
const sourceHashes = await hashes();
const listInputs = async () => process.argv[4] ? execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { cwd: workspace, encoding: 'utf8', windowsHide: true }).split('\0').filter(Boolean) : await fs.readdir(workspace);
const inputHash = async () => {
  const hash = createHash('sha256');
  for (const file of (await listInputs()).sort()) { hash.update(file + '\0'); hash.update(createHash('sha256').update(await fs.readFile(path.join(workspace, file))).digest()); }
  return hash.digest('hex');
};
const workspaceHash = await inputHash();
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();

async function run(variant: string, state: string, args: Record<string, unknown>) {
  const config = getDefaultConfig(workspace);
  config.cacheDir = path.join(output, `cache-${samples.length}-${variant}`);
  config.adapters.flaui.enabled = false;
  config.adapters.repomix.useCli = false;
  if (config.adapters.roslyn) config.adapters.roslyn.enabled = false;
  const router = new ToolRouter(config);
  if (variant === 'sequential') router.context = new ContextManager(config, router.workspace, router.repomix, router.text, { batchSymbols: false });
  let metrics: OperationMetrics | undefined;
  const prepare = router.context.prepareContext.bind(router.context);
  router.context.prepareContext = async (options, operation) => {
    const end = metrics?.start('context.total');
    try { return await prepare(options, { ...operation, metrics }); } finally { end?.(); }
  };
  const server = new WinCodeMcpServer(router);
  const client = new Client({ name: 'context-work-benchmark', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await router.initialize();
    await Promise.all([client.connect(ct), (server as any).server.connect(st)]);
    if (state === 'warm') assert.notEqual((await client.callTool({ name: 'wincode_prepare_context', arguments: args })).isError, true);
    metrics = new OperationMetrics();
    const begin = performance.now();
    const response = await client.callTool({ name: 'wincode_prepare_context', arguments: args });
    const elapsedMs = performance.now() - begin;
    const responseFile = `response-${samples.length}-${variant}.json`;
    await fs.writeFile(path.join(output, responseFile), JSON.stringify(response, null, 2));
    assert.notEqual(response.isError, true);
    const text = (response.content as { type: string; text: string }[]).find(block => block.type === 'text')!.text;
    const data = JSON.parse(text);
    assert.ok(data.evidence.length > 0, 'Expected usable source evidence.');
    for (const item of data.evidence) {
      assert.ok(!path.isAbsolute(item.file) && !item.file.split(/[\\/]/).includes('..'));
      const source = await fs.readFile(path.join(workspace, item.file), 'utf8');
      if (args.includeFullText) {
        if (item.bodyStatus === 'complete') assert.ok(data.packedContent.includes(source), 'Complete packed file must contain the independently read source.');
        else if (item.bodyStatus === 'partial') {
          const marker = `File: ${item.file}\n${'='.repeat(48)}\n`;
          const index = data.packedContent.indexOf(marker);
          assert.ok(index >= 0, 'Partial packed file must have an observed boundary.');
          assert.ok(source.startsWith(data.packedContent.slice(index + marker.length)), 'Partial packed body must be a source prefix.');
        } else assert.equal(item.bodyStatus, 'omitted');
        continue;
      }
      const lines = source.split(/\r?\n/);
      const actual = lines.slice(item.startLine - 1, item.endLine).join('\n');
      assert.ok(item.snippet === actual || (item.truncated && actual.startsWith(item.snippet)), 'Evidence must match independent file read.');
    }
    if (!process.argv[4]) assert.equal(data.queryComplete, args.task !== 'Overflow NoSuchSymbol');
    const keywordCount = String(args.task).split(' ').length;
    if (!args.lineRanges && variant === 'sequential') assert.equal(metrics.counters['scan.invocations'], keywordCount, 'Benchmark keywords must survive production stopword filtering.');
    return { elapsedMs, responseFile, responseBytes: Buffer.byteLength(text), responseHash: createHash('sha256').update(text).digest('hex'),
      queryComplete: data.queryComplete, truncated: data.truncated, counters: metrics.counters, phases: metrics.phases };
  } finally { await client.close(); await server.stop(); }
}

const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2; };
let failure: string | undefined;
try {
  for (let repeat = 0; repeat < repetitions; repeat++) for (const testCase of cases) for (const state of ['first', 'warm']) {
    const pair: typeof samples = [];
    for (const variant of repeat % 2 ? [...variants].reverse() : variants) {
      const sample = { case: testCase.id, state, variant, repeat, ...await run(variant, state, testCase.args) };
      samples.push(sample); pair.push(sample);
    }
    if (pair.length === 2) assert.equal(pair[0].responseHash, pair[1].responseHash, `Response mismatch: ${testCase.id}/${state}`);
  }
} catch (error) { failure = error instanceof Error ? error.stack : String(error); }
const summaries = cases.flatMap(c => ['first', 'warm'].flatMap(state => variants.map(variant => {
  const rows = samples.filter(s => s.case === c.id && s.state === state && s.variant === variant);
  const names = [...new Set(rows.flatMap(s => Object.keys(s.counters)))];
  const phases = [...new Set(rows.flatMap(s => Object.keys(s.phases)))];
  return { case: c.id, state, variant, samples: rows.length, medianMs: rows.length ? median(rows.map(s => s.elapsedMs)) : null,
    counters: Object.fromEntries(names.map(n => [n, median(rows.map(s => s.counters[n] ?? 0))])),
    phaseMs: Object.fromEntries(phases.map(n => [n, median(rows.map(s => s.phases[n]?.elapsedMs ?? 0))])) };
})));
const sourcesUnchanged = JSON.stringify(sourceHashes) === JSON.stringify(await hashes());
const inputsUnchanged = workspaceHash === await inputHash();
const report = { revision, sourceHashes, sourcesUnchanged, workspaceHash, inputsUnchanged, mode, repetitions, workspace, node: process.version, failure,
  methodology: { transport: 'in-memory MCP; actual router, handlers, local-text and serialization; no model, UIA or network',
    timing: 'callTool wall time; initialization, prewarm, oracle reads and cleanup excluded. first means fresh application cache, not cold OS disk cache.',
    counters: 'scan.* covers LocalTextScanner only; bytesRead are bytes returned by FileHandle.read, not physical disk IO. context decoded bytes exclude project discovery and packer IO.',
    phases: 'Inclusive and potentially nested; do not sum. Response hashes must match within each pair; fixture evidence checked against independent source reads.',
    samples: 'Repeated fixed tasks; no population or P95 claim. Existing workspace input must remain unchanged during measurement.' }, summaries, samples };
await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ report: path.join(output, 'report.json'), sourcesUnchanged, inputsUnchanged, failure, summaries }, null, 2));
if (failure || !sourcesUnchanged || !inputsUnchanged) process.exitCode = 1;
