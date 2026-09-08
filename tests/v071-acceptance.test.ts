import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mapUiSources } from '../src/Core/UiSourceMapper.js';
import { FlaUiAdapter } from '../src/Adapters/FlaUiAdapter.js';
import { getDefaultConfig } from '../src/Core/Config.js';
import { WorkspaceWatch } from '../src/Core/WorkspaceWatch.js';

it('coverage distinguishes missing identifiers, clipped identifiers, syntax gaps and partial scans', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-coverage-'));
  try {
    await fs.writeFile(path.join(root, 'View.xaml'), `<Grid>
      <Button AutomationProperties.AutomationId="Save"/>
      <Button AutomationProperties.AutomationId="Save"/>
      <Button AutomationProperties.AutomationId="{Binding Id}"/>
      <Button><AutomationProperties.AutomationId>Other</AutomationProperties.AutomationId></Button>
      <!-- <Button AutomationProperties.AutomationId="{Binding Ignored}"/> -->
    </Grid>`);
    const tree = { id: 1, parentId: null, children: [undefined, 'x'.repeat(256), 'Save', 'Other', 'a&b'].map((automationId, i) =>
      ({ id: i + 2, parentId: 1, automationId, children: [] })) };
    const result = await mapUiSources(root, ['View.xaml'], tree);
    assert.deepEqual(result.nodes.map(n => n.reason), [
      'missing-automation-id', 'missing-automation-id', 'possibly-truncated-id',
      'multiple-literal-candidates', 'no-literal-match-with-unsupported-declarations', 'unsupported-id-value',
    ]);
    assert.deepEqual(result.coverage, { evaluatedNodes: 6, returnedNodes: 6, nodesWithAutomationId: 4, matchedNodes: 1 });
    assert.deepEqual(result.declarationCoverage, { literalIds: 2, unsupportedDeclarations: 2 });
    const partial = await mapUiSources(root, ['View.xaml', 'missing.xaml'], tree);
    assert.equal(partial.nodes[4].reason, 'incomplete-file-scan');
    await fs.writeFile(path.join(root, 'Empty.xaml'), '<Grid/>');
    const empty = await mapUiSources(root, ['Empty.xaml'], tree);
    assert.equal(empty.nodes[4].reason, 'no-literal-match');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('cached health retains a recent inspection timeout and runtime status does not spawn helpers', async () => {
  const adapter = new FlaUiAdapter(getDefaultConfig(process.cwd()));
  const requests: string[] = [];
  (adapter as any).executeHost = async (request: { action?: string }) => {
    requests.push(request.action ?? 'inspect');
    return { success: true, status: 'healthy' };
  };
  await adapter.checkHealth();
  (adapter as any).inspectOnce = async () => ({ success: false, errorCode: 'TIMEOUT', errorMessage: 'queued deadline' });
  await adapter.inspect({ pid: 1 });
  const health = await adapter.checkHealth();
  assert.equal(health.available, true);
  assert.equal(health.lastError?.reason, 'timeout');
  assert.match(health.lastError?.message ?? '', /queued deadline/);
  assert.equal(adapter.getRuntimeStatus().activePid, null);
  assert.deepEqual(requests, ['health']);
  await adapter.dispose();
  assert.equal((await adapter.checkHealth()).available, false);
});

it('cleanup failure stays observable after dispose rejects', async () => {
  const adapter = new FlaUiAdapter(getDefaultConfig(process.cwd()));
  (adapter as any).cleanupActive = async () => false;
  await assert.rejects(adapter.dispose(), /exit is not confirmed/);
  assert.match(adapter.getRuntimeStatus().lastError?.message ?? '', /cleanup timed out/);
  assert.equal(adapter.getRuntimeStatus().shuttingDown, true);
});

it('watch start failure is observable without a retry loop or leaked watcher', () => {
  const watch = new WorkspaceWatch();
  watch.start(path.join(os.tmpdir(), 'absent-watch-' + Date.now()), () => {});
  const first = watch.getStatus();
  assert.equal(first.active, false);
  assert.ok(first.lastError?.at);
  assert.ok(first.lastError?.message);
  watch.stop();
  assert.deepEqual(watch.getStatus(), first, 'Stop must not erase failure history');
});

it('watching an alias uses its canonical directory and still reports changes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-watch-alias-'));
  const target = path.join(root, 'target');
  const alias = path.join(root, 'alias');
  const watch = new WorkspaceWatch();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await fs.mkdir(target);
    await fs.symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const expected = fsSync.realpathSync.native(alias);
    const original = fsSync.watch;
    t.mock.method(fsSync, 'watch', (watched: any, ...args: any[]) => {
      assert.equal(watched, expected, 'native watching must not receive an unresolved path alias');
      return (original as any)(watched, ...args);
    });
    const changed = new Promise<void>((resolve, reject) => {
      deadline = setTimeout(() => reject(new Error('No file-change notification')), 4000);
      watch.start(alias, resolve, 10);
    });
    assert.equal(watch.getStatus().active, true);
    assert.equal(watch.activeRoot, path.resolve(alias), 'status preserves the requested workspace identity');
    await fs.writeFile(path.join(target, 'probe.txt'), 'changed');
    await changed;
    watch.stop();
    assert.equal(watch.getStatus().active, false);
  } finally {
    if (deadline) clearTimeout(deadline);
    watch.stop();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  }
});
