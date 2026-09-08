import { it } from 'node:test';
import assert from 'node:assert/strict';
import { SerenaAdapter, computeTypeMatchStats, type CodeSymbol } from '../src/Adapters/SerenaAdapter.js';
import { ImpactAnalyzer } from '../src/CompositeTools/ImpactAnalyzer.js';
import { getDefaultConfig } from '../src/Core/Config.js';

const symbol = (namePath = 'Service/Save[0]', file = 'src/Service.cs', line = 0, kind = 'Method') => ({
  name_path: namePath, kind, relative_path: file, body_location: { start_line: line, end_line: line + 5 },
});
const textResult = (value: unknown) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] });

function fixture(symbols: unknown = [symbol()], references: unknown = {}) {
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  let fallbacks = 0;
  const cached = new Map<string, unknown>();
  const cache = {
    computeWorkspaceFingerprint: async () => 'fixture',
    get: async (key: string) => cached.get(key),
    set: async (key: string, value: unknown) => { cached.set(key, value); },
  };
  const adapter = new SerenaAdapter(getDefaultConfig(process.cwd()), cache as any);
  Object.assign(adapter as any, {
    ensureConnected: async () => true,
    isConnectedToSerena: true,
    serenaTools: new Set(['find_symbol', 'find_referencing_symbols']),
    serenaClient: {
      callTool: async (call: { name: string; arguments: Record<string, unknown> }) => {
        calls.push(call);
        return textResult(call.name === 'find_symbol' ? symbols : references);
      },
    },
    scanSymbolsLocally: async () => { fallbacks++; return { items: [], complete: true, truncated: false }; },
    scanReferencesLocally: async () => { fallbacks++; return { items: [], complete: true, truncated: false }; },
  });
  return { adapter, calls, cached, fallbackCount: () => fallbacks };
}

it('preserves full name paths, overloads, explicit display names, and zero-based coordinates', () => {
  const { adapter } = fixture();
  const mapped = adapter.mapSerenaSymbols(JSON.stringify([
    symbol(), { ...symbol('Outer/Service/Save[1]', 'src/Service.cs', 25), name: 'Save' },
  ]), 'Save');
  assert.deepEqual(mapped.map(s => [s.name, s.namePath, s.containerName, s.line]), [
    ['Save', 'Service/Save[0]', 'Service', 1], ['Save', 'Outer/Service/Save[1]', 'Outer/Service', 26],
  ]);
});

it('counts same-file same-name types by identity rather than defining file', () => {
  const { adapter } = fixture();
  const types = adapter.mapSerenaSymbols(JSON.stringify([
    symbol('A/Item', 'Types.cs', 0, 'Class'), symbol('B/Item', 'Types.cs', 10, 'Class'),
  ]), 'Item');
  assert.deepEqual(computeTypeMatchStats(types, 'Item'), { uniqueTypeMatch: false, typeMatchCount: 2 });
  assert.equal(computeTypeMatchStats(types, 'item').uniqueTypeMatch, false);
});

it('simple-name resolution passes canonical identity and scoped search to the reference tool', async () => {
  const { adapter, calls } = fixture();
  const result = await adapter.findReferencesDetailed('Save', 'src/Service.cs');
  assert.deepEqual(calls.map(c => c.arguments), [
    { name_path_pattern: 'Save', relative_path: 'src/Service.cs' },
    { name_path: '/Service/Save[0]', relative_path: 'src/Service.cs' },
  ]);
  assert.equal(result.resolution, 'resolved');
  assert.deepEqual(result.target, { namePath: 'Service/Save[0]', relativePath: 'src/Service.cs' });
  assert.equal(result.queryComplete, true);
});

it('explicit identity uses an absolute name-path match to prevent stale suffix redirection', async () => {
  const { adapter, calls } = fixture();
  await adapter.findReferencesDetailed('Service/Save[1]', 'src/Service.cs');
  assert.deepEqual(calls, [{ name: 'find_referencing_symbols', arguments: {
    name_path: '/Service/Save[1]', relative_path: 'src/Service.cs',
  } }]);
});

it('ambiguous identities keep the full count while limiting returned candidates', async () => {
  const { adapter, calls } = fixture(Array.from({ length: 41 }, (_, index) => symbol(`Service/Save[${index}]`)));
  const result = await adapter.findReferencesDetailed('Save');
  assert.equal(result.resolution, 'ambiguous');
  assert.equal(result.candidateCount, 41);
  assert.equal(result.candidates?.length, 20);
  assert.equal(result.candidatesTruncated, true);
  assert.equal(calls.filter(call => call.name === 'find_referencing_symbols').length, 0);
});

