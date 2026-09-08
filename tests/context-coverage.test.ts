import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getDefaultConfig } from '../src/Core/Config.js';
import { WorkspaceManager } from '../src/Core/Workspace.js';
import { ContextManager, PreparedContextResult } from '../src/Core/Context.js';
import { contextResponse } from '../src/Gateway/ContextResponse.js';

async function fixture(run: (root: string, manager: ContextManager) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-context-coverage-'));
  try {
    await fs.writeFile(path.join(root, 'package.json'), '{"name":"coverage-fixture"}');
    const config = getDefaultConfig(root);
    const serena = {
      findSymbolsDetailed: async () => ({ symbols: [], limitations: [], queryComplete: true }),
      findSymbolsInContent: (source: string, file: string) => source.split('\n').flatMap((line, index) =>
        line.includes('function SaveTarget(') ? [{ name: 'SaveTarget', file, line: index + 1, kind: 'function' }] : []),
    };
    const manager = new ContextManager(config, new WorkspaceManager(config), null as any, serena as any);
    await run(root, manager);
  } finally {
    assert.equal(path.dirname(root), os.tmpdir());
    await fs.rm(root, { recursive: true, force: true });
  }
}

function response(context: PreparedContextResult, format: 'compact' | 'legacy' = 'compact') {
  const result = contextResponse(context, format);
  const data = JSON.parse(result.content[0].text);
  const characters = result.content.reduce((total, item) => total + item.text.length, 0);
  assert.ok(characters <= context.metrics.budgetTokens * 4);
  assert.equal(data.metrics.totalCharacters, characters);
  assert.equal(data.requestedLineRanges, undefined, 'internal coordinates must not leak as duplicate output');
  assert.equal(data.taskCoverage, null);
  return data;
}

it('a long symbol is a complete displayed snippet, not a complete method, with bounded continuation', async () => fixture(async (root, manager) => {
  const lines = ['export function SaveTarget() {', ...Array.from({ length: 110 }, (_, i) => `  // body ${i}`), '  return "TAIL_ERROR_HANDLER";', '}'];
  await fs.writeFile(path.join(root, 'Long.ts'), lines.join('\n'));
  for (const format of ['compact', 'legacy'] as const) {
    const data = response(await manager.prepareContext({ task: 'Review error handling', scopeFiles: ['Long.ts'], symbol: 'SaveTarget', maxTokens: 4000 }), format);
    assert.equal(data.bodyStatusScope, 'displayed-snippet');
    assert.equal(data.relatedFiles[0].bodyStatus, 'complete');
    assert.equal(data.evidence[0].symbolCoverage, 'unknown');
    assert.equal(data.coverage, null);
    assert.ok(!data.evidence[0].snippet.includes('TAIL_ERROR_HANDLER'));
    const next = data.evidence[0].nextRequest;
    assert.equal(next.lineRanges[0].startLine, data.evidence[0].endLine + 1);
    assert.ok(next.lineRanges[0].endLine - next.lineRanges[0].startLine < 80);
    const continued = response(await manager.prepareContext(next));
    assert.equal(continued.evidence[0].snippet, lines.slice(next.lineRanges[0].startLine - 1, next.lineRanges[0].endLine).join('\n'));
    assert.equal(continued.coverage.allRequestedCovered, true);
  }
}));

it('symbol continuation includes a clipped tail and never suggests ranges past EOF', async () => fixture(async (root, manager) => {
  await fs.writeFile(path.join(root, 'Long.ts'), 'export function SaveTarget() {\n' + Array.from({ length: 60 }, () => '  // ' + 'x'.repeat(200)).join('\n') + '\n}');
  const data = response(await manager.prepareContext({ task: 'Read method', scopeFiles: ['Long.ts'], symbol: 'SaveTarget', maxTokens: 1000 }));
  const e = data.evidence[0];
  assert.equal(e.truncated, true);
  assert.equal(e.nextRequest.lineRanges[0].startLine, e.endLine + (e.endLineComplete ? 1 : 0));
  assert.ok(e.nextRequest.lineRanges[0].endLine <= e.fileLineCount);
  await fs.writeFile(path.join(root, 'Short.ts'), 'export function SaveTarget() {}');
  const short = response(await manager.prepareContext({ task: 'Read method', scopeFiles: ['Short.ts'], symbol: 'SaveTarget', maxTokens: 2000 }));
  assert.equal(short.evidence[0].symbolCoverage, 'unknown');
  assert.equal(short.evidence[0].nextRequest, undefined);
}));

