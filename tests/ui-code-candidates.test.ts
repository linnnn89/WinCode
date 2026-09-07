import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mapUiCodeCandidates, validateCandidateCodeFiles } from '../src/Core/UiCodeMapper.js';
import { mapUiSources } from '../src/Core/UiSourceMapper.js';
import { reviewUi } from '../src/CompositeTools/UiReview.js';
import { UiNode, UiInspectResult } from '../src/Core/UiContracts.js';

const tree: UiNode = { id: 1, parentId: null, automationId: 'NavCharacters', isEnabled: false, children: [] };
async function fixture(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-code-candidates-'));
  try { await run(root); }
  finally { assert.equal(path.dirname(root), os.tmpdir()); await fs.rm(root, { recursive: true, force: true }); }
}
async function source(root: string, declaration = 'Command="{Binding ShowCharactersCommand}"') {
  await fs.writeFile(path.join(root, 'View.xaml'), `<Button AutomationProperties.AutomationId="NavCharacters" ${declaration}/>`);
  return mapUiSources(root, ['View.xaml'], tree);
}

it('a disabled button yields bounded XAML to command-assignment navigation without claiming a cause', async () => fixture(async root => {
  await source(root);
  await fs.writeFile(path.join(root, 'ViewModel.cs'), [
    'class ViewModel {', 'public ICommand ShowCharactersCommand { get; }',
    'public ViewModel() {', 'ShowCharactersCommand = new AsyncRelayCommand(ShowCharactersAsync);', '}',
    'private Task ShowCharactersAsync() { return Task.CompletedTask; }', '}',
  ].join('\n'));
  let calls = 0;
  const snapshot: UiInspectResult = { schemaVersion: '1.0', protocolVersion: '1.0', requestId: 'one', success: true, tree };
  const result = await reviewUi(async () => { calls++; return snapshot; }, root, { pid: 1 }, ['View.xaml'], undefined, undefined, ['ViewModel.cs']);
  assert.equal(calls, 1);
  assert.strictEqual(result.tree, tree);
  assert.equal(result.tree!.isEnabled, false);
  const evidence = result.codeEvidence!;
  assert.equal(evidence.runtimeSourceVerified, false);
  assert.equal(evidence.runtimeBuildSourceIdentity, 'unknown');
  assert.equal(evidence.templateResolution, 'unsupported');
  assert.equal(evidence.clues[0].status, 'candidate');
  const assignment = evidence.clues[0].candidates.find(candidate => candidate.kind === 'assignment')!;
  assert.equal(assignment.line, 4);
  assert.equal(assignment.relatedSymbol, 'ShowCharactersAsync');
  assert.equal(assignment.fileSha256.length, 64);
  assert.deepEqual(assignment.nextRequest.scopeFiles, ['ViewModel.cs']);
  assert.equal(assignment.nextRequest.symbol, undefined);
  assert.deepEqual(assignment.nextRequest.lineRanges, [{ file: 'ViewModel.cs', startLine: 4, endLine: 4 }]);
  assert.ok(evidence.limitations.some(value => value.includes('CanExecute')));
  assert.ok(!JSON.stringify(evidence).includes(root));
}));

it('same-name command declarations across classes or files remain ambiguous', async () => fixture(async root => {
  const xaml = await source(root);
  await fs.writeFile(path.join(root, 'A.cs'), 'class A { public ICommand ShowCharactersCommand { get; } }\nclass B { public ICommand ShowCharactersCommand { get; } }');
  const sameFile = await mapUiCodeCandidates(root, ['A.cs'], xaml);
  assert.equal(sameFile.clues[0].status, 'ambiguous');
  await fs.writeFile(path.join(root, 'B.cs'), 'class C { public ICommand ShowCharactersCommand { get; } }');
  const multiple = await mapUiCodeCandidates(root, ['A.cs', 'B.cs'], xaml);
  assert.equal(multiple.clues[0].candidateCount, 3);
  assert.equal(multiple.clues[0].status, 'ambiguous');
  await fs.writeFile(path.join(root, 'Inline.cs'), 'class A { public ICommand ShowCharactersCommand { get; } } class B { public ICommand ShowCharactersCommand { get; } }');
  const inline = await mapUiCodeCandidates(root, ['Inline.cs'], xaml);
  assert.equal(inline.clues[0].candidateCount, 2);
  assert.equal(inline.clues[0].status, 'ambiguous');
}));

it('complex bindings stay unsupported and template/DataContext resolution stays explicitly unavailable', async () => fixture(async root => {
  const xaml = await source(root, 'Command="{Binding Model.ShowCharactersCommand, RelativeSource={RelativeSource AncestorType=Window}}"');
  const result = await mapUiCodeCandidates(root, ['Missing.cs'], xaml);
  assert.equal(result.clues[0].status, 'unsupported');
  assert.equal(result.files[0].status, 'not-scanned-no-supported-clues');
  assert.equal(result.templateResolution, 'unsupported');
  assert.equal(result.runtimeSourceVerified, false);
}));

