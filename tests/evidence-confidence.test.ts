import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import { getDefaultConfig } from '../src/Core/Config.js';

import { ToolRouter } from '../src/Core/ToolRouter.js';

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
describe('evidence-confidence', () => {
  const root = process.cwd();
  const testCacheDir = path.join(root, '.cache', `test_evidence-confidence_${process.pid}`);
  const FIXTURE_DOTNET = path.resolve(root, 'tests/fixtures/dotnet-mini');
  before(async () => {
    await fs.mkdir(testCacheDir, { recursive: true });
  });
  after(async () => {
    await fs.rm(testCacheDir, { recursive: true, force: true }).catch(() => { });
  });
  describe('v0.4 regression guards', () => {
    it('source still does not imply connected; 0 refs stay UNKNOWN', async () => {
      const config = getDefaultConfig(FIXTURE_DOTNET);
      config.cacheDir = path.join(testCacheDir, 'reg');
      const router = new ToolRouter(config);
      const health = await router.text.checkHealth();
      assert.strictEqual(health.available, true);
      assert.strictEqual(health.source, 'fallback');
      const unused = await router.impact.analyzeImpact('UnusedHelper');
      assert.strictEqual(unused.riskLevel, 'UNKNOWN');
      assert.strictEqual(unused.confidence, 'UNCERTAIN');
      await router.dispose();
    });
  });
});