it('an adequately budgeted 223-line request returns the entire range beyond the old 4000-character cap', async () => fixture(async (root, manager) => {
  const lines = Array.from({ length: 250 }, (_, index) => `// source line ${index + 1}: ${'x'.repeat(40)}`);
  await fs.writeFile(path.join(root, 'Long.ts'), lines.join('\n'));
  for (const format of ['compact', 'legacy'] as const) {
    const context = await manager.prepareContext({ task: 'Read exact source', lineRanges: [{ file: 'Long.ts', startLine: 10, endLine: 232 }], maxTokens: 16000 });
    const before = structuredClone(context);
    const data = response(context, format);
    assert.deepEqual(context, before, 'serialization must not mutate the original request or evidence');
    assert.equal(data.evidence[0].snippet, lines.slice(9, 232).join('\n'));
    assert.equal(data.evidence[0].endLineComplete, true);
    assert.equal(data.coverage.requestedLines, 223);
    assert.equal(data.coverage.completeLines, 223);
    assert.equal(data.coverage.completeItems, 1);
    assert.equal(data.coverage.allRequestedCovered, true);
    assert.deepEqual(data.coverage.details[0].requested, { startLine: 10, endLine: 232 });
    assert.deepEqual(data.coverage.details[0].missingRanges, []);
  }
}));

it('a partially displayed first line never counts as a fully covered line at the minimum budget', async () => fixture(async (root, manager) => {
  await fs.writeFile(path.join(root, 'Wide.ts'), `// ${'x'.repeat(12000)}`);
  for (const format of ['compact', 'legacy'] as const) {
    const context = await manager.prepareContext({ task: 'Read source', lineRanges: [{ file: 'Wide.ts', startLine: 1, endLine: 1 }], maxTokens: 512 });
    const data = response(context, format);
    assert.equal(data.coverage.allRequestedCovered, false);
    assert.equal(data.coverage.completeLines, 0);
    assert.equal(data.truncated, true);
    for (const item of data.evidence) assert.equal(item.endLineComplete, false);
    assert.equal(data.coverage.requestedItems, 1);
    assert.equal(data.coverage.omittedItemCount + data.coverage.details.length, 1);
  }
}));

it('clipping at a newline distinguishes a complete previous line from an empty prefix of the next line', async () => fixture(async (root, manager) => {
  for (const firstLineLength of [2047, 2048]) {
    await fs.writeFile(path.join(root, 'Boundary.ts'), `${'x'.repeat(firstLineLength)}\nTAIL`);
    const context = await manager.prepareContext({ task: 'Read source', lineRanges: [{ file: 'Boundary.ts', startLine: 1, endLine: 2 }], maxTokens: 512 });
    assert.equal(context.evidence[0].endLine, firstLineLength === 2047 ? 2 : 1);
    assert.equal(context.evidence[0].endLineComplete, firstLineLength === 2048);
    // Retain the initial read for an independent serializer-boundary assertion.
    context.metrics.budgetTokens = 4000;
    const data = response(context);
    const detail = data.coverage.details[0];
    assert.equal(data.coverage.completeLines, 1);
    assert.deepEqual(detail.completeRanges, [{ startLine: 1, endLine: 1 }]);
    assert.deepEqual(detail.missingRanges, [{ startLine: 2, endLine: 2, reason: 'source-budget' }]);
    assert.deepEqual(detail.nextRequest.lineRanges, [{ file: 'Boundary.ts', startLine: 2, endLine: 2 }]);
  }
}));

it('serializer clipping recomputes coverage and duplicate evidence cannot double-count lines', async () => fixture(async (root, manager) => {
  await fs.writeFile(path.join(root, 'Body.ts'), Array.from({ length: 100 }, (_, index) => `// ${index + 1} ${'y'.repeat(80)}`).join('\n'));
  const context = await manager.prepareContext({ task: 'Read source', lineRanges: [{ file: 'Body.ts', startLine: 1, endLine: 100 }], maxTokens: 8000 });
  const full = response(context);
  assert.equal(full.coverage.completeLines, 100);
  context.evidence.push(structuredClone(context.evidence[0]));
  assert.equal(response(context).coverage.completeLines, 100);
  context.evidence.pop();
  context.metrics.budgetTokens = 1500;
  const clipped = response(context);
  assert.equal(clipped.coverage.allRequestedCovered, false);
  assert.ok(clipped.coverage.completeLines < 100);
  const item = clipped.evidence[0];
  if (item) assert.equal(clipped.coverage.completeLines, item.endLine - item.startLine + (item.endLineComplete ? 1 : 0));
  const gap = clipped.coverage.details[0];
  assert.ok(gap, 'a small actionable gap should survive body clipping');
  assert.equal(gap.missingRanges[0].reason, 'response-budget');
  assert.equal(gap.nextRequest.lineRanges[0].startLine, gap.missingRanges[0].startLine);
  if (!item.endLineComplete) assert.ok(gap.nextRequest.maxTokens > context.metrics.budgetTokens);
}));