it('literal Click handlers match declarations while comments, strings and invocations do not become declarations', async () => fixture(async root => {
  const xaml = await source(root, 'Click="OpenCharacters"');
  await fs.writeFile(path.join(root, 'View.cs'), [
    '// private void OpenCharacters() {}',
    'string fake = "private void OpenCharacters() {}";',
    'void Other() { OpenCharacters(); }',
    'private void OpenCharacters(object sender, RoutedEventArgs e) {}',
  ].join('\n'));
  const result = await mapUiCodeCandidates(root, ['View.cs'], xaml);
  assert.equal(result.clues[0].candidateCount, 1);
  assert.equal(result.clues[0].candidates[0].line, 4);
  assert.deepEqual(result.clues[0].candidates[0].nextRequest.lineRanges, [{ file: 'View.cs', startLine: 4, endLine: 4 }]);
}));

it('code scope is explicit and unreadable/oversized files do not turn missing matches into proof of absence', async () => fixture(async root => {
  const xaml = await source(root);
  await fs.writeFile(path.join(root, 'OutsideScope.cs'), 'public ICommand ShowCharactersCommand { get; }');
  await fs.writeFile(path.join(root, 'Empty.cs'), 'class Empty {}');
  const closed = await mapUiCodeCandidates(root, ['Empty.cs'], xaml);
  assert.equal(closed.clues[0].status, 'not-found-in-candidates');
  assert.equal(closed.clues[0].candidateCount, 0);
  await fs.writeFile(path.join(root, 'Large.cs'), 'x'.repeat(256 * 1024 + 1));
  const incomplete = await mapUiCodeCandidates(root, ['Empty.cs', 'Large.cs', 'Missing.cs'], xaml);
  assert.equal(incomplete.fileScanComplete, false);
  assert.equal(incomplete.truncated, true);
  assert.equal(incomplete.clues[0].reason, 'incomplete-candidate-scan');
}));

