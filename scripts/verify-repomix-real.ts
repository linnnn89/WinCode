import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import cp from 'node:child_process';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { RepomixAdapter } from '../src/Adapters/RepomixAdapter.js';
import { CacheManager } from '../src/Core/Cache.js';
import { getDefaultConfig } from '../src/Core/Config.js';
import { withTimeout } from '../src/Core/ResourceManager.js';
import { WorkspaceWatch } from '../src/Core/WorkspaceWatch.js';

// Opt-in real package acceptance. No installation, network packing or user files.
const [entry] = process.argv.slice(2);
assert.ok(entry && path.isAbsolute(entry), 'Provide an absolute installed Repomix JavaScript entry');
await fs.access(entry);
const parent = path.resolve('test-tmp/repomix-acceptance');
await fs.mkdir(parent, { recursive: true });
const root = await fs.mkdtemp(path.join(parent, '中文 & (real)-'));
// Isolate Git ignore discovery from the parent repository's test-tmp exclusion.
cp.execFileSync('git', ['init', '--quiet', root], { windowsHide: true });
await fs.writeFile(path.join(root, 'A.ts'), 'export function alpha(value: number) { return value + 1; }\n');
await fs.writeFile(path.join(root, 'B.ts'), 'export const beta = "ONLY_B_CONTENT";\n');
await fs.mkdir(path.join(root, 'trash'));
await fs.writeFile(path.join(root, 'trash/Hidden.ts'), 'DO_NOT_PACK_TRASH');
const config = getDefaultConfig(root);
config.adapters.repomix.useCli = true;
config.adapters.repomix.customCliPath = entry;
const cache = new CacheManager(config.cacheDir);
await cache.initialize();
const adapter = new RepomixAdapter(config, cache);
const children: cp.ChildProcess[] = [];
const originalSpawn = cp.spawn;
cp.spawn = ((...args: any[]) => {
  const child = (originalSpawn as any)(...args) as cp.ChildProcess;
  children.push(child); return child;
}) as typeof cp.spawn;
syncBuiltinESMExports();
const report: any = { entry, root, node: process.version, stages: [], success: false };
async function stage(name: string, run: () => Promise<unknown>) {
  const start = Date.now();
  try { const result = await run(); report.stages.push({ name, passed: true, ms: Date.now() - start, result }); }
  catch (error) { report.stages.push({ name, passed: false, error: String(error) }); throw error; }
}
try {
  await stage('installed package handshake', async () => {
    await adapter.initialize();
    const health = await adapter.checkHealth();
    assert.equal(health.source, 'installed'); assert.equal(health.available, true);
    return health;
  });
  for (const outputFormat of ['markdown', 'xml', 'plain'] as const) {
    await stage(`${outputFormat} bodies, include scope and file count`, async () => {
      const result = await adapter.packWorkspace({ include: ['*.ts'], outputFormat });
      report.lastPack = result;
      assert.equal(result.source, 'repomix-cli'); assert.equal(result.fileCount, 2);
      assert.ok(result.content.includes('alpha')); assert.ok(result.content.includes('ONLY_B_CONTENT'));
      assert.ok(!result.content.includes('DO_NOT_PACK_TRASH'));
      assert.equal(result.totalCharacters, result.content.length);
      return result;
    });
  }
  await stage('real compression retains selected declaration', async () => {
    const result = await adapter.packWorkspace({ include: ['A.ts'], compress: true });
    assert.equal(result.source, 'repomix-cli'); assert.ok(result.content.includes('alpha'));
    assert.ok(!result.content.includes('ONLY_B_CONTENT')); return result;
  });
  await stage('empty selection remains zero files', async () => {
    const result = await adapter.packWorkspace({ include: ['missing/**/*.ts'] });
    assert.equal(result.source, 'repomix-cli'); assert.equal(result.fileCount, 0);
    return result;
  });
  await stage('cache invalidates after a source edit', async () => {
    const options = { include: ['A.ts'] };
    const first = await adapter.packWorkspace(options);
    const cached = await adapter.packWorkspace(options);
    assert.equal(cached.fromCache, true); assert.equal(cached.content, first.content);
    const watcher = new WorkspaceWatch();
    let notify!: () => void;
    const invalidated = new Promise<void>(resolve => { notify = resolve; });
    watcher.start(root, () => { cache.invalidateFingerprint(root); notify(); });
    try {
      assert.equal(watcher.getStatus().active, true);
      await fs.appendFile(path.join(root, 'A.ts'), 'export const changedEvidence = 17;\n');
      await withTimeout(invalidated, 5000, 'real-repomix-file-watch');
      const changed = await adapter.packWorkspace(options);
      assert.equal(changed.fromCache, false); assert.ok(changed.content.includes('changedEvidence'));
      return { cacheHit: true, changed };
    } finally { await watcher.stop(); }
  });
  await stage('explicit candidate set keeps builtin closed scope', async () => {
    const before = children.length;
    const result = await adapter.packWorkspace({ candidateFiles: ['A.ts'] });
    assert.equal(result.source, 'builtin-fallback'); assert.equal(children.length, before);
    assert.ok(!result.content.includes('ONLY_B_CONTENT')); return result;
  });
  await stage('cancel a started real CLI process and remove output', async () => {
    const controller = new AbortController();
    const before = children.length;
    const pending = adapter.packWorkspace({ include: ['B.ts'], outputFormat: 'xml', compress: true }, { signal: controller.signal });
    const rejected = assert.rejects(pending, /abort|cancel/i);
    const entered = async () => {
      while (children.length === before && !controller.signal.aborted) await new Promise(resolve => setTimeout(resolve, 10));
    };
    try { await withTimeout(entered(), 5000, 'real-repomix-entry'); }
    finally { controller.abort(); }
    await rejected;
    assert.equal(adapter.activeProcessCount, 0);
    const child = children[before];
    if (child.exitCode === null && child.signalCode === null)
      await withTimeout(once(child, 'close'), 5000, 'real-repomix-close-event');
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    return { cancelledPid: child.pid };
  });
  await stage('real CLI startup timeout reports fallback and cleans process', async () => {
    config.timeouts.repomixPackMs = 1;
    const result = await adapter.packWorkspace({ include: ['B.ts'], outputFormat: 'plain', compress: true });
    assert.equal(result.source, 'builtin-fallback'); assert.equal(adapter.lastError?.reason, 'timeout');
    assert.equal(adapter.activeProcessCount, 0);
    return { source: result.source, lastError: adapter.lastError };
  });
  report.success = true;
} catch (error) { report.error = String(error); process.exitCode = 1; }
finally {
  try { await adapter.dispose(); }
  catch (error) { report.cleanupError = String(error); report.success = false; process.exitCode = 1; }
  cp.spawn = originalSpawn; syncBuiltinESMExports();
  report.children = children.map(child => ({ pid: child.pid, exited: child.exitCode !== null || child.signalCode !== null }));
  report.temporaryOutputs = await fs.readdir(path.join(config.cacheDir, 'repomix_tmp')).catch(() => []);
  if (report.children.some((child: any) => !child.exited) || report.temporaryOutputs.length) {
    report.success = false; process.exitCode = 1;
  }
  const reportFile = path.join(root, 'report.json');
  await fs.writeFile(reportFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ reportFile, success: report.success, stages: report.stages.map(({ name, passed }: any) => ({ name, passed })), error: report.error }));
}
