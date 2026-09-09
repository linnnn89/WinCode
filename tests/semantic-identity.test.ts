import { it } from 'node:test';
import assert from 'node:assert/strict';
import { ImpactAnalyzer } from '../src/CompositeTools/ImpactAnalyzer.js';
import { computeTypeMatchStats, type CodeReferenceQuery, type CodeSymbol } from '../src/Core/CodeQueries.js';

const located: CodeSymbol = { name: 'Item', kind: 'class', file: 'src/Item.cs', line: 1,
  location: { snapshotId: 'a'.repeat(32), project: 'App.csproj', file: 'src/Item.cs', position: 6 } };

it('same-file same-name declarations remain distinct by semantic location', () => {
  const second = { ...located, location: { ...located.location!, position: 60 } };
  assert.deepEqual(computeTypeMatchStats([located, second], 'Item'), { uniqueTypeMatch: false, typeMatchCount: 2 });
});

for (const complete of [false, true]) {
  it(`impact skips references for ${complete ? 'ambiguous' : 'incomplete unlocated'} evidence`, async () => {
    const symbols: CodeSymbol[] = [{ name: 'Item', kind: 'class', file: 'A.cs', line: 1 },
      ...(complete ? [{ name: 'Item', kind: 'class' as const, file: 'B.cs', line: 1 }] : [])];
    let calls = 0;
    const queries: CodeReferenceQuery = {
      findSymbols: async () => symbols, findReferences: async () => [],
      findSymbolsDetailed: async () => ({ query: 'Item', symbols, source: 'roslyn', queryComplete: complete,
        totalFound: symbols.length, analysisCompleteness: 'incomplete', truncated: false, limitations: [],
        uniqueTypeMatch: false, typeMatchCount: symbols.length }),
      findReferencesDetailed: async () => { calls++; throw new Error('must not be called'); },
    };
    assert.equal((await new ImpactAnalyzer(queries).analyzeImpact('Item')).riskLevel, 'UNKNOWN');
    assert.equal(calls, 0);
  });
}

it('impact forwards the selected snapshot location and cancellation context', async () => {
  let forwarded: unknown[] = [];
  const queries: CodeReferenceQuery = {
    findSymbols: async () => [located], findReferences: async () => [],
    findSymbolsDetailed: async () => ({ query: 'Item', symbols: [located], totalFound: 1, source: 'roslyn',
      queryComplete: false, analysisCompleteness: 'incomplete', truncated: false, limitations: [], uniqueTypeMatch: true, typeMatchCount: 1 }),
    findReferencesDetailed: async (...args) => {
      forwarded = args;
      return { symbolName: 'Item', totalReferences: 0, references: [], source: 'roslyn', queryComplete: false,
        analysisCompleteness: 'incomplete', truncated: false, limitations: [] };
    },
  };
  const operation = { signal: new AbortController().signal };
  await new ImpactAnalyzer(queries).analyzeImpact('Item', operation);
  assert.deepEqual(forwarded, ['Item', 'src/Item.cs', operation, located.location]);
});

// Caller-selected overloads must be validated before any search can refresh the snapshot.
it('selected overload keeps exact references and validates before searching', async () => {
  const order: string[] = [];
  const second = { ...located, location: { ...located.location!, position: 60 } };
  const queries: CodeReferenceQuery = {
    findSymbols: async () => [], findReferences: async () => [],
    findSymbolsDetailed: async () => {
      order.push('search');
      return { query: 'Item', symbols: [second, located], source: 'roslyn', queryComplete: false,
        totalFound: 2, analysisCompleteness: 'incomplete', truncated: false, limitations: [], uniqueTypeMatch: false, typeMatchCount: 2 };
    },
    findReferencesDetailed: async (name, file, operation, location) => {
      order.push('validate');
      assert.deepEqual(location, located.location);
      return { symbolName: name, references: [{ file: 'Consumer.cs', line: 3, symbolName: name, preview: 'Item' }], totalReferences: 1,
        source: 'roslyn', queryComplete: false, analysisCompleteness: 'incomplete', truncated: false, limitations: [] };
    },
  };
  const result = await new ImpactAnalyzer(queries).analyzeImpact('Item', undefined, located.location);
  assert.deepEqual(order, ['validate', 'search']);
  assert.deepEqual(result.symbolLocation, located.location);
  assert.equal(result.referencesCount, 1);
  assert.equal(result.riskLevel, 'UNKNOWN');
  assert.equal(result.matchedSymbols.length, 1);
});

it('stale selection stops before a search can replace the snapshot', async () => {
  let searches = 0;
  const queries: CodeReferenceQuery = {
    findSymbols: async () => [], findReferences: async () => [],
    findSymbolsDetailed: async () => { searches++; throw new Error('must not search'); },
    findReferencesDetailed: async () => { throw new Error('SNAPSHOT_STALE'); },
  };
  await assert.rejects(new ImpactAnalyzer(queries).analyzeImpact('Item', undefined, located.location), /SNAPSHOT_STALE/);
  assert.equal(searches, 0);
});
