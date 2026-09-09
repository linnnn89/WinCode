import { ContextManager } from '../src/Core/Context.js';
import { WorkspaceManager } from '../src/Core/Workspace.js';
import { parseTextDeclarations } from '../src/Core/TextDeclarations.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalTextAdapter } from '../src/Adapters/LocalTextAdapter.js';
import { getDefaultConfig } from '../src/Core/Config.js';

async function fixture(run: (adapter: LocalTextAdapter, root: string, cached: Map<string, unknown>) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-text-bounds-'));
  const cached = new Map<string, unknown>();
  const cache = { computeWorkspaceFingerprint: async () => 'fixture', get: async (key: string) => cached.get(key),
    set: async (key: string, value: unknown) => { cached.set(key, value); } };
  const config = getDefaultConfig(root);

  const adapter = new LocalTextAdapter(config, cache as any);
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
    // Windows runner TEMP can use an 8.3 alias while the scanner opens real paths.
    assert.deepEqual(opened, [await fs.realpath(path.join(root, 'src', 'Target.cs'))]);
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
  (adapter as any).config.timeouts.fileScanMs = -1;
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

it('ignores C# comment and literal declarations while preserving real declaration lines and signatures', async () => fixture(async (adapter, root) => {
  const source = [
    '// class GhostComment {}',
    '/* public class GhostBlock {} */',
    'var sample = "class GhostString {}";',
    'var multi = @"text',
    'class GhostVerbatim {}',
    '";',
    'var raw = """',
    'class GhostRaw {}',
    '""";',
    'public class Actual {} // remains in signature',
  ].join('\r\n');
  await fs.writeFile(path.join(root, 'Sample.cs'), source);
  const ghosts = await adapter.findSymbolsDetailed('Ghost');
  assert.deepEqual(ghosts.symbols, []);
  const actual = await adapter.findSymbolsDetailed('Actual');
  assert.equal(actual.symbols[0]?.line, 10);
  assert.equal(actual.symbols[0]?.signature, 'public class Actual {} // remains in signature');
  assert.equal(actual.source, 'local-text');
  assert.equal(actual.analysisCompleteness, 'degraded');
}));

it('ignores JS templates/regex and Python multiline strings without hiding following real declarations', async () => fixture(async (adapter, root) => {
  await fs.writeFile(path.join(root, 'Sample.ts'), [
    'const note = "class GhostString {}";',
    '/* class GhostComment {} */',
    'const re = /class GhostRegex[\\/]/;',
    'const sample = `',
    'class GhostTemplate {}',
    '${(() => "class GhostNested {}")()}',
    '`;',
    'export function ActualTs() {}',
  ].join('\n'));
  await fs.writeFile(path.join(root, 'Sample.py'), [
    '# class GhostComment:',
    'doc = r"""',
    'class GhostPython:',
    '    pass',
    '"""',
    'def ActualPy():',
    '    return "ok"',
  ].join('\n'));
  assert.deepEqual((await adapter.findSymbolsDetailed('Ghost')).symbols, []);
  const actual = (await adapter.findSymbolsDetailed('Actual')).symbols;
  assert.deepEqual(actual.map(s => [s.name, s.line]).sort(), [['ActualPy', 6], ['ActualTs', 8]]);
}));

it('finds TSX/JSX declarations while excluding JSX text and attributes', async () => fixture(async (adapter, root) => {
  for (const ext of ['tsx', 'jsx']) {
    await fs.writeFile(path.join(root, `Card.${ext}`), [
      `export function UserCard${ext}() {`,
      '  return <section title="class GhostAttribute {}">',
      '    class GhostText {}',
      '    <><span>{"class GhostExpression {}"}</span><input /></>',
      '  </section>;',
      '}',
      `export class After${ext} {}`,
    ].join('\n'));
  }
  assert.deepEqual((await adapter.findSymbolsDetailed('Ghost')).symbols, []);
  const actual = (await adapter.findSymbolsDetailed('UserCard')).symbols;
  assert.deepEqual(actual.map(s => [s.name, s.line]).sort(), [['UserCardjsx', 1], ['UserCardtsx', 1]]);
  assert.equal((await adapter.findSymbolsDetailed('After')).totalFound, 2);
  assert.equal(adapter.findSymbolsInContent('export function Direct() { return <p>class Ghost {}</p>; }', 'Direct.tsx')[0]?.name, 'Direct');
}));

it('does not report a complete empty scan or cache results when lexical boundaries are uncertain', async () => fixture(async (adapter, root, cached) => {
  await fs.writeFile(path.join(root, 'Broken.ts'), 'const note = `unterminated\nclass Ghost {}');
  const result = await adapter.findSymbolsDetailed('Ghost');
  assert.deepEqual(result.symbols, []);
  assert.equal(result.queryComplete, false);
  assert.match(result.queryError!, /lexical-uncertainty/);
  assert.equal(cached.size, 0);
}));

it('keeps declarations after escaped/interpolated literals and ordinary division', async () => fixture(async (adapter, root) => {
  const samples: Record<string, string> = {
    'Nested.cs': 'var text = $"{string.Join("class Ghost {}", items)}";\npublic class ActualCs {}',
    'Nested.ts': 'const text = `outer ${`inner ${"class Ghost {}"}`} tail`;\nconst ratio = 12 / 3;\nexport function ActualTs() {}',
    'Nested.py': 'text = f"outer {"class Ghost {}"}"\ndef ActualPy(): pass',
  };
  for (const [file, source] of Object.entries(samples)) await fs.writeFile(path.join(root, file), source);
  assert.deepEqual((await adapter.findSymbolsDetailed('Ghost')).symbols, []);
  assert.equal((await adapter.findSymbolsDetailed('Actual')).totalFound, 3);
}));

it('does not reuse declaration results cached by the retired unmasked parser', async () => fixture(async (adapter, root, cached) => {
  await fs.writeFile(path.join(root, 'Only.cs'), '// class Ghost {}');
  cached.set(`local_text_symbols_v1_${JSON.stringify(['Ghost', undefined, undefined, root])}`, {
    queryComplete: true, symbols: [{ name: 'Ghost' }], totalFound: 1,
  });
  assert.deepEqual((await adapter.findSymbolsDetailed('Ghost')).symbols, []);
}));

it('excludes regex literals used as control-flow statements', async () => fixture(async (adapter, root) => {
  await fs.writeFile(path.join(root, 'Regex.js'), 'if (ready && check()) /class GhostRegex/.test(input);\nif (ready) {} /class GhostBlockRegex/.test(input);\nexport class Actual {}');
  assert.deepEqual((await adapter.findSymbolsDetailed('Ghost')).symbols, []);
  assert.equal((await adapter.findSymbolsDetailed('Actual')).totalFound, 1);
}));


it('scoped TSX context returns the real declaration and reports uncertain lexical input', async () => fixture(async (adapter, root) => {
  await fs.writeFile(path.join(root, 'Card.tsx'), 'export function UserCard() { return <p>class Ghost {}</p>; }');
  const config = getDefaultConfig(root);
  const manager = new ContextManager(config, new WorkspaceManager(config), null as any, adapter);
  const result = await manager.prepareContext({ task: 'Review', scopeFiles: ['Card.tsx'], symbol: 'UserCard' });
  assert.ok(result.evidence.some(item => item.file === 'Card.tsx' && item.snippet.includes('UserCard')));
  await fs.writeFile(path.join(root, 'Broken.ts'), 'const text = `open');
  const broken = await manager.prepareContext({ task: 'Review', scopeFiles: ['Broken.ts'], symbol: 'Ghost' });
  assert.ok(broken.fileIssues.some(item => item.reason === 'lexical-uncertainty'));
  assert.equal(broken.evidence.length, 0);
}));

it('checks cancellation during long literal processing, not only between files', () => {
  const source = 'const note = `' + 'text '.repeat(10000) + '`;\nexport class Actual {}';
  let checks = 0;
  const cancelled = new Error('cancelled while processing source');
  assert.throws(() => parseTextDeclarations(source, 'Long.ts', '.ts', () => {
    if (++checks === 3) throw cancelled;
  }), error => error === cancelled);
});
