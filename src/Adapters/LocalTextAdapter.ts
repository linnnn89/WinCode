import path from 'node:path';
import type { WinCodeConfig } from '../Core/Config.js';
import type { AdapterHealth } from '../Core/AdapterStatus.js';
import type { CacheManager } from '../Core/Cache.js';
import { checkOperation, type OperationContext } from '../Core/OperationContext.js';
import { scanLocalFiles } from '../Core/LocalTextScanner.js';
import { parseTextDeclarations } from '../Core/TextDeclarations.js';
import { CodeQueryError, LOCAL_TEXT_LIMITATIONS, computeTypeMatchStats,
  type CodeSymbol, type SymbolReference, type FindSymbolsResult, type FindReferencesResult } from '../Core/CodeQueries.js';

export type { CodeSymbol, SymbolReference, FindSymbolsResult, FindReferencesResult } from '../Core/CodeQueries.js';

/** 本体文本能力：不创建子进程或网络连接；扫描完整性与语义完整性分开报告。 */
export class LocalTextAdapter {
  readonly name = 'LocalTextAdapter';
  private observedAt: string | null = null;

  constructor(private readonly config: WinCodeConfig, private readonly cache: CacheManager) {}

  /** 本地能力始终可用；不把未配置 Roslyn 伪装为语义后端就绪。 */
  private health(): AdapterHealth {
    return { available: true, source: 'fallback',
      details: 'Local text search only. Semantic analysis is not configured; explicitly configure Roslyn for C# semantic queries.' };
  }

  async initialize(): Promise<void> { this.observedAt = new Date().toISOString(); }
  async checkHealth(): Promise<AdapterHealth> { await this.initialize(); return this.health(); }
  getKnownHealth() { return { health: this.health(), observedAt: this.observedAt }; }
  /** 没有外部连接；缓存和扫描请求的生命周期分别由 CacheManager 和调用方负责。 */
  async dispose(): Promise<void> {}

  /** 只解析调用方已经读取的文本；不声称正则结果具有 Roslyn 的快照身份。 */
  findSymbolsInContent(content: string, file: string): CodeSymbol[] {
    return parseTextDeclarations(content, file, path.extname(file).toLowerCase());
  }

  async findSymbols(query: string, kind?: string, operation?: OperationContext): Promise<CodeSymbol[]> {
    return (await this.findSymbolsDetailed(query, kind, undefined, operation)).symbols;
  }

  /** 精确文件范围在读取正文前应用；受限或失败结果不写入缓存。 */
  async findSymbolsDetailed(query: string, kind?: string, relativePath?: string, operation?: OperationContext): Promise<FindSymbolsResult> {
    checkOperation(operation);
    const fingerprint = await this.cache.computeWorkspaceFingerprint(this.config.workspaceRoot);
    const key = `local_text_symbols_v1_${JSON.stringify([query, kind, relativePath, this.config.workspaceRoot])}`;
    const cached = await this.cache.get<FindSymbolsResult>(key, fingerprint);
    checkOperation(operation);
    if (cached?.queryComplete) return cached;
    const scan = await scanLocalFiles(this.config.workspaceRoot, this.config.timeouts.fileScanMs,
      ['.cs', '.ts', '.js', '.py'], 500,
      (content, file, extension) => parseTextDeclarations(content, file, extension).filter(symbol =>
        symbol.name.toLowerCase().includes(query.toLowerCase()) && (!kind || symbol.kind.toLowerCase() === kind.toLowerCase())),
      relativePath, operation);
    const stats = computeTypeMatchStats(scan.items, query);
    const result: FindSymbolsResult = {
      query, kindFilter: kind, totalFound: scan.items.length, symbols: scan.items, source: 'local-text',
      analysisCompleteness: scan.complete ? 'degraded' : 'incomplete',
      limitations: [...(scan.error ? [`查询不完整: ${scan.error}`] : []), ...LOCAL_TEXT_LIMITATIONS],
      queryComplete: scan.complete, queryError: scan.error, truncated: scan.truncated,
      uniqueTypeMatch: scan.complete && !scan.truncated && stats.uniqueTypeMatch, typeMatchCount: stats.typeMatchCount,
    };
    checkOperation(operation);
    if (scan.complete) await this.cache.set(key, result, { fingerprint, ttlMs: 300000 });
    return result;
  }

  async findReferences(symbolName: string, relativePath?: string, operation?: OperationContext): Promise<SymbolReference[]> {
    return (await this.findReferencesDetailed(symbolName, relativePath, operation)).references;
  }

  /** defining file 仅为提示；文本引用仍扫描工作区，不把旧 Serena 重载身份静默降为简单名。 */
  async findReferencesDetailed(symbolName: string, relativePath?: string, operation?: OperationContext): Promise<FindReferencesResult> {
    checkOperation(operation);
    if (symbolName.includes('/') || /\[\d+\]/.test(symbolName)) throw new CodeQueryError('LEGACY_SYMBOL_ID', 'Legacy Serena identities are retired; supply a plain name or configure Roslyn and search again.');
    const fingerprint = await this.cache.computeWorkspaceFingerprint(this.config.workspaceRoot);
    const key = `local_text_references_v1_${JSON.stringify([symbolName, relativePath, this.config.workspaceRoot])}`;
    const cached = await this.cache.get<FindReferencesResult>(key, fingerprint);
    checkOperation(operation);
    if (cached?.queryComplete) return cached;
    const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`\\b${escaped}\\b`);
    const declaration = new RegExp(`(^|\\s)(class|interface|struct|enum)\\s+${escaped}\\b`);
    const scan = await scanLocalFiles<SymbolReference>(this.config.workspaceRoot, this.config.timeouts.fileScanMs,
      ['.cs', '.ts', '.tsx', '.js', '.jsx', '.py', '.xaml', '.xml', '.csproj', '.sln'], 200,
      function* (content, file) {
        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length; index++) {
          const preview = lines[index].trim();
          if (/^(?:\/\/|\*|\/\*|#|<!--)/.test(preview) || declaration.test(preview)) continue;
          if (match.test(lines[index])) yield { symbolName, file, line: index + 1, preview };
        }
      }, undefined, operation);
    const result: FindReferencesResult = {
      symbolName, totalReferences: scan.items.length, references: scan.items, source: 'local-text',
      analysisCompleteness: scan.complete ? 'degraded' : 'incomplete',
      limitations: [...(scan.error ? [`查询不完整: ${scan.error}`] : []), ...LOCAL_TEXT_LIMITATIONS],
      queryComplete: scan.complete, queryError: scan.error, truncated: scan.truncated,
    };
    checkOperation(operation);
    if (scan.complete) await this.cache.set(key, result, { fingerprint, ttlMs: 300000 });
    return result;
  }
}
