import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { CacheManager } from '../src/Core/Cache.js';
import { WorkspaceManager } from '../src/Core/Workspace.js';
import { getDefaultConfig } from '../src/Core/Config.js';

import { RepomixAdapter } from '../src/Adapters/RepomixAdapter.js';
import { ToolRouter } from '../src/Core/ToolRouter.js';

import { TimeoutError, withTimeout } from '../src/Core/ResourceManager.js';

const execAsync = promisify(exec);

async function pidAlive(pid: number): Promise<boolean> {
  try {
    const { stdout } = await execAsync(`tasklist /FI "PID eq ${pid}" /NH`, { windowsHide: true });
    return stdout.includes(String(pid));
  } catch {
    return false;
  }
}

// 每个功能套件拥有独立缓存；并行文件不能删除彼此正在使用的缓存。
describe('process-failures', () => {
  const root = process.cwd();
  const testCacheDir = path.join(root, '.cache', `test_process-failures_${process.pid}`);

  before(async () => {
    await fs.mkdir(testCacheDir, { recursive: true });
  });
  after(async () => {
    await fs.rm(testCacheDir, { recursive: true, force: true }).catch(() => { });
  });
  describe('Failure', () => {
    it('awaited deadlines settle without unrelated active handles and settled operations release their timer', async () => {
      const moduleUrl = pathToFileURL(path.join(root, 'src/Core/ResourceManager.ts')).href;
      const run = promisify(execFile);
      const cases = [
        `try { await withTimeout(new Promise(() => {}), 40, 'isolated'); throw Error('Unexpected completion'); }
         catch (error) { if (!(error instanceof TimeoutError)) throw error; console.log('deadline observed'); }`,
        `console.log(await withTimeout(Promise.resolve('settled'), 30000, 'isolated'));`,
      ];
      for (const [index, body] of cases.entries()) {
        const result = await run(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval',
          `import { withTimeout, TimeoutError } from ${JSON.stringify(moduleUrl)}; ${body}`],
          { cwd: root, windowsHide: true, timeout: 10000 });
        assert.match(result.stdout, index === 0 ? /deadline observed/ : /settled/);
      }
    });

    it('Repomix health timeout is a fallback, not a throw', async () => {
      const config = getDefaultConfig(root);
      config.cacheDir = testCacheDir;
      const { RepomixAdapter } = await import('../src/Adapters/RepomixAdapter.js');
      const adapter = new RepomixAdapter(config, new CacheManager(testCacheDir));
      const health = await adapter.checkHealth(30);
      assert.strictEqual(health.available, true);
      assert.ok(health.source === 'fallback' || health.source === 'installed');
    });

    it('git-less workspace is reported, not thrown', async () => {
      // TEMP may be inside this repository; stop discovery at its parent to model a non-Git workspace.
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-nongit-'));
      const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
      try {
        process.env.GIT_CEILING_DIRECTORIES = path.dirname(tmp);
        await fs.writeFile(path.join(tmp, 'readme.txt'), 'x');
        const ws = new WorkspaceManager(getDefaultConfig(tmp));
        const git = await ws.getGitStatus();
        assert.strictEqual(git.isGit, false);
      } finally {
        if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
        else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
        assert.strictEqual(path.dirname(await fs.realpath(tmp)), await fs.realpath(os.tmpdir()));
        await fs.rm(tmp, { recursive: true, force: true });
      }
    });

    it('malformed workspace path fails with a structured error', async () => {
      const filePath = path.join(testCacheDir, 'not_a_dir.txt');
      await fs.writeFile(filePath, 'nope');
      const ws = new WorkspaceManager(getDefaultConfig(filePath));
      await assert.rejects(() => ws.openWorkspace(filePath), /Invalid workspace path/);
      const missing = path.join(testCacheDir, 'missing_dir_zzz');
      await assert.rejects(() => new WorkspaceManager(getDefaultConfig(missing)).openWorkspace(missing), /Invalid workspace path/);
    });

    it('withTimeout converts hangs into TimeoutError without rejecting later', async () => {
      await assert.rejects(
        () => withTimeout(new Promise(() => { }), 30, 'probe'),
        (err: unknown) => err instanceof TimeoutError && err.provider === 'probe'
      );
    });

    it('shutdown during an active request drains then completes; second stop is a no-op', async () => {
      const config = getDefaultConfig(root);
      config.cacheDir = path.join(testCacheDir, 'drain');
      config.timeouts.shutdownMs = 2_000;
      const router = new ToolRouter(config);
      await router.initialize();
      router.beginRequest();
      const stop = router.dispose();
      assert.strictEqual(router.isShuttingDown, true);
      await new Promise((r) => setTimeout(r, 40));
      router.endRequest();
      await stop;
      await router.dispose();
      assert.strictEqual(router.inFlightRequests, 0);
    });
  });
});
