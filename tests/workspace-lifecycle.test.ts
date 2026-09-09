import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nativeFs from 'node:fs';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { ToolRouter } from '../src/Core/ToolRouter.js';
import { getDefaultConfig } from '../src/Core/Config.js';

it('ten sequential and ten concurrent workspace lifecycles close native watchers before cleanup', { timeout: 60000 }, async t => {
  const liveWatchers = new Set<nativeFs.FSWatcher>();
  const originalWatch = nativeFs.watch;
  t.mock.method(nativeFs, 'watch', (...args: Parameters<typeof originalWatch>) => {
    const watcher = originalWatch(...args);
    liveWatchers.add(watcher);
    watcher.once('close', () => liveWatchers.delete(watcher));
    return watcher;
  });
  // These configurations require no external process. Observe the real spawn
  // boundary, rather than treating an adapter's empty resource list as evidence.
  const spawns = t.mock.method(cp, 'spawn', cp.spawn);
  syncBuiltinESMExports();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-lifecycle-'));
  let removed = false;
  try {
    const run = async (index: number) => {
      const workspace = path.join(root, String(index));
      const other = path.join(workspace, 'other');
      await fs.mkdir(other, { recursive: true });
      const config = getDefaultConfig(workspace);

      config.adapters.flaui.enabled = false;
      config.adapters.repomix.useCli = false;
      const router = new ToolRouter(config);
      try {
        await router.initialize();
        await router.openWorkspace(other);
        await fs.writeFile(path.join(other, 'Changed.cs'), 'class Changed {}');
        await router.openWorkspace(workspace);
      } finally {
        await router.dispose();
        await router.dispose();
      }
      // No retry in the stress assertion: retain evidence if closure alone is insufficient.
      await fs.rm(workspace, { recursive: true, force: true });
    };
    for (let index = 0; index < 10; index++) await run(index);
    const outcomes = await Promise.allSettled(Array.from({ length: 10 }, (_, index) => run(index + 10)));
    const failures = outcomes.filter(result => result.status === 'rejected');
    assert.deepEqual(failures, [], 'all concurrent lifecycles must settle before cleanup');
    assert.equal(liveWatchers.size, 0, 'every created native watcher emitted close');
    assert.equal(spawns.mock.callCount(), 0, 'disabled adapters must create no child process');
    await fs.rm(root, { recursive: true, force: true });
    removed = true;
    t.diagnostic(`Node ${process.version}: sequential=10 concurrent=10 nativeWatchersClosed=true spawnedProcesses=0`);
  } finally {
    if (!removed) t.diagnostic(`Failure evidence retained at ${root}; liveWatchers=${liveWatchers.size}; spawns=${spawns.mock.callCount()}`);
    spawns.mock.restore();
    syncBuiltinESMExports();
  }
});
