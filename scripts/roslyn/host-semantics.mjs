import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

/** verifySemantics: 使用同一自有会话，入口负责顺序、快照代次及最终清理。 */
export async function verifySemantics(ctx) {
  const { root, source, code, child, next, query, reload, assertStale, report, ready, burstQuery } = ctx;
  const timedOut = await query(source.indexOf('Save(int'), { timeoutMs: 1 });
  assert.equal(timedOut.success, false, 'cold semantic operation should exceed the 1 ms test budget');
  assert.equal(timedOut.errorCode, 'CANCELLED');
  report.scenarios.push('1 ms cold-query budget cancels without losing the session');
  const integers = await query(source.indexOf('Save(int'));
  assert.equal(integers.success, true, JSON.stringify(integers));
  assert.equal(integers.freshness.files, ready.freshness.files);
  assert.equal(integers.freshness.fingerprint, ready.freshness.fingerprint);
  assert.equal(integers.totalReferences, 2);
  assert.deepEqual(integers.references.map(r => r.line).sort((a, b) => a - b), [4, 7]);
  for (const reference of integers.references) {
    assert.equal(reference.file.replaceAll('\\', '/'), 'App/Use.cs');
    assert.equal(reference.column, 7);
    assert.equal(code['App/Use.cs'].slice(reference.start, reference.start + reference.length), 'Save');
  }
  report.scenarios.push('integer overload resolves exact cross-project call spans and columns');
  const strings = await query(source.indexOf('Save(string'));
  assert.equal(strings.success, true);
  assert.deepEqual(strings.references.map(r => r.line), [5]);
  report.scenarios.push('string overload excludes integer overload and same-name other type');
  const empty = await query(source.indexOf('Unused'));
  assert.equal(empty.success, true);
  assert.equal(empty.totalReferences, 0);
  report.scenarios.push('valid symbol with zero references remains successful bounded evidence');
  const repeated = await query(source.indexOf('Save(int'));
  assert.deepEqual(repeated.references, integers.references);
  report.metrics.push({ firstQueryMs: integers.queryMs, warmQueryMs: repeated.queryMs, workingSetBytes: repeated.workingSetBytes });
  report.scenarios.push('warm query reuses snapshot and preserves exact evidence');
  const truncated = await query(source.indexOf('Save(int'), { limit: 1 });
  assert.equal(truncated.totalReferences, 2);
  assert.equal(truncated.references.length, 1);
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.queryComplete, false);
  report.scenarios.push('output cap preserves total and marks incomplete');
  for (const [label, extra, errorCode] of [
    ['stale snapshot', { snapshot: 'stale' }, 'SNAPSHOT_STALE'], ['outside source', { file: '../outside.cs' }, 'OUTSIDE_WORKSPACE'],
    ['invalid position', { position: -1 }, 'INVALID_ARGUMENT'], ['wrong project context', { project: 'App/App.csproj' }, 'INVALID_ARGUMENT'],
    ['invalid time budget', { timeoutMs: 0 }, 'INVALID_ARGUMENT'],
    ['fractional position', { position: 1.5 }, 'INVALID_ARGUMENT'], ['fractional time budget', { timeoutMs: 1.5 }, 'INVALID_ARGUMENT'],
  ]) {
    const rejected = await query(source.indexOf('Save(int'), extra);
    assert.equal(rejected.success, false, label);
    assert.equal(rejected.errorCode, errorCode, label);
    report.scenarios.push(`${label} rejected`);
  }
}

/** verifyQueue: 使用同一自有会话，入口负责顺序、快照代次及最终清理。 */
export async function verifyQueue(ctx) {
  const { root, source, code, child, next, query, reload, assertStale, report, ready, burstQuery } = ctx;
  child.stdin.write(JSON.stringify({ id: 'cancel-target', operation: 'references', snapshot: ctx.snapshot,
    project: 'Lib/Lib.csproj', file: 'Lib/Api.cs', position: source.indexOf('Save(int') }) + '\n' +
    JSON.stringify({ id: 'cancel-control', operation: 'cancel', targetId: 'cancel-target' }) + '\n');
  const cancelled = new Map((await Promise.all([next(), next()])).map(result => [result.id, result]));
  assert.equal(cancelled.get('cancel-control').cancellationRequested, true);
  assert.equal(cancelled.get('cancel-target').errorCode, 'CANCELLED');
  assert.equal((await query(source.indexOf('Save(int'))).totalReferences, 2);
  report.scenarios.push('explicit cancellation reaches queued or active work without closing the session');

  // 单次突发同时检验身份冲突、排队截止和背压；每个输入都必须收到独立结果，不静默丢队列项。
  /** 构造当前夹具快照的引用请求，允许突发与 EOF 验收复用同一定位。 */

  // 到期的排队 reload 必须在触碰工作区前退出；若错误地到执行时才计时，会使后续旧身份查询失败。
  const burst = [burstQuery('burst-first'), burstQuery('burst-first'),
    { id: 'burst-deadline', operation: 'reload', timeoutMs: 1 },
    ...Array.from({ length: 16 }, (_, index) => burstQuery(`burst-${index}`))];
  child.stdin.write(burst.map(request => JSON.stringify(request)).join('\n') + '\n');
  const burstResults = await Promise.all(burst.map(() => next()));
  const duplicated = burstResults.filter(result => result.id === 'burst-first');
  assert.equal(duplicated.length, 2);
  assert.equal(duplicated.filter(result => result.errorCode === 'DUPLICATE_REQUEST').length, 1);
  assert.equal(duplicated.filter(result => result.success === true).length, 1);
  report.scenarios.push('duplicate active id is rejected without cancelling its original request');
  assert.equal(burstResults.find(result => result.id === 'burst-deadline').errorCode, 'CANCELLED');
  report.scenarios.push('expired queued reload is cancelled before invalidating the valid snapshot');
  assert.ok(burstResults.some(result => result.errorCode === 'BUSY'));
  for (const request of burst.slice(2)) assert.equal(burstResults.filter(result => result.id === request.id).length, 1);
  for (const result of burstResults) {
    if (result.success) assert.equal(result.totalReferences, 2);
    else assert.ok(['CANCELLED', 'BUSY', 'DUPLICATE_REQUEST'].includes(result.errorCode));
  }
  report.queue = { submitted: burst.length, completed: burstResults.filter(result => result.success).length,
    rejectedBusy: burstResults.filter(result => result.errorCode === 'BUSY').length };
  report.scenarios.push('bounded queue reports backpressure and accounts for every submitted frame');
  child.stdin.write(JSON.stringify({ id: 'cancel-missing', operation: 'cancel', targetId: 'absent-request' }) + '\n');
  assert.equal((await next()).cancellationRequested, false);
  assert.equal((await query(source.indexOf('Save(int'))).totalReferences, 2);
  report.scenarios.push('cancelling an absent request reports no cancellation and preserves the session');

}