it('budget-dropped file bodies remain missing in the original multi-file coverage totals', async () => fixture(async (root, manager) => {
  const ranges = Array.from({ length: 8 }, (_, index) => ({ file: `File-${index}.ts`, startLine: 1, endLine: 1 }));
  for (const range of ranges) await fs.writeFile(path.join(root, range.file), '// ' + 'x'.repeat(100));
  const context = await manager.prepareContext({ task: 'Read source', lineRanges: ranges, maxTokens: 8000 });
  assert.equal(context.evidence.length, 8);
  context.metrics.budgetTokens = 512;
  const data = response(context);
  assert.ok(data.evidence.length < 8);
  assert.ok(data.coverage.missingItems > 0);
  assert.equal(data.coverage.requestedItems, 8);
  assert.equal(data.coverage.completeItems + data.coverage.partialItems + data.coverage.missingItems, 8);
  assert.equal(data.coverage.allRequestedCovered, false);
}));

it('a long-line retry raises its budget and stops suggesting the same request at the maximum', async () => fixture(async (root, manager) => {
  await fs.writeFile(path.join(root, 'VeryWide.ts'), 'x'.repeat(300000));
  const range = { file: 'VeryWide.ts', startLine: 1, endLine: 1 };
  const small = response(await manager.prepareContext({ task: 'Read source', lineRanges: [range], maxTokens: 2000 }));
  assert.equal(small.coverage.completeLines, 0);
  assert.equal(small.coverage.details[0].nextRequest.maxTokens, 4000);
  const maximum = response(await manager.prepareContext({ task: 'Read source', lineRanges: [range], maxTokens: 65536 }));
  assert.equal(maximum.coverage.allRequestedCovered, false);
  assert.equal(maximum.coverage.details[0].nextRequest, undefined);
  assert.equal(maximum.coverage.details[0].retryBlockedReason, 'maximum-budget-without-progress');
}));

it('EOF and missing-file requests retain their original gap reasons and do not propose blind retries', async () => fixture(async (root, manager) => {
  await fs.writeFile(path.join(root, 'Short.ts'), 'one\ntwo\nthree');
  const context = await manager.prepareContext({ task: 'Read source', lineRanges: [
    { file: 'Short.ts', startLine: 2, endLine: 5 },
    { file: 'Missing.ts', startLine: 1, endLine: 2 },
  ], maxTokens: 8000 });
  const data = response(context);
  assert.equal(data.coverage.missingItems, 2);
  assert.equal(data.coverage.requestedLines, 6);
  assert.equal(data.coverage.completeLines, 0);
  assert.equal(data.coverage.allRequestedCovered, false);
  assert.equal(data.coverage.details[0].missingRanges[0].reason, 'line-range-out-of-bounds');
  assert.equal(data.coverage.details[1].missingRanges[0].reason, 'not-found');
  assert.ok(data.coverage.details.every((detail: any) => detail.nextRequest === undefined));
}));

it('coverage totals survive pruning of multi-file request details and error metadata', async () => fixture(async (_root, manager) => {
  const ranges = Array.from({ length: 8 }, (_, index) => ({ file: `Missing-${index}-${'detail'.repeat(25)}.ts`, startLine: 1, endLine: 10 }));
  const context = await manager.prepareContext({ task: 'Read source', lineRanges: ranges, maxTokens: 512 });
  const data = response(context);
  assert.equal(data.metadataTruncated, true);
  assert.equal(data.coverage.requestedItems, 8);
  assert.equal(data.coverage.missingItems, 8);
  assert.equal(data.coverage.requestedLines, 80);
  assert.equal(data.coverage.completeLines, 0);
  assert.ok(data.coverage.omittedItemCount > 0);
  assert.equal(data.coverage.omittedItemCount + data.coverage.details.length, 8);
  assert.equal(data.coverage.allRequestedCovered, false);
}));

it('symbol and file excerpts do not claim whole-method or task coverage', async () => fixture(async (root, manager) => {
  await fs.writeFile(path.join(root, 'Service.ts'), ['export function SaveTarget() {', ...Array(80).fill('  // long body'), '}'].join('\n'));
  for (const options of [{ scopeFiles: ['Service.ts'], symbol: 'SaveTarget' }, { scopeFiles: ['Service.ts'] }]) {
    const data = response(await manager.prepareContext({ task: 'Read source', ...options, maxTokens: 8000 }));
    assert.ok(data.evidence.length > 0);
    assert.equal(data.coverage, null);
    assert.equal(data.taskCoverage, null);
  }
}));
