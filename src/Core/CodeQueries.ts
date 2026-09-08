import type { OperationContext } from './OperationContext.js';
export const SERENA_DEGRADED_LIMITATIONS: string[] = [
  '本地正则扫描仅作为文本检索降级方案，不保证符号身份、重载区分、跨文件引用完整性或安全重命名。',
  '本地正则扫描无法替代完整 Roslyn/TypeScript LSP 语义层面的跨文件重命名与重载解析。',
  '未找到引用不得直接解释为“无影响”或“低风险”。',
];

export interface CodeSymbol {
  name: string;
  kind: 'class' | 'interface' | 'method' | 'function' | 'property' | 'enum' | 'struct' | 'type';
  file: string;
  line: number;
  signature?: string;
  containerName?: string;
  /** Exact upstream identity, including overload indices; name is only a display label. */
  namePath?: string;
}

export interface SymbolReference {
  symbolName: string;
  file: string;
  line: number;
  preview: string;
  lineKind?: 'reference' | 'containing-symbol';
}

export interface FindSymbolsResult {
  query: string;
  kindFilter?: string;
  totalFound: number;
  symbols: CodeSymbol[];
  source: 'serena-mcp' | 'serena-adapter-fallback';
  analysisCompleteness: 'semantic' | 'degraded' | 'incomplete';
  limitations: string[];
  queryComplete: boolean;
  queryError?: string;
  truncated: boolean;
  uniqueTypeMatch: boolean;
  typeMatchCount: number;
}

export interface FindReferencesResult {
  symbolName: string;
  totalReferences: number;
  references: SymbolReference[];
  source: 'serena-mcp' | 'serena-adapter-fallback';
  analysisCompleteness: 'semantic' | 'degraded' | 'incomplete';
  limitations: string[];
  queryComplete: boolean;
  queryError?: string;
  truncated: boolean;
  resolution?: 'resolved' | 'ambiguous' | 'not-found' | 'incomplete' | 'unavailable';
  candidates?: CodeSymbol[];
  candidateCount?: number;
  candidatesTruncated?: boolean;
  target?: { namePath: string; relativePath: string };
}

const TYPE_KINDS = new Set(['class', 'interface', 'struct', 'enum']);

export function computeTypeMatchStats(
  symbols: CodeSymbol[],
  query: string
): { uniqueTypeMatch: boolean; typeMatchCount: number } {
  const typeMatches = symbols.filter(
    (s) => TYPE_KINDS.has((s.kind || '').toLowerCase()) && s.name === query
  );
  const identities = new Set(typeMatches.map((s) => JSON.stringify([
    (s.file || '').replace(/\\/g, '/'), s.namePath ?? [s.containerName, s.name, s.line],
  ])));
  const typeMatchCount = identities.size;
  return {
    typeMatchCount,
    uniqueTypeMatch: typeMatchCount === 1,
  };
}

/** Legacy array methods remain required; detailed results are optional for older consumers. */
export interface CodeSymbolQuery {
  findSymbols(query: string, kindFilter?: string, operation?: OperationContext): Promise<CodeSymbol[]>;
  findSymbolsDetailed?(query: string, kindFilter?: string, relativePath?: string, operation?: OperationContext): Promise<FindSymbolsResult>;
}

export interface CodeReferenceQuery extends CodeSymbolQuery {
  findReferences(symbolName: string, relativePath?: string, operation?: OperationContext): Promise<SymbolReference[]>;
  findReferencesDetailed?(symbolName: string, relativePath?: string, operation?: OperationContext): Promise<FindReferencesResult>;
}

export interface ContextCodeQuery extends CodeSymbolQuery {
  findSymbolsInContent(content: string, relativePath: string): CodeSymbol[];
}