for (const sameFile of [true, false]) {
  it('refuses automatic selection among ' + (sameFile ? 'same-file overloads' : 'cross-file names'), async () => {
    const { adapter, calls, fallbackCount } = fixture([
      symbol(), symbol(sameFile ? 'Service/Save[1]' : 'Other/Save[0]', sameFile ? 'src/Service.cs' : 'src/Other.cs', 9),
    ]);
    const result = await adapter.findReferencesDetailed('Save');
    assert.equal(result.resolution, 'ambiguous');
    assert.equal(result.queryComplete, false);
    assert.equal(result.candidates?.length, 2);
    assert.equal(calls.filter(c => c.name === 'find_referencing_symbols').length, 0);
    assert.equal(fallbackCount(), 0);
  });
}

it('valid empty symbol results remain semantic and do not fall back or become reference evidence', async () => {
  const { adapter, calls, fallbackCount } = fixture([]);
  const found = await adapter.findSymbolsDetailed('Save');
  assert.equal(found.queryComplete, true);
  assert.equal(found.source, 'serena-mcp');
  const refs = await adapter.findReferencesDetailed('Save');
  assert.equal(refs.resolution, 'not-found');
  assert.equal(refs.queryComplete, false);
  assert.equal(calls.filter(c => c.name === 'find_referencing_symbols').length, 0);
  assert.equal(fallbackCount(), 0);
});

for (const empty of [{}, []]) {
  it('accepts valid empty reference shape ' + JSON.stringify(empty) + ' without fallback', async () => {
    const { adapter, fallbackCount } = fixture([symbol()], empty);
    const result = await adapter.findReferencesDetailed('Service/Save[0]', 'src/Service.cs');
    assert.equal(result.queryComplete, true);
    assert.equal(result.source, 'serena-mcp');
    assert.deepEqual(result.references, []);
    assert.equal(fallbackCount(), 0);
  });
}

for (const raw of ['{broken', 'null', '{"unexpected":[]}', '[{}]', 'The answer is too long (123 characters).',
  'Shortened result:\n{"A.cs":["A/Save"]}', 'Found 7 references.']) {
  it('does not cache malformed or shortened output as successful: ' + raw.slice(0, 40), async () => {
    const { adapter, cached } = fixture(raw, raw);
    const found = await adapter.findSymbolsDetailed('Save');
    assert.equal(found.queryComplete, false);
    assert.equal(found.analysisCompleteness, 'incomplete');
    const refs = await adapter.findReferencesDetailed('Service/Save[0]', 'src/Service.cs');
    assert.equal(refs.queryComplete, false);
    assert.equal(refs.analysisCompleteness, 'incomplete');
    assert.equal(cached.size, 0);
    assert.equal(refs.truncated, /^(The answer|Shortened|Found)/.test(raw));
  });
}

it('a valid candidate plus an invalid candidate is incomplete, never uniquely traceable', async () => {
  const { adapter, calls } = fixture([symbol(), { name_path: 'Other/Save' }]);
  const refs = await adapter.findReferencesDetailed('Save');
  assert.equal(refs.resolution, 'incomplete');
  assert.equal(refs.candidates?.length, 1);
  assert.equal(calls.filter(c => c.name === 'find_referencing_symbols').length, 0);
});

it('a partial same-name type list cannot claim a unique match', async () => {
  const { adapter } = fixture([symbol('Item', 'Item.cs', 0, 'Class'), { name_path: 'Other/Item' }]);
  const found = await adapter.findSymbolsDetailed('Item');
  assert.equal(found.typeMatchCount, 1);
  assert.equal(found.queryComplete, false);
  assert.equal(found.uniqueTypeMatch, false);
});

it('missing upstream identity cannot be reconstructed from a display name', async () => {
  const { adapter, calls } = fixture([{ name: 'Save', file: 'src/Service.cs', line: 1, kind: 'method' }]);
  const result = await adapter.findReferencesDetailed('Save');
  assert.equal(result.resolution, 'incomplete');
  assert.equal(calls.filter(c => c.name === 'find_referencing_symbols').length, 0);
});

it('normalizes grouped reference coordinates and identifies containing-symbol locations', async () => {
  const references = { 'src/Caller.cs': { Method: [
    { name_path: 'Caller/Run', body_location: { start_line: 25 }, content_around_reference: 'Save();' },
    { name_path: 'Caller/First', reference_line: 0, body_location: { start_line: 9 }, content_around_reference: 'Save();' },
  ] } };
  const { adapter } = fixture([symbol()], references);
  const result = await adapter.findReferencesDetailed('Service/Save[0]', 'src/Service.cs');
  assert.equal(result.queryComplete, true);
  assert.deepEqual(result.references.map(r => [r.line, r.lineKind]), [[26, 'containing-symbol'], [1, 'reference']]);
});

it('summary-like text inside a valid JSON reference snippet is ordinary source text', async () => {
  const { adapter } = fixture([symbol()], [{ file: 'Caller.cs', reference_line: 4, preview: 'print("Found 7 references.")' }]);
  const result = await adapter.findReferencesDetailed('Service/Save[0]', 'src/Service.cs');
  assert.equal(result.queryComplete, true);
  assert.equal(result.references.length, 1);
});

