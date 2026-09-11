import { it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ToolRouter, WorkspaceRecoveryRequiredError } from '../src/Core/ToolRouter.js';
import { getDefaultConfig } from '../src/Core/Config.js';
import { GatewayRestartRequiredError, ResourceManager } from '../src/Core/ResourceManager.js';
import { RoslynAdapter } from '../src/Adapters/RoslynAdapter.js';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
function adapterFixture() {
  const config = getDefaultConfig(process.cwd());
  config.adapters.roslyn = { enabled: true, allowProjectEvaluation: true, project: 'App.csproj', configuration: 'Debug', targetFramework: 'net10.0',
    dotnetPath: process.execPath, hostPath: path.resolve('fixture.dll') };
  const resources = new ResourceManager();
  return { adapter: new RoslynAdapter(config, resources, () => []), resources };
}

it('manual release keeps the adapter reusable, invalidates old locations and preserves the last error', async () => {
  const { adapter } = adapterFixture();
  const state = adapter as any;
  let closed = 0;
  state.client = { active: true, close: async () => { closed++; } };
  state.snapshot = 'a'.repeat(32);
  state.lastError = { message: 'earlier failure', reason: 'error', at: new Date().toISOString(), recoverable: true };
  assert.equal(await adapter.releaseWarmState(), 'released');
  assert.equal(closed, 1);
  assert.equal(state.disposed, false);
  assert.equal(adapter.getKnownHealth().snapshotId, null);
  assert.equal(adapter.getKnownHealth().health?.lastError?.message, 'earlier failure');
  assert.throws(() => state.validateLocation({ snapshotId: 'a'.repeat(32), project: 'App.csproj', file: 'Api.cs', position: 13 }), /expired/);
  assert.equal(await adapter.releaseWarmState(), 'already-cold');
  await adapter.dispose();
});

it('release refuses an active operation including its asynchronous cleanup', async () => {
  const { adapter } = adapterFixture();
  const active = deferred(), cleanup = deferred();
  const operation = (adapter as any).perform(undefined, async () => { active.resolve(); await cleanup.promise; });
  await active.promise;
  assert.equal(await adapter.releaseWarmState(), 'busy');
  cleanup.resolve(); await operation;
  assert.equal(await adapter.releaseWarmState(), 'already-cold');
  await adapter.dispose();
});

it('release checks admission again after waiting for the adapter lock', async () => {
  const { adapter } = adapterFixture();
  const blocked = deferred();
  let closed = false, allowed = true;
  (adapter as any).client = { active: true, close: async () => { closed = true; } };
  const hold = (adapter as any).lock.runExclusive(() => blocked.promise);
  const release = adapter.releaseWarmState(() => allowed);
  allowed = false; blocked.resolve(); await hold;
  assert.equal(await release, 'busy');
  assert.equal(closed, false);
  await adapter.dispose();
});

it('memory status is passive and default policy never creates an automatic release timer', async () => {
  const router = new ToolRouter(getDefaultConfig(process.cwd()));
  (router.cache as any).getStats = () => { throw new Error('Storage enumeration is forbidden'); };
  try {
    assert.equal(router.getMemoryControlStatus().automaticRelease, false);
    assert.equal((await router.releaseRoslynMemory()).status, 'not-configured');
    assert.equal(router.resources.childProcessCount(), 0);
  } finally { await router.dispose(); }
});

it('settings release refuses MCP work and direct code operations without queuing a later release', async () => {
  const router = new ToolRouter(getDefaultConfig(process.cwd()));
  let releases = 0;
  router.roslyn = { releaseWarmState: async () => { releases++; return 'released'; }, dispose: async () => {} } as any;
  router.beginRequest();
  assert.equal((await router.releaseRoslynMemory()).status, 'busy');
  router.endRequest();
  const active = deferred();
  const work = (router as any).runCode(undefined, () => active.promise);
  assert.equal((await router.releaseRoslynMemory()).status, 'busy');
  active.resolve(); await work;
  assert.equal(releases, 0);
  await router.dispose();
});

it('an arriving MCP request waits for an accepted manual release and then proceeds', async () => {
  const router = new ToolRouter(getDefaultConfig(process.cwd()));
  const entered = deferred(), close = deferred();
  router.roslyn = { releaseWarmState: async () => { entered.resolve(); await close.promise; return 'released'; }, dispose: async () => {} } as any;
  const release = router.releaseRoslynMemory(); await entered.promise;
  let admitted = false;
  const request = router.acquireRequestSlot().then(() => { admitted = true; router.endRequest(); });
  await Promise.resolve(); assert.equal(admitted, false);
  close.resolve(); assert.equal((await release).status, 'released'); await request;
  assert.equal(admitted, true);
  await router.dispose();
});

it('a queued workspace confirmation wins over a settings release', async () => {
  const router = new ToolRouter(getDefaultConfig(process.cwd()));
  const gate = deferred(), controller = new AbortController();
  const lock = (router as any).workspaceLock.runExclusive(() => gate.promise);
  const switching = router.openWorkspace(process.cwd(), {}, controller.signal);
  const settled = switching.catch(error => error);
  assert.equal((await router.releaseRoslynMemory()).status, 'busy');
  controller.abort(); gate.resolve(); await lock; await settled;
  await router.dispose();
});

it('failed manual cleanup enters the sticky recovery gate and cannot be retried as a release', async () => {
  const router = new ToolRouter(getDefaultConfig(process.cwd()));
  let releases = 0;
  router.roslyn = { releaseWarmState: async () => { releases++; throw new GatewayRestartRequiredError([new Error('close failed')], 'Close failed'); }, dispose: async () => {} } as any;
  assert.equal((await router.releaseRoslynMemory()).status, 'recovery-required');
  assert.equal(router.workspaceRecoveryState?.recoveryAction, 'restart_gateway');
  await assert.rejects(router.acquireRequestSlot(), WorkspaceRecoveryRequiredError);
  assert.equal((await router.releaseRoslynMemory()).status, 'recovery-required');
  assert.equal(releases, 1);
  await router.dispose();
});