it('path validation precedes inspection and external junction source is never read', async () => fixture(async root => {
  for (const value of [[], ['../A.cs'], ['C:relative.cs'], ['/absolute.cs'], ['A.xaml'], Array(9).fill('A.cs')]) {
    assert.throws(() => validateCandidateCodeFiles(value), /candidateCodeFiles/);
  }
  let inspected = false;
  await assert.rejects(reviewUi(async () => { inspected = true; throw new Error('must not inspect'); }, root, { pid: 1 }, ['View.xaml'], undefined, undefined, ['../A.cs']));
  assert.equal(inspected, false);
  const xaml = await source(root);
  await fixture(async outside => {
    await fs.writeFile(path.join(outside, 'Secret.cs'), 'public ICommand ShowCharactersCommand { get; } // SECRET_TEXT');
    await fs.symlink(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = await mapUiCodeCandidates(root, ['link/Secret.cs'], xaml);
    assert.equal(result.files[0].status, 'outside-workspace');
    assert.equal(result.clues[0].candidateCount, 0);
    assert.ok(!JSON.stringify(result).includes('SECRET_TEXT'));
  });
}));

it('candidate output and scan counts are bounded and cancellation is propagated', async () => fixture(async root => {
  const xaml = await source(root);
  await fs.writeFile(path.join(root, 'Many.cs'), Array.from({ length: 300 }, (_, index) => `class C${index} { public ICommand ShowCharactersCommand { get; } }`).join('\n'));
  const result = await mapUiCodeCandidates(root, ['Many.cs'], xaml);
  assert.equal(result.truncated, true);
  assert.equal(result.fileScanComplete, false);
  assert.ok(result.clues[0].candidateCount <= 200);
  assert.ok(result.clues[0].candidates.length <= 5);
  assert.ok(JSON.stringify(result).length <= result.limits.maxOutputChars);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(mapUiCodeCandidates(root, ['Many.cs'], xaml, controller.signal), { name: 'AbortError' });
}));

it('omitting candidateCodeFiles preserves the existing review result without code scanning', async () => fixture(async root => {
  await source(root);
  const snapshot: UiInspectResult = { schemaVersion: '1.0', protocolVersion: '1.0', requestId: 'one', success: true, tree };
  const result = await reviewUi(async () => snapshot, root, { pid: 1 }, ['View.xaml']);
  assert.equal(result.codeEvidence, undefined);
  assert.equal(result.codeEvidenceOmitted, undefined);
  assert.ok(result.sourceEvidence);
}));

it('repeated runtime nodes cannot inflate code output and omitted clue totals remain visible', async () => fixture(async root => {
  await source(root);
  await fs.writeFile(path.join(root, 'Model.cs'), 'public ICommand ShowCharactersCommand { get; }');
  const repeated = { ...tree, children: Array.from({ length: 80 }, (_, index) => ({ ...tree, id: index + 2, parentId: 1 })) };
  const xaml = await mapUiSources(root, ['View.xaml'], repeated);
  const result = await mapUiCodeCandidates(root, ['Model.cs'], xaml);
  assert.equal(result.evaluatedClues, 81);
  assert.ok(result.clues.length <= 40);
  assert.equal(result.omittedClueCount + result.clues.length, 81);
  assert.equal(result.truncated, true);
  assert.ok(JSON.stringify(result).length <= 16000);
}));

it('an unreadable code candidate preserves the successful runtime and XAML evidence', async () => fixture(async root => {
  await source(root);
  const snapshot: UiInspectResult = { schemaVersion: '1.0', protocolVersion: '1.0', requestId: 'one', success: true, tree };
  const result = await reviewUi(async () => snapshot, root, { pid: 1 }, ['View.xaml'], undefined, undefined, ['Missing.cs']);
  assert.strictEqual(result.tree, tree);
  assert.equal(result.sourceEvidence!.nodes[0].candidateCount, 1);
  assert.equal(result.codeEvidence!.fileScanComplete, false);
  assert.equal(result.codeEvidence!.files[0].status, 'unreadable');
}));

it('ordinary and verbatim interpolation masks nested expressions, strings, comments and interpolated strings', async () => fixture(async root => {
  const xaml = await source(root);
  await fs.writeFile(path.join(root, 'Interpolation.cs'), [
    String.raw`string normal = $"User {user.Name}";`,
    String.raw`string nested = $"{Echo("ShowCharactersCommand = new RelayCommand(Evil)")}";`,
    String.raw`string verbatim = $@"Path ""quoted"" {Echo("ShowCharactersCommand = new RelayCommand(Evil)")}";`,
    String.raw`string otherVerbatim = @$"Path {value}";`,
    String.raw`string nestedInterpolation = $"{Echo($"{Echo("ShowCharactersCommand = new RelayCommand(Evil)")}")}";`,
    String.raw`string comments = $"{Echo(/* } " */ "ShowCharactersCommand = new RelayCommand(Evil)")}";`,
    String.raw`string braces = $"{{escaped}} {Convert('}')}";`,
    'public ICommand ShowCharactersCommand { get; }',
  ].join('\n'));
  const result = await mapUiCodeCandidates(root, ['Interpolation.cs'], xaml);
  assert.equal(result.fileScanComplete, true);
  assert.equal(result.clues[0].candidateCount, 1);
  assert.equal(result.clues[0].candidates[0].line, 8);
  assert.equal(result.clues[0].candidates[0].kind, 'declaration');
}));

it('unsupported interpolated raw strings and excessive nesting leave an explicit incomplete file scan', async () => fixture(async root => {
  const xaml = await source(root);
  let nested = '"safe"';
  for (let index = 0; index < 20; index++) nested = '$"{Echo(' + nested + ')}"';
  for (const value of ['string raw = $"""Raw {value}""";', `string nested = ${nested};`]) {
    await fs.writeFile(path.join(root, 'Complex.cs'), value + '\npublic ICommand ShowCharactersCommand { get; }');
    const result = await mapUiCodeCandidates(root, ['Complex.cs'], xaml);
    assert.equal(result.fileScanComplete, false);
    assert.equal(result.files[0].status, 'unsupported-or-unclosed-literal');
    assert.equal(result.clues[0].candidateCount, 0);
    assert.equal(result.limits.maxInterpolationDepth, 12);
  }
}));

it('multiple command assignments remain ambiguous even when a property declaration is present', async () => fixture(async root => {
  const xaml = await source(root);
  await fs.writeFile(path.join(root, 'ManyAssignments.cs'), [
    'public ICommand ShowCharactersCommand { get; }',
    'void Init() { ShowCharactersCommand = new RelayCommand(First); ShowCharactersCommand = new RelayCommand(Second); }',
  ].join('\n'));
  const result = await mapUiCodeCandidates(root, ['ManyAssignments.cs'], xaml);
  assert.equal(result.clues[0].candidateCount, 3);
  assert.equal(result.clues[0].status, 'ambiguous');
}));

it('constructor arguments stay hints and follow-up never selects literal, oversized or shadowed symbols', async () => fixture(async root => {
  const xaml = await source(root);
  for (const argument of ['null', 'true', 'false', 'M'.repeat(129), 'Handler']) {
    await fs.writeFile(path.join(root, 'Arguments.cs'), `void Init(Action Handler) { ShowCharactersCommand = new RelayCommand(${argument}); }`);
    const result = await mapUiCodeCandidates(root, ['Arguments.cs'], xaml);
    const candidate = result.clues[0].candidates[0];
    assert.equal(candidate.relatedSymbol, argument === 'Handler' ? 'Handler' : undefined);
    assert.equal(candidate.nextRequest.symbol, undefined);
    assert.deepEqual(candidate.nextRequest.lineRanges, [{ file: 'Arguments.cs', startLine: 1, endLine: 1 }]);
  }
}));

it('cancellation observed while closing the final source handle is propagated before returning success', async () => fixture(async root => {
  const xaml = await source(root);
  await fs.writeFile(path.join(root, 'Last.cs'), 'public ICommand ShowCharactersCommand { get; }');
  const controller = new AbortController();
  const originalOpen = fs.open;
  try {
    fs.open = async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      const originalClose = handle.close.bind(handle);
      handle.close = async () => { await originalClose(); controller.abort(); };
      return handle;
    };
    await assert.rejects(mapUiCodeCandidates(root, ['Last.cs'], xaml, controller.signal), { name: 'AbortError' });
  } finally { fs.open = originalOpen; }
}));
