import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { WorkspaceWatch } from '../src/Core/WorkspaceWatch.js';

it('stop waits for the native close event and repeated callers share completion', async t => {
  const native = new EventEmitter() as fs.FSWatcher;
  let closeCalls = 0;
  native.close = () => { closeCalls++; };
  t.mock.method(fs, 'watch', () => native);
  const watch = new WorkspaceWatch();
  watch.start(os.tmpdir(), () => {});
  const stopped = watch.stop();
  assert.ok(stopped instanceof Promise, 'close initiation must not masquerade as completion');
  assert.equal(watch.getStatus().active, false);
  assert.equal(watch.stop(), stopped);
  let completed = false;
  void stopped.then(() => { completed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false);
  native.emit('close');
  await stopped;
  assert.equal(closeCalls, 1);
});

it('late events from a replaced watcher cannot stop or notify the current workspace', async t => {
  const natives: fs.FSWatcher[] = [];
  const callbacks: ((event: string, filename: string) => void)[] = [];
  t.mock.method(fs, 'watch', (_root: unknown, _options: unknown, callback: typeof callbacks[number]) => {
    const native = new EventEmitter() as fs.FSWatcher;
    native.close = () => { setImmediate(() => native.emit('close')); };
    natives.push(native);
    callbacks.push(callback);
    return native;
  });
  const watch = new WorkspaceWatch();
  let changes = 0;
  watch.start(os.tmpdir(), () => { changes++; }, 1);
  watch.start(os.tmpdir(), () => { changes++; }, 1);
  natives[0].emit('error', new Error('old owner failed'));
  callbacks[0]('change', 'old.cs');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(watch.getStatus().active, true);
  assert.equal(changes, 0);
  await watch.stop();
});

it('a native close failure is retained for subsequent callers', async t => {
  const native = new EventEmitter() as fs.FSWatcher;
  native.close = () => { throw new Error('close failed'); };
  t.mock.method(fs, 'watch', () => native);
  const watch = new WorkspaceWatch();
  watch.start(os.tmpdir(), () => {});
  await assert.rejects(Promise.resolve(watch.stop()), /close failed/);
  await assert.rejects(Promise.resolve(watch.stop()), /close failed/);
});

it('an earlier close failure does not bypass waiting for the replacement owner', async t => {
  const failed = new EventEmitter() as fs.FSWatcher;
  failed.close = () => { throw new Error('first close failed'); };
  const delayed = new EventEmitter() as fs.FSWatcher;
  delayed.close = () => {};
  let calls = 0;
  t.mock.method(fs, 'watch', () => calls++ === 0 ? failed : delayed);
  const watch = new WorkspaceWatch();
  watch.start(os.tmpdir(), () => {});
  await assert.rejects(watch.stop(), /first close failed/);
  watch.start(os.tmpdir(), () => {});
  const stopped = watch.stop();
  let settled = false;
  void stopped.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'retained failure must not short-circuit the new close');
  delayed.emit('close');
  await assert.rejects(stopped, /first close failed/);
});
