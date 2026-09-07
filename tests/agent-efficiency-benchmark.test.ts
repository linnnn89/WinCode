import { it } from 'node:test';
import assert from 'node:assert/strict';
import { EvidenceOverlap, runBenchmark, validateEvidence, writeBenchmarkReport } from '../scripts/benchmark-agent-efficiency.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';

it('evidence overlap distinguishes partial overlaps, changed content and different files', () => {
  const overlap = new EvidenceOverlap();
  overlap.add([{ file: 'A.ts', startLine: 10, snippet: 'alpha\nbeta\ngamma\n' }]);
  overlap.add([{ file: 'A.ts', startLine: 11, snippet: 'beta\nchanged\ndelta' }]);
  overlap.add([{ file: 'B.ts', startLine: 10, snippet: 'alpha\nbeta\ngamma' }]);
  assert.equal(overlap.lines, 9);
  assert.equal(overlap.repeatedLines, 1);
});

it('benchmark rejects unbounded repetition counts before creating fixtures', async () => {
  for (const value of [0, 6, NaN, 1.5]) await assert.rejects(runBenchmark(value), /repetitions/);
});

it('evidence validation rejects wrong files, ranges, stale bodies and inconsistent states', () => {
  const sources = new Map([['A.ts', 'before\nconst target = 2;\nafter']]);
  const args = { lineRanges: [{ file: 'A.ts', startLine: 2, endLine: 2 }] };
  const good = { evidence: [{ file: 'A.ts', startLine: 2, endLine: 2, snippet: 'const target = 2;', truncated: false }],
    fileIssues: [], queryComplete: true, evidenceInsufficient: false };
  assert.equal(validateEvidence(good, sources, args), null);
  for (const [change, expected] of [
    [{ startLine: 999999, endLine: 999999 }, 'invalid-range'],
    [{ file: 'Other.ts' }, 'wrong-evidence-file'],
    [{ snippet: 'const target = 1;' }, 'stale-or-wrong-body'],
    [{ startLine: 1, endLine: 1, snippet: 'before' }, 'outside-requested-range'],
    [{ line: 3, symbol: 'target' }, 'invalid-symbol-location'],
  ] as const) assert.equal(validateEvidence({ ...good, evidence: [{ ...good.evidence[0], ...change }] }, sources, args), expected);
  assert.equal(validateEvidence({ ...good, evidenceInsufficient: true }, sources, args), 'inconsistent-evidence-status');
  assert.equal(validateEvidence(good, sources, { scopeFiles: ['A.ts'], symbol: 'target' }), 'invalid-scoped-query-status');
  assert.equal(validateEvidence({ ...good, fileIssues: [{ path: 'Other.ts', reason: 'symbol-not-found' }] }, sources, args), 'wrong-issue-file');
});

it('faults fail individual cases, preserve a report and do not prevent later cases', async () => {
  let count = 0;
  let corruptedIssue = false;
  let staleBody = false;
  const report = await runBenchmark(1, { callTool: async (client, args) => {
    const index = ++count;
    if (index === 3) throw new Error('injected transport timeout');
    if (index === 4) return { isError: true, content: [{ type: 'text', text: 'injected tool error' }] };
    const result: any = await client.callTool({ name: 'wincode_prepare_context', arguments: args });
    if (index === 2) { result.content[0].text = '{broken'; return result; }
    const data = JSON.parse(result.content[0].text);
    if (index === 1) data.evidence[0].startLine = 999999;
    else if (!corruptedIssue && data.fileIssues.length) { data.fileIssues[0].path = 'Other.ts'; corruptedIssue = true; }
    else if (!staleBody && data.evidence.length) { data.evidence[0].snippet = data.evidence[0].snippet.replace(/[^\n]/, 'X'); staleBody = true; }
    else return result;
    result.content[0].text = JSON.stringify(data);
    return result;
  } });
  assert.equal(report.results.length, 20);
  assert.ok(report.results.at(-1)!.success);
  const errors = report.results.flatMap(row => row.errors);
  for (const phase of ['transport-error', 'tool-error', 'invalid-response']) assert.ok(errors.some(error => error.phase === phase));
  for (const message of ['invalid-range', 'wrong-issue-file', 'stale-or-wrong-body']) assert.ok(errors.some(error => error.message === message), message);
  assert.ok(corruptedIssue && staleBody);
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-report-test-'));
  try {
    assert.equal(await writeBenchmarkReport(report, output), 1);
    const saved = JSON.parse(await fs.readFile(path.join(output, 'report.json'), 'utf8'));
    assert.equal(saved.results.length, 20);
    assert.ok(saved.results.some((row: any) => row.success));
    assert.ok(saved.results.some((row: any) => !row.success));
  } finally { await fs.rm(output, { recursive: true, force: true }); }
});

it('trusted no-change reuse reduces calls but a controlled edit always refreshes evidence', async () => {
  const report = await runBenchmark(1);
  assert.ok(report.results.every(row => row.success));
  const row = (id: string, policy: string) => report.results.find(item => item.case === id && item.policy === policy)!;
  assert.equal(row('repeat-unchanged', 'candidate-first').mcpCalls, 2);
  assert.equal(row('repeat-unchanged', 'precise-first').mcpCalls, 1);
  assert.equal(row('repeat-unchanged', 'precise-first').reusedEvidence, 1);
  for (const policy of ['candidate-first', 'precise-first']) {
    const changed = row('read-after-edit', policy);
    assert.equal(changed.mcpCalls, 2);
    assert.equal(changed.reusedEvidence, 0);
    assert.ok(changed.actions.some(action => action.action === 'request' && action.revision === 1));
  }
  assert.equal(report.results.filter(item => item.case.startsWith('csharp-')).length, 8);
});

it('cleanup failure stays visible and remaining scenarios still run', async () => {
  const original = Client.prototype.close;
  let first = true;
  try {
    Client.prototype.close = async function () {
      await original.call(this);
      if (first) { first = false; throw new Error('injected close failure'); }
    };
    const report = await runBenchmark(1);
    assert.equal(report.results[0].success, false);
    assert.ok(report.results[0].errors.some(error => error.phase === 'client-close'));
    assert.ok(report.results.slice(1).every(row => row.success));
  } finally { Client.prototype.close = original; }
});
