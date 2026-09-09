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
    config.adapters.repomix.customCliPath = path.join(root, 'fixture.cjs');
    await fs.writeFile(config.adapters.repomix.customCliPath, '// controlled probe fixture');
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

async function realCliFixture(run: (adapter: RepomixAdapter, config: ReturnType<typeof getDefaultConfig>, root: string) => Promise<void>) {
  // The metacharacters are legal directory characters, not an actual shell payload.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode 中文 & %PATH% ^ (cli) '));
  const config = getDefaultConfig(root);
  const script = path.join(root, 'tool & 中文.cjs');
  config.adapters.repomix.customCliPath = script;
  const cache = new CacheManager(config.cacheDir);
  const adapter = new RepomixAdapter(config, cache);
  await fs.writeFile(path.join(root, 'Example.ts'), 'export const builtinEvidence = true;');
  await fs.writeFile(script, `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('fixture-1'); process.exit(0); }
fs.writeFileSync(path.join(process.cwd(), 'started.json'), JSON.stringify({pid:process.pid,args,cwd:process.cwd()}));
if (args.includes('--compress')) { setInterval(() => {}, 1000); }
else fs.writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify({args,cwd:process.cwd()}));
console.log('  Total Files: 1 files');
`);
  try { await run(adapter, config, root); }
  finally {
    await adapter.dispose();
    assert.equal(path.dirname(root), os.tmpdir());
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

it('real Node CLI receives exact special-character paths and include argv without a shell', async () => realCliFixture(async (adapter, config, root) => {
  await adapter.initialize();
  assert.equal((await adapter.checkHealth()).source, 'installed');
  const include = 'src/中文 & %PATH% ^ (x),"quote";echo';
  const result = await adapter.packWorkspace({ include: [include] });
  assert.equal(result.source, 'repomix-cli');
  const received = JSON.parse(result.content);
  assert.equal(received.cwd, root);
  assert.equal(received.args[received.args.indexOf('--include') + 1], include);
  const output = received.args[received.args.indexOf('-o') + 1];
  assert.equal(path.dirname(output), path.join(config.cacheDir, 'repomix_tmp'));
  await assert.rejects(fs.stat(output), { code: 'ENOENT' });
  assert.equal(adapter.activeProcessCount, 0);
}));

it('discovers installed package bin metadata without invoking npm or PATH wrappers', async () => realCliFixture(async (adapter, config, root) => {
  const packageRoot = path.join(root, 'node_modules', 'repomix');
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.copyFile(config.adapters.repomix.customCliPath!, path.join(packageRoot, 'cli.cjs'));
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'repomix', bin: { repomix: './cli.cjs' } }));
  delete config.adapters.repomix.customCliPath;
  await adapter.initialize();
  assert.equal((await adapter.packWorkspace()).source, 'repomix-cli');
}));

for (const count of [0, 2, 1234]) {
  it(`CLI summary reports ${count} files independently of body headers`, async () => realCliFixture(async (adapter, config) => {
    await fs.writeFile(config.adapters.repomix.customCliPath!, `
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('fixture-1'); process.exit(0); }
fs.writeFileSync(args[args.indexOf('-o') + 1], 'File: fake\\n## File: fake\\n<file path="fake">');
console.log('  Total Files: ${count.toLocaleString('en-US')} files');
`);
    await adapter.initialize();
    const result = await adapter.packWorkspace();
    assert.equal(result.source, 'repomix-cli');
    assert.equal(result.fileCount, count);
  }));
}

it('missing CLI count degrades instead of inventing a packed file', async () => realCliFixture(async (adapter, config) => {
  const script = await fs.readFile(config.adapters.repomix.customCliPath!, 'utf8');
  await fs.writeFile(config.adapters.repomix.customCliPath!, script.replace("console.log('  Total Files: 1 files');", ''));
  await adapter.initialize();
  const result = await adapter.packWorkspace();
  assert.equal(result.source, 'builtin-fallback');
  assert.match(adapter.lastError?.message ?? '', /file-count summary/);
}));

for (const invalid of ['missing.cjs', 'wrapper.cmd', 'relative.cjs']) {
  it(`invalid explicit CLI ${invalid} falls back without a process`, async () => realCliFixture(async (adapter, config, root) => {
    await fs.writeFile(path.join(root, 'wrapper.cmd'), '@echo should-never-run');
    config.adapters.repomix.customCliPath = invalid === 'relative.cjs' ? invalid : path.join(root, invalid);
    const probe = fakeCliProbe();
    try {
      await adapter.initialize();
      assert.equal((await adapter.checkHealth()).source, 'fallback');
      assert.equal((await adapter.packWorkspace()).source, 'builtin-fallback');
      assert.equal(probe.count(), 0);
    } finally { probe.restore(); }
  }));
}

it('timed out real CLI falls back after its process exits', async () => realCliFixture(async (adapter, config, root) => {
  config.timeouts.repomixPackMs = 1500;
  await adapter.initialize();
  const result = await adapter.packWorkspace({ compress: true });
  assert.equal(result.source, 'builtin-fallback');
  assert.equal(adapter.lastError?.reason, 'timeout');
  const { pid } = JSON.parse(await fs.readFile(path.join(root, 'started.json'), 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.equal(adapter.activeProcessCount, 0);
}));

it('cancelling real CLI rejects and waits for its process to exit', async () => realCliFixture(async (adapter, _config, root) => {
  await adapter.initialize();
  const controller = new AbortController();
  const running = adapter.packWorkspace({ compress: true }, { signal: controller.signal });
  const rejection = assert.rejects(running, error => error instanceof Error && /abort|cancel/i.test(error.message));
  let started: { pid: number } | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    started = await fs.readFile(path.join(root, 'started.json'), 'utf8').then(JSON.parse).catch(() => undefined);
    if (started) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  controller.abort();
  await rejection;
  assert.ok(started, 'fixture process reached its packing code');
  assert.throws(() => process.kill(started.pid, 0), { code: 'ESRCH' });
  assert.equal(adapter.activeProcessCount, 0);
}));

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
