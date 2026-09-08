import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SerenaAdapter } from '../src/Adapters/SerenaAdapter.js';
import { getDefaultConfig } from '../src/Core/Config.js';

async function fixture(run: (adapter: SerenaAdapter, root: string, cached: Map<string, unknown>) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-serena-bounds-'));
  const cached = new Map<string, unknown>();
  const cache = { computeWorkspaceFingerprint: async () => 'fixture', get: async (key: string) => cached.get(key),
    set: async (key: string, value: unknown) => { cached.set(key, value); } };
  const config = getDefaultConfig(root);
  config.adapters.serena.enabled = false;
  const adapter = new SerenaAdapter(config, cache as any);
  try { await run(adapter, root, cached); }
  finally { await adapter.dispose(); await fs.rm(root, { recursive: true, force: true, maxRetries: 3 }); }
}

it('enforces the reference limit across sibling directories and does not cache partial results', async () => fixture(async (adapter, root, cached) => {
  for (const dir of ['a', 'b', 'c']) {
    await fs.mkdir(path.join(root, dir));
    await fs.writeFile(path.join(root, dir, 'Uses.cs'), 'Save();\n'.repeat(210));
  }
  const result = await adapter.findReferencesDetailed('Save', 'a/Uses.cs');
  assert.equal(result.totalReferences, 200);
  assert.equal(result.queryComplete, false);
  assert.equal(result.truncated, true);
  assert.match(result.queryError!, /result-limit/);
  assert.equal(cached.size, 0);
}));

it('enforces a global symbol limit', async () => fixture(async (adapter, root) => {
  await fs.writeFile(path.join(root, 'Types.cs'), Array.from({ length: 510 }, (_, i) => `class Type${i} {}`).join('\n'));
  const result = await adapter.findSymbolsDetailed('Type');
  assert.equal(result.totalFound, 500);
  assert.equal(result.queryComplete, false);
  assert.equal(result.uniqueTypeMatch, false);
  assert.match(result.queryError!, /result-limit/);
}));

it('limits symbol scanning to the requested file before reading unrelated content', async (t) => fixture(async (adapter, root) => {
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src', 'Target.cs'), 'class Target {}');
  await fs.writeFile(path.join(root, 'Unrelated.cs'), Buffer.from([0xff, 0xfe, 0, 1]));
  const opened: string[] = [];
  const original = fs.open;
  t.mock.method(fs, 'open', (...args: Parameters<typeof fs.open>) => { opened.push(String(args[0])); return original(...args); });
  try {
    const result = await adapter.findSymbolsDetailed('Target', undefined, 'src/Target.cs');
    assert.equal(result.queryComplete, true);
    assert.equal(result.totalFound, 1);
    assert.deepEqual(opened.map(file => path.relative(root, file)), [path.join('src', 'Target.cs')]);
  } finally { t.mock.restoreAll(); }
}));

it('reference definition paths do not restrict reference scan scope', async () => fixture(async (adapter, root) => {
  await fs.writeFile(path.join(root, 'Definition.cs'), 'class Target {}');
  await fs.writeFile(path.join(root, 'Use.cs'), 'Target.Run();');
  const result = await adapter.findReferencesDetailed('Target', 'Definition.cs');
  assert.equal(result.queryComplete, true);
  assert.deepEqual(result.references.map(ref => ref.file), ['Use.cs']);
}));

for (const content of [Buffer.alloc(256 * 1024 + 1, 'a'), Buffer.from([0xc3, 0x28]), Buffer.from([0xff, 0xfe, 0x61, 0])]) {
  it(`marks skipped ${content.length > 256 * 1024 ? 'oversize' : 'invalid UTF-8'} files incomplete`, async () => fixture(async (adapter, root, cached) => {
    await fs.writeFile(path.join(root, 'Invalid.cs'), content);
    const result = await adapter.findSymbolsDetailed('Target');
    assert.equal(result.queryComplete, false);
    assert.match(result.queryError!, /file-byte-limit|encoding/);
    assert.equal(cached.size, 0);
  }));
}

it('marks a missing explicit file incomplete instead of reporting a complete empty result', async () => fixture(async (adapter) => {
  const result = await adapter.findSymbolsDetailed('Target', undefined, 'missing.cs');
  assert.equal(result.queryComplete, false);
  assert.match(result.queryError!, /read-error/);
}));

it('rejects explicit paths outside the workspace', async () => fixture(async (adapter) => {
  const result = await adapter.findSymbolsDetailed('Target', undefined, '../Outside.cs');
  assert.equal(result.queryComplete, false);
  assert.match(result.queryError!, /invalid-scope/);
}));

