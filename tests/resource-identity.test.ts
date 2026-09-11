import { it } from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { ResourceManager, killProcessTree } from '../src/Core/ResourceManager.js';

it('cleanup does not invoke a resource unregistered while an earlier disposer is pending', async () => {
  const resources = new ResourceManager();
  let calls = 0, entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const id = resources.register('disposable', 'already-released', () => { calls++; });
  resources.register('disposable', 'barrier', async () => { entered(); await gate; });
  const cleanup = resources.dispose();
  await started;
  resources.unregister(id);
  release();
  await cleanup;
  assert.equal(calls, 0);
  assert.deepEqual(resources.getCloseReport().results.map(item => item.owner), ['barrier']);
  assert.equal(resources.list().length, 0);
});

it('unregister also wins before the queued disposer microtask starts', async () => {
  const resources = new ResourceManager();
  let calls = 0;
  const id = resources.register('disposable', 'released-before-entry', () => { calls++; });
  const cleanup = resources.dispose();
  resources.unregister(id);
  await cleanup;
  assert.equal(calls, 0);
  assert.deepEqual(resources.getCloseReport().results, []);
});

it('an exited child identity never probes or terminates a potentially reused numeric PID', async t => {
  const probe = t.mock.method(process, 'kill', () => { throw new Error('Must not inspect or signal an exited child PID'); });
  for (const state of [{ exitCode: 0, signalCode: null }, { exitCode: null, signalCode: 'SIGTERM' }]) {
    const child = Object.assign(new cp.ChildProcess(), { pid: 42424, ...state });
    const kill = t.mock.method(child, 'kill', () => { throw new Error('Must not signal an exited child'); });
    await killProcessTree(child);
    assert.equal(kill.mock.callCount(), 0);
  }
  assert.equal(probe.mock.callCount(), 0);
});

it('registration and natural exit remove both process listeners and stale ownership', async t => {
  const probe = t.mock.method(process, 'kill', () => { throw new Error('Must not inspect an unregistered PID'); });
  for (const alreadyExited of [false, true]) {
    const resources = new ResourceManager();
    const child = Object.assign(new cp.ChildProcess(), { pid: 42424, exitCode: alreadyExited ? 0 : null });
    resources.registerProcess('exited-child', child);
    if (!alreadyExited) { child.exitCode = 0; child.emit('exit', 0, null); }
    assert.equal(resources.childProcessCount(), 0);
    assert.equal(child.listenerCount('exit'), 0);
    assert.equal(child.listenerCount('close'), 0);
    await resources.dispose();
  }
  assert.equal(probe.mock.callCount(), 0);
});
