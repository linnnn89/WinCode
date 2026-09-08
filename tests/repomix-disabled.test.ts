import { it, mock } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RepomixAdapter, RepomixPackResult } from '../src/Adapters/RepomixAdapter.js';
import { getDefaultConfig } from '../src/Core/Config.js';
import { CacheManager } from '../src/Core/Cache.js';

async function fixture(run: (adapter: RepomixAdapter, config: ReturnType<typeof getDefaultConfig>) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-repomix-disabled-'));
  const config = getDefaultConfig(root);
  config.adapters.repomix.useCli = false;
  const cacheEntries = new Map<string, unknown>();
  const cache = {
    computeWorkspaceFingerprint: async () => 'unchanged-fixture',
    get: async (key: string) => cacheEntries.get(key),
    set: async (key: string, value: unknown) => { cacheEntries.set(key, value); },
    maxEntryByteLimit: 1_000_000,
    estimateBytes: (value: string) => Buffer.byteLength(value),
  } as unknown as CacheManager;
  const adapter = new RepomixAdapter(config, cache);
  try {
    await fs.writeFile(path.join(root, 'Example.ts'), 'export const builtinEvidence = true;');
    await run(adapter, config);
  } finally {
    await adapter.dispose();
    assert.equal(path.dirname(root), os.tmpdir());
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

// Never launch npx: the substitute makes an accidental probe observable and deterministic.
function fakeCliProbe() {
  const spawn = mock.method(childProcess, 'spawn', () => {
    const proc = new EventEmitter() as childProcess.ChildProcess;
    Object.assign(proc, { stdout: new PassThrough(), stderr: new PassThrough() });
    queueMicrotask(() => { proc.stdout!.emit('data', Buffer.from('1.0.0')); proc.emit('close', 0); });
    return proc;
  });
  syncBuiltinESMExports();
  return {
    count: () => spawn.mock.callCount(),
    restore: () => { spawn.mock.restore(); syncBuiltinESMExports(); },
  };
}

it('disabled CLI initialization and explicit or memoized health never probe an executable', async () => {
  const probe = fakeCliProbe();
  try {
    await fixture(async (adapter) => {
      await adapter.initialize();
      for (const timeout of [undefined, 100]) {
        const health = await adapter.checkHealth(timeout);
        assert.equal(health.available, true);
        assert.equal(health.source, 'fallback');
        assert.match(health.details!, /disabled/i);
      }
      assert.equal(probe.count(), 0);
      assert.equal(adapter.activeProcessCount, 0);
    });
  } finally { probe.restore(); }
});

it('disabled configuration overrides an earlier installed health memo', async () => {
  const probe = fakeCliProbe();
  try {
    await fixture(async (adapter, config) => {
      config.adapters.repomix.useCli = true;
      await adapter.initialize();
      assert.equal(probe.count(), 1);
      config.adapters.repomix.useCli = false;
      assert.equal((await adapter.checkHealth()).source, 'fallback');
      assert.equal((await adapter.checkHealth(100)).source, 'fallback');
      assert.equal(probe.count(), 1);
    });
  } finally { probe.restore(); }
});

it('disabled configuration prevents packing through a previously available CLI', async () => {
  await fixture(async (adapter) => {
    const internals = adapter as any;
    internals.isCliAvailable = true;
    let cliCalls = 0;
    internals.packWithCli = async () => { cliCalls++; return cliSnapshot; };
    const packed = await adapter.packWorkspace();
    assert.equal(packed.source, 'builtin-fallback');
    assert.match(packed.content, /builtinEvidence/);
    assert.equal(cliCalls, 0);
    const cached = await adapter.packWorkspace();
    assert.equal(cached.source, 'builtin-fallback');
    assert.equal(cached.fromCache, true);
  });
});

const cliSnapshot: RepomixPackResult = {
  content: 'CLI snapshot', fileCount: 1, totalCharacters: 12, fromCache: false, source: 'repomix-cli',
};

it('disabled configuration cannot reuse an enabled CLI snapshot cache', async () => {
  await fixture(async (adapter, config) => {
    config.adapters.repomix.useCli = true;
    Object.assign(adapter, { isCliAvailable: true, packWithCli: async () => cliSnapshot });
    assert.equal((await adapter.packWorkspace()).source, 'repomix-cli');
    config.adapters.repomix.useCli = false;
    const packed = await adapter.packWorkspace();
    assert.equal(packed.source, 'builtin-fallback');
    assert.equal(packed.fromCache, false);
    assert.match(packed.content, /builtinEvidence/);
  });
});

it('disabled packing does not join an enabled CLI operation already in flight', async () => {
  await fixture(async (adapter, config) => {
    let release!: (result: RepomixPackResult) => void;
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    config.adapters.repomix.useCli = true;
    Object.assign(adapter, {
      isCliAvailable: true,
      packWithCli: () => { started(); return new Promise<RepomixPackResult>((resolve) => { release = resolve; }); },
    });
    const enabled = adapter.packWorkspace();
    await didStart;
    config.adapters.repomix.useCli = false;
    const disabled = adapter.packWorkspace();
    release(cliSnapshot);
    const [first, second] = await Promise.all([enabled, disabled]);
    assert.equal(first.source, 'repomix-cli');
    assert.equal(second.source, 'builtin-fallback');
    assert.match(second.content, /builtinEvidence/);
  });
});

for (const initiallyEnabled of [false, true]) {
  it(`keeps the entry policy while fingerprinting when CLI changes from ${initiallyEnabled}`, async () => {
    await fixture(async (adapter, config) => {
      let release!: (fingerprint: string) => void;
      let cliCalls = 0;
      const internals = adapter as any;
      const originalFingerprint = internals.cache.computeWorkspaceFingerprint;
      internals.cache.computeWorkspaceFingerprint = () => new Promise<string>((resolve) => { release = resolve; });
      Object.assign(adapter, { isCliAvailable: true, packWithCli: async () => { cliCalls++; return cliSnapshot; } });
      config.adapters.repomix.useCli = initiallyEnabled;
      const first = adapter.packWorkspace();
      config.adapters.repomix.useCli = !initiallyEnabled;
      release('unchanged-fixture');
      const result = await first;
      assert.equal(result.source, 'builtin-fallback');
      assert.equal(cliCalls, 0);
      internals.cache.computeWorkspaceFingerprint = originalFingerprint;
      config.adapters.repomix.useCli = false;
      const disabled = await adapter.packWorkspace();
      assert.equal(disabled.source, 'builtin-fallback');
      assert.match(disabled.content, /builtinEvidence/);
      assert.equal(disabled.fromCache, !initiallyEnabled);
    });
  });
}

it('rechecks a disabled CLI after asynchronous output-directory preparation', async () => {
  const probe = fakeCliProbe();
  try {
    await fixture(async (adapter, config) => {
      const originalMkdir = fs.mkdir;
      const mkdir = mock.method(fs, 'mkdir', async (...args: Parameters<typeof fs.mkdir>) => {
        const result = await originalMkdir(...args);
        if (String(args[0]).endsWith('repomix_tmp')) config.adapters.repomix.useCli = false;
        return result;
      });
      try {
        config.adapters.repomix.useCli = true;
        Object.assign(adapter, { isCliAvailable: true });
        const result = await adapter.packWorkspace();
        assert.equal(result.source, 'builtin-fallback');
        assert.equal(probe.count(), 0);
      } finally { mkdir.mock.restore(); }
    });
  } finally { probe.restore(); }
});