it('overview-only upstream is not invoked as a global symbol search', async () => {
  const { adapter, calls } = fixture();
  (adapter as any).serenaTools = new Set(['get_symbols_overview']);
  const result = await adapter.findSymbolsDetailed('Save');
  assert.equal(result.source, 'serena-adapter-fallback');
  assert.equal(calls.length, 0);
});

it('structured content is parsed even when there is no text content', async () => {
  const { adapter } = fixture();
  (adapter as any).serenaClient.callTool = async () => ({ content: [], structuredContent: [symbol()] });
  const found = await adapter.findSymbolsDetailed('Save');
  assert.equal(found.queryComplete, true);
  assert.equal(found.symbols[0].namePath, 'Service/Save[0]');
});

it('unwraps the real Serena 1.7 FastMCP string envelope for symbols and references', async () => {
  const { adapter } = fixture();
  (adapter as any).serenaClient.callTool = async ({name}: {name:string}) => ({ content: [], structuredContent: {
    result: JSON.stringify(name === 'find_symbol' ? [symbol()] : { 'Caller.cs': { Class: [
      { name_path: 'Caller', body_location: {start_line: 9, end_line: 12}, content_around_reference: 'Save(7);' },
    ] } }),
  } });
  const found = await adapter.findSymbolsDetailed('Save');
  assert.equal(found.source, 'serena-mcp');
  assert.equal(found.symbols[0].namePath, 'Service/Save[0]');
  const refs = await adapter.findReferencesDetailed('Service/Save[0]', 'src/Service.cs');
  assert.equal(refs.queryComplete, true);
  assert.equal(refs.source, 'serena-mcp');
  assert.equal(refs.references[0].line, 10);
  assert.equal(refs.references[0].lineKind, 'containing-symbol');
});

for (const value of ['[]', 'Error: No active project.', 'The answer is too long', 'not-json']) {
  it(`preserves envelope payload semantics: ${value}`, async () => {
    const { adapter } = fixture();
    (adapter as any).serenaClient.callTool = async () => ({ content: [], structuredContent: { result: value } });
    const found = await adapter.findSymbolsDetailed('Save');
    assert.equal(found.queryComplete, value === '[]');
    assert.equal(found.source, value === '[]' ? 'serena-mcp' : 'serena-adapter-fallback');
    if (value === 'Error: No active project.') assert.equal(adapter.getUpstreamStatus().projectActive, false);
  });
}

it('does not hide extra envelope metadata or turn malformed structured content into text success', async () => {
  const { adapter } = fixture();
  (adapter as any).serenaClient.callTool = async () => ({ content: [{type:'text',text:JSON.stringify([symbol()])}],
    structuredContent: { result: JSON.stringify([symbol()]), truncated: true } });
  const found = await adapter.findSymbolsDetailed('Save');
  assert.equal(found.queryComplete, false);
});

for (const complete of [true, false]) {
  it('ImpactAnalyzer skips reference calls for ' + (complete ? 'ambiguous' : 'incomplete') + ' identity', async () => {
    const { adapter } = fixture();
    const symbols = adapter.mapSerenaSymbols(JSON.stringify([
      symbol('A/Item', 'Types.cs', 0, 'Class'), ...(complete ? [symbol('B/Item', 'Types.cs', 10, 'Class')] : []),
    ]), 'Item');
    let refCalls = 0;
    adapter.findSymbolsDetailed = async () => ({ symbols, source: 'serena-mcp', queryComplete: complete, limitations: [] } as any);
    adapter.findReferencesDetailed = async () => { refCalls++; throw new Error('must not be called'); };
    const report = await new ImpactAnalyzer(adapter).analyzeImpact('Item');
    assert.equal(refCalls, 0);
    assert.equal(report.riskLevel, 'UNKNOWN');
  });
}

it('ImpactAnalyzer forwards the located full name path instead of its display name', async () => {
  const { adapter } = fixture();
  const located: CodeSymbol = { name: 'Item', namePath: 'Namespace/Item', file: 'src/Item.cs', kind: 'class', line: 1 };
  adapter.findSymbolsDetailed = async () => ({ symbols: [located], source: 'serena-mcp', queryComplete: true, limitations: [] } as any);
  let forwarded: unknown[] = [];
  adapter.findReferencesDetailed = async (...args) => {
    forwarded = args;
    return { references: [], source: 'serena-mcp', queryComplete: true, limitations: [] } as any;
  };
  const operation = { signal: new AbortController().signal };
  await new ImpactAnalyzer(adapter).analyzeImpact('Item', operation);
  assert.deepEqual(forwarded, ['Namespace/Item', 'src/Item.cs', operation]);
});