it('marks a scan deadline incomplete', async () => fixture(async (adapter, root) => {
  await fs.writeFile(path.join(root, 'Target.cs'), 'class Target {}');
  (adapter as any).timeouts.fileScanMs = -1;
  const result = await adapter.findSymbolsDetailed('Target');
  assert.equal(result.queryComplete, false);
  assert.match(result.queryError!, /deadline/);
}));

it('enforces the total byte budget across regular files', async () => fixture(async (adapter, root) => {
  for (let i = 0; i < 34; i++) await fs.writeFile(path.join(root, `${i}.cs`), ' '.repeat(256 * 1024));
  const result = await adapter.findSymbolsDetailed('Missing');
  assert.equal(result.queryComplete, false);
  assert.equal(result.truncated, true);
  assert.match(result.queryError!, /total-byte-limit/);
}));

it('enforces the traversal budget even for irrelevant files', async (t) => fixture(async (adapter, root) => {
  const original = fs.opendir;
  let visits = 0;
  t.mock.method(fs, 'opendir', async (dir: string) => {
    if (dir !== root) return original(dir);
    return { async *[Symbol.asyncIterator]() {
      for (let i = 0; i < 5100; i++) {
        visits++;
        yield { name: `${i}.txt`, isDirectory: (): boolean => false, isFile: (): boolean => true, isSymbolicLink: (): boolean => false };
      }
    } };
  });
  try {
    const result = await adapter.findSymbolsDetailed('Missing');
    assert.equal(result.queryComplete, false);
    assert.match(result.queryError!, /entry-limit/);
    assert.equal(visits, 5001);
  } finally { t.mock.restoreAll(); }
}));

it('does not turn a directory read failure into a complete empty scan', async (t) => fixture(async (adapter) => {
  t.mock.method(fs, 'opendir', async () => { throw new Error('EACCES'); });
  try {
    const result = await adapter.findSymbolsDetailed('Missing');
    assert.equal(result.queryComplete, false);
    assert.match(result.queryError!, /read-error/);
  } finally { t.mock.restoreAll(); }
}));

for (const body of ['logger.LogError("No active project");', 'logger.LogError("没有激活项目");']) {
  it(`accepts valid upstream JSON containing ${body}`, async () => fixture(async (adapter) => {
    Object.assign(adapter as any, { ensureConnected: async () => true, isConnectedToSerena: true,
      serenaTools: new Set(['find_symbol']), serenaClient: { callTool: async () => ({ content: [{ type: 'text', text: JSON.stringify([
        { name_path: 'Service/Save', kind: 'Method', relative_path: 'Service.cs', body_location: { start_line: 1, end_line: 2 }, body },
      ]) }] }) } });
    const result = await adapter.findSymbolsDetailed('Save');
    assert.equal(result.source, 'serena-mcp');
    assert.equal(result.queryComplete, true);
    assert.equal(result.symbols[0].name, 'Save');
    (adapter as any).serenaClient = null;
  }));
}

it('accepts reference JSON containing inactive-project error phrases', async () => fixture(async (adapter) => {
  Object.assign(adapter as any, { ensureConnected: async () => true, isConnectedToSerena: true,
    serenaTools: new Set(['find_referencing_symbols']), serenaClient: { callTool: async () => ({ content: [{ type: 'text', text: JSON.stringify([
      { relative_path: 'Use.cs', line: 7, preview: 'Save("No active project / 没有激活项目");' },
    ]) }] }) } });
  const result = await adapter.findReferencesDetailed('Service/Save', 'Service.cs');
  assert.equal(result.source, 'serena-mcp');
  assert.equal(result.queryComplete, true);
  assert.equal(result.totalReferences, 1);
  (adapter as any).serenaClient = null;
}));

for (const message of ['Error: No active project.', 'No active project. Activate a project.', '没有激活项目']) {
  it(`retains explicit plain-text error handling: ${message}`, async () => fixture(async (adapter) => {
    Object.assign(adapter as any, { ensureConnected: async () => true, isConnectedToSerena: true,
      serenaTools: new Set(['find_symbol']), serenaClient: { callTool: async () => ({ content: [{ type: 'text', text: message }] }) } });
    const result = await adapter.findSymbolsDetailed('Save');
    assert.equal(result.queryComplete, false);
    assert.equal(result.source, 'serena-adapter-fallback');
    assert.equal((adapter as any).projectActive, false);
    (adapter as any).serenaClient = null;
  }));
}
