import type { OperationContext } from './OperationContext.js';

/** 语义来源与查询完整性独立；新增来源不能自动提高影响分析置信度。 */
export type CodeSource = 'local-text' | 'roslyn';

/** 当前 Host 快照内的精确定位；position 为零基 UTF-16，编辑、重载或切换后不可复用。 */
export interface SymbolLocation {
  snapshotId: string;
  project: string;
  file: string;
  position: number;
}

/** 直接语义查询实际采用的快照与输入校验范围；该对象不代表全磁盘或生成代码覆盖。 */
export interface SemanticContext {
  snapshotId: string;
  scope: 'loaded-solution-snapshot';
  diskFreshnessVerified: false;
  excludedAnalyzers: number;
  freshness: { status: 'checked'; scope: string; fingerprint: string; files: number; bytes: number; externalCustomInputsVerified: false };
}

/** 代码查询的领域失败；Gateway 保留稳定错误码，不对所有工具实施新的错误信封。 */
export class CodeQueryError extends Error {
  constructor(readonly errorCode: string, message: string) { super(message); this.name = 'CodeQueryError'; }
}
export const LOCAL_TEXT_LIMITATIONS: string[] = [
  '声明扫描屏蔽注释、字符串及 JSX 元素（含插值）；复杂词法/语法不保证完整，无法可靠定界的文件标记 lexical-uncertainty。引用仍为文本线索。',
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
  /** Roslyn 返回的当前快照定位；不使用 Serena namePath 或重载序号推导它。 */
  location?: SymbolLocation;
  column?: number;
}

export interface SymbolReference {
  symbolName: string;
  file: string;
  line: number;
  preview: string;
  lineKind?: 'reference' | 'containing-symbol';
  column?: number;
  start?: number;
  length?: number;
  project?: string;
}

export interface FindSymbolsResult {
  fileIssues?: { path: string; reason: string }[];
  fileIssuesOmitted?: number;
  semanticContext?: SemanticContext;
  query: string;
  kindFilter?: string;
  totalFound: number;
  symbols: CodeSymbol[];
  source: CodeSource;
  analysisCompleteness: 'semantic' | 'degraded' | 'incomplete';
  limitations: string[];
  queryComplete: boolean;
  queryError?: string;
  truncated: boolean;
  uniqueTypeMatch: boolean;
  typeMatchCount: number;
}

export interface FindReferencesResult {
  fileIssues?: { path: string; reason: string }[];
  fileIssuesOmitted?: number;
  semanticContext?: SemanticContext;
  symbolName: string;
  totalReferences: number;
  references: SymbolReference[];
  source: CodeSource;
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
  symbolLocation?: SymbolLocation;
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
    (s.file || '').replace(/\\/g, '/'), s.location ?? s.namePath ?? [s.containerName, s.name, s.line],
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
  findReferencesDetailed?(symbolName: string, relativePath?: string, operation?: OperationContext, location?: SymbolLocation): Promise<FindReferencesResult>;
}

export interface ContextCodeQuery extends CodeSymbolQuery {
  findSymbolsInContent(content: string, relativePath: string): CodeSymbol[];
}
