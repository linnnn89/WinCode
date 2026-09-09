import path from 'path';
import type { OperationContext } from '../Core/OperationContext.js';
import {
  CodeReferenceQuery,
  CodeSymbol,
  SymbolReference,
  SERENA_DEGRADED_LIMITATIONS,
  computeTypeMatchStats,
  FindSymbolsResult,
  FindReferencesResult,
  type CodeSource,
} from '../Core/CodeQueries.js';
import { WinCodeConfig } from '../Core/Config.js';

export interface AffectedComponent {
  name: string;
  file: string;
  references: number;
  sampleLines: number[];
}

export interface ImpactReport {
  target: string;
  targetFile: string;
  targetKind?: string;
  referencesCount: number;
  affected: string[];
  affectedComponents: AffectedComponent[];
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';
  riskReason: string;
  confidence: 'HIGH' | 'MEDIUM' | 'UNCERTAIN';
  source: CodeSource | 'unknown';
  analysisCompleteness: 'semantic' | 'degraded' | 'unindexed' | 'incomplete';
  limitations: string[];
  uniqueResolution: boolean;
  queryComplete: boolean;
  recommendations: string[];
  formattedReport: string;

  // Backward compatibility fields
  matchedSymbols: CodeSymbol[];
  affectedFiles: string[];
  downstreamImpacts: {
    file: string;
    occurrences: number;
  }[];
}

interface QueryAssessment {
  source: CodeSource | 'unknown';
  queryComplete: boolean;
  queryError?: string;
  unique: boolean;
  typeMatchCount: number;
  truncated: boolean;
  limitations: string[];
}

export class ImpactAnalyzer {
  private serena: CodeReferenceQuery;
  private config?: WinCodeConfig;

  constructor(serena: CodeReferenceQuery, config?: WinCodeConfig) {
    this.serena = serena;
    this.config = config;
  }

  /**
   * Estimates blast radius from uniquely resolved symbols.
   * Confidence is not derived from source alone. Zero refs / ambiguity / incomplete
   * queries return UNKNOWN and must not be treated as safe to delete.
   */
  async analyzeImpact(target: string, operation?: OperationContext): Promise<ImpactReport> {
    const rawTarget = target.trim();
    if (!rawTarget) {
      throw new Error('Target parameter is required for impact analysis.');
    }

    let symbolName = rawTarget;
    let explicitFileHint: string | undefined = undefined;

    const extMatch = rawTarget.match(/\.(cs|ts|tsx|js|jsx|py|go|rs|java)$/i);
    if (extMatch) {
      explicitFileHint = rawTarget;
      let base = path.basename(rawTarget);
      base = base.replace(/\.(xaml|designer|g|spec|test)\.[^.]+$/i, '');
      base = base.replace(/\.[^.]+$/, '');
      symbolName = base;
    }

    let symbols: CodeSymbol[] = [];
    const matchesTarget = (symbol: CodeSymbol): boolean => symbol.name === symbolName ||
      (symbol.namePath !== undefined && symbol.namePath.replace(/^\//, '') === symbolName.replace(/^\//, ''));
    const assessment: QueryAssessment = {
      source: 'unknown',
      queryComplete: true,
      unique: false,
      typeMatchCount: 0,
      truncated: false,
      limitations: [],
    };

    if (typeof this.serena.findSymbolsDetailed === 'function') {
      const symRes: FindSymbolsResult = await this.serena.findSymbolsDetailed(symbolName, undefined, undefined, operation);
      symbols = symRes.symbols || [];
      assessment.source = symRes.source || 'serena-adapter-fallback';
      assessment.queryComplete = symRes.queryComplete !== false;
      assessment.queryError = symRes.queryError;
      assessment.truncated = Boolean(symRes.truncated);
      assessment.limitations.push(...(symRes.limitations || []));
      const stats = computeTypeMatchStats(symbols, symbolName);
      assessment.typeMatchCount = stats.typeMatchCount;
      assessment.unique = stats.uniqueTypeMatch;
    } else {
      symbols = await this.serena.findSymbols(symbolName, undefined, operation);
      assessment.source = 'serena-adapter-fallback';
      const stats = computeTypeMatchStats(symbols, symbolName);
      assessment.typeMatchCount = stats.typeMatchCount;
      assessment.unique = stats.uniqueTypeMatch;
    }

    if (explicitFileHint) {
      const normalizedHint = explicitFileHint.replace(/\\/g, '/').toLowerCase();
      const hintBase = path.basename(explicitFileHint).toLowerCase();
      const hasDir = explicitFileHint.includes('/') || explicitFileHint.includes('\\');
      const resolvedHint = path.isAbsolute(explicitFileHint) ? path.resolve(explicitFileHint).toLowerCase() : null;

      const inFile = symbols.filter((s) => {
        const symFile = (s.file || '').replace(/\\/g, '/').toLowerCase();
        if (hasDir) {
          if (resolvedHint) {
            return path.resolve(s.file).toLowerCase() === resolvedHint;
          }
          return symFile === normalizedHint || symFile.endsWith('/' + normalizedHint);
        } else {
          return path.basename(symFile) === hintBase;
        }
      });

      if (inFile.length > 0) {
        symbols = inFile;
        const distinctFiles = new Set(inFile.map((s) => (s.file || '').replace(/\\/g, '/').toLowerCase()));
        if (distinctFiles.size > 1) {
          // Ambiguous: multiple files match the filename hint
          assessment.unique = false;
          assessment.typeMatchCount = distinctFiles.size;
        } else {
          // Exactly one file matched: check symbol uniqueness within this file
          const stats = computeTypeMatchStats(inFile, symbolName);
          if (stats.uniqueTypeMatch) {
            assessment.unique = true;
            assessment.typeMatchCount = 1;
          } else {
            const exact = inFile.filter(matchesTarget);
            if (exact.length === 1) {
              assessment.unique = true;
              assessment.typeMatchCount = 1;
            } else {
              assessment.unique = false;
              assessment.typeMatchCount = exact.length;
            }
          }
        }
      } else {
        symbols = [];
        assessment.unique = false;
        assessment.typeMatchCount = 0;
      }
    } else if (!assessment.unique) {
      const exact = symbols.filter(matchesTarget);
      if (assessment.typeMatchCount === 0 && exact.length === 1) {
        assessment.unique = true;
      }
    }

    let matchedSymbol: CodeSymbol | undefined;
    if (symbols.length > 0) {
      matchedSymbol =
        symbols.find(
          (s) =>
            matchesTarget(s) &&
            ['class', 'interface', 'struct', 'enum'].includes((s.kind || '').toLowerCase())
        ) ||
        symbols.find(matchesTarget) ||
        symbols[0];
    }

    const isSymbolDeclared = Boolean(matchedSymbol);
    if (!isSymbolDeclared) {
      return this.unresolvedReport(rawTarget, symbolName, assessment, symbols);
    }

    if (!assessment.unique) {
      assessment.limitations.unshift(
        `目标 "${symbolName}" 未能唯一解析（${assessment.typeMatchCount} 个同名类型）。混合引用不能作为影响面证据。`
      );
    }

    let targetFile = '';
    if (matchedSymbol?.file) {
      targetFile = path.basename(matchedSymbol.file);
    } else if (explicitFileHint) {
      targetFile = path.basename(explicitFileHint);
    } else {
      targetFile = `${symbolName}.cs`;
    }

    let refs: SymbolReference[] = [];
    // 精确 Roslyn 定位允许收集局部引用；风险/置信度仍保留 queryComplete=false 的 UNKNOWN 限制。
    if (assessment.unique && (assessment.queryComplete || matchedSymbol?.location) && !assessment.truncated &&
        typeof this.serena.findReferencesDetailed === 'function') {
      const refRes: FindReferencesResult = matchedSymbol?.location ? await this.serena.findReferencesDetailed(
        matchedSymbol.name, matchedSymbol.file, operation, matchedSymbol.location
      ) : await this.serena.findReferencesDetailed(matchedSymbol?.namePath ?? symbolName, matchedSymbol?.file, operation);
      refs = refRes.references || [];
      if (refRes.source) assessment.source = refRes.source;
      if (refRes.queryComplete === false) {
        assessment.queryComplete = false;
        assessment.queryError = refRes.queryError || assessment.queryError;
      }
      if (refRes.truncated) {
        assessment.truncated = true;
        assessment.queryComplete = false;
      }
      if (refRes.limitations) {
        assessment.limitations.push(...refRes.limitations);
      }
    } else if (assessment.unique && assessment.queryComplete && !assessment.truncated) {
      refs = await this.serena.findReferences(symbolName, undefined, operation);
    }

    const referencesCount = refs.length;
    const componentMap = new Map<string, AffectedComponent>();
    const fileMap = new Map<string, number>();

    for (const ref of refs) {
      const normalizedFile = ref.file.replace(/\\/g, '/');
      fileMap.set(normalizedFile, (fileMap.get(normalizedFile) || 0) + 1);

      const baseFile = path.basename(normalizedFile);
      const isInternal =
        targetFile &&
        (baseFile.toLowerCase() === targetFile.toLowerCase() ||
          normalizedFile.toLowerCase().endsWith(targetFile.toLowerCase()));

      const compName = this.extractComponentName(normalizedFile);

      if (!isInternal) {
        if (!componentMap.has(compName)) {
          componentMap.set(compName, {
            name: compName,
            file: normalizedFile,
            references: 0,
            sampleLines: [],
          });
        }
        const item = componentMap.get(compName)!;
        item.references++;
        if (item.sampleLines.length < 5 && ref.line) {
          item.sampleLines.push(ref.line);
        }
      }
    }

    const affectedComponents = Array.from(componentMap.values()).sort(
      (a, b) => b.references - a.references
    );
    const affected = affectedComponents.map((c) => c.name);
    const affectedFiles = Array.from(fileMap.keys());
    const downstreamImpacts = Array.from(fileMap.entries()).map(([file, occurrences]) => ({
      file,
      occurrences,
    }));

    const { riskLevel, riskReason, confidence } = this.calculateRisk(
      symbolName,
      targetFile,
      referencesCount,
      affectedComponents.length,
      affected,
      assessment
    );

    const analysisCompleteness = this.completeness(isSymbolDeclared, assessment);
    const limitations = this.mergeLimitations(assessment, referencesCount, riskLevel);

    const recommendations = this.generateRecommendations(
      symbolName,
      targetFile,
      riskLevel,
      affected,
      referencesCount,
      assessment
    );

    const formattedReport = this.formatReport({
      targetFile,
      referencesCount,
      affected,
      riskLevel,
      recommendations,
      source: assessment.source,
      confidence,
      analysisCompleteness,
      limitations,
      uniqueResolution: assessment.unique,
      queryComplete: assessment.queryComplete,
    });

    return {
      target: rawTarget,
      targetFile,
      targetKind: matchedSymbol?.kind,
      referencesCount,
      affected,
      affectedComponents,
      riskLevel,
      riskReason,
      confidence,
      source: assessment.source,
      analysisCompleteness,
      limitations,
      uniqueResolution: assessment.unique,
      queryComplete: assessment.queryComplete,
      recommendations,
      formattedReport,
      matchedSymbols: symbols,
      affectedFiles,
      downstreamImpacts,
    };
  }

  private unresolvedReport(
    rawTarget: string,
    symbolName: string,
    assessment: QueryAssessment,
    symbols: CodeSymbol[]
  ): ImpactReport {
    const riskLevel: 'UNKNOWN' = 'UNKNOWN';
    const confidence: 'UNCERTAIN' = 'UNCERTAIN';
    const analysisCompleteness: 'unindexed' = 'unindexed';
    const limitations = [
      '未在工作区索引中找到符号声明，无法验证下游影响，切勿直接假设可安全重构或删除。',
      ...SERENA_DEGRADED_LIMITATIONS,
      ...assessment.limitations,
    ];
    const riskReason = `Symbol "${symbolName}" was not found in workspace index. Downstream impact and references cannot be reliably verified. Do NOT assume it is safe to refactor or delete.`;
    const recommendations = [
      `Verify symbol spelling ("${symbolName}") or ensure the defining file is indexed.`,
      `Check if the symbol is dynamically loaded, reflected, or defined in an external dependency.`,
      `Perform manual call site verification before modifying or deleting code.`,
    ];
    const targetFile = `${symbolName} (unresolved)`;
    const formattedReport = this.formatReport({
      targetFile,
      referencesCount: 0,
      affected: [],
      riskLevel,
      recommendations,
      source: assessment.source,
      confidence,
      analysisCompleteness,
      limitations,
      uniqueResolution: false,
      queryComplete: assessment.queryComplete,
    });

    return {
      target: rawTarget,
      targetFile,
      targetKind: undefined,
      referencesCount: 0,
      affected: [],
      affectedComponents: [],
      riskLevel,
      riskReason,
      confidence,
      source: assessment.source,
      analysisCompleteness,
      limitations,
      uniqueResolution: false,
      queryComplete: assessment.queryComplete,
      recommendations,
      formattedReport,
      matchedSymbols: symbols,
      affectedFiles: [],
      downstreamImpacts: [],
    };
  }

  private completeness(
    declared: boolean,
    assessment: QueryAssessment
  ): ImpactReport['analysisCompleteness'] {
    if (!declared) return 'unindexed';
    if (!assessment.queryComplete || assessment.truncated) return 'incomplete';
    if (assessment.source === 'serena-mcp' || assessment.source === 'roslyn') return 'semantic';
    return 'degraded';
  }

  private mergeLimitations(
    assessment: QueryAssessment,
    referencesCount: number,
    riskLevel: ImpactReport['riskLevel']
  ): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of assessment.limitations) {
      if (item && !seen.has(item)) {
        seen.add(item);
        out.push(item);
      }
    }
    if (!assessment.unique) {
      const msg = '目标符号未唯一解析，不得将当前引用集合当作完整影响面。';
      if (!seen.has(msg)) out.push(msg);
    }
    if (referencesCount === 0 || riskLevel === 'UNKNOWN') {
      const msg = '未找到引用不得直接解释为“无影响”或“低风险”，也不得视为可安全删除。';
      if (!seen.has(msg)) out.push(msg);
    }
    if ((assessment.source === 'serena-mcp' || assessment.source === 'roslyn') && (!assessment.queryComplete || assessment.truncated)) {
      const msg = '语义提供方已返回结果，但查询不完整或可能截断，可信度不能只看供应方。';
      if (!seen.has(msg)) out.push(msg);
    }
    return out;
  }

  private extractComponentName(filePath: string): string {
    const base = path.basename(filePath);
    const withoutExt = base.replace(/\.[^.]+$/, '');

    if (['index', 'mod', 'main', 'program'].includes(withoutExt.toLowerCase())) {
      const parentDir = path.basename(path.dirname(filePath));
      if (parentDir && parentDir !== '.' && parentDir !== '/') {
        return parentDir;
      }
    }

    return withoutExt.replace(/\.xaml$/i, '');
  }

  /**
   * Confidence is derived from unique resolution and query completeness, not from source alone.
   * Zero references never become LOW / safe-to-refactor.
   */
  private calculateRisk(
    symbolName: string,
    targetFile: string,
    referencesCount: number,
    affectedComponentsCount: number,
    affected: string[],
    assessment: QueryAssessment
  ): {
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';
    riskReason: string;
    confidence: 'HIGH' | 'MEDIUM' | 'UNCERTAIN';
  } {
    const confidence = this.deriveConfidence(assessment, referencesCount);

    if (!assessment.unique) {
      return {
        riskLevel: 'UNKNOWN',
        riskReason: `Symbol "${symbolName}" is not uniquely resolved (${assessment.typeMatchCount} type matches). Do not treat mixed hits as a blast radius.`,
        confidence: 'UNCERTAIN',
      };
    }

    if (!assessment.queryComplete || assessment.truncated) {
      return {
        riskLevel: 'UNKNOWN',
        riskReason: `Impact query is incomplete${assessment.queryError ? ` (${assessment.queryError})` : ''}. Zero or partial references are not evidence of low risk.`,
        confidence: 'UNCERTAIN',
      };
    }

    if (referencesCount === 0) {
      return {
        riskLevel: 'UNKNOWN',
        riskReason: `No references were returned for "${symbolName}". This is not proof of zero impact or that the symbol is safe to refactor or delete.`,
        confidence: 'UNCERTAIN',
      };
    }

    const isCoreModule =
      /(Service|Manager|Store|Repository|Gateway|Context|Router|Core|Client)$/i.test(symbolName) ||
      /(Core|Gateway|Services|Data|Database|Infrastructure)/i.test(targetFile);

    if (referencesCount > 30 || affectedComponentsCount >= 7) {
      return {
        riskLevel: 'CRITICAL',
        riskReason: `Massive blast radius: ${referencesCount} references across ${affectedComponentsCount} external components. High danger of cascading failures.`,
        confidence,
      };
    }

    if (
      referencesCount > 10 ||
      affectedComponentsCount >= 3 ||
      (isCoreModule && referencesCount >= 6)
    ) {
      return {
        riskLevel: 'HIGH',
        riskReason: `High coupling detected: ${referencesCount} references across ${affectedComponentsCount} components (${affected.slice(0, 3).join(', ')}). Breaking changes will ripple into consumers.`,
        confidence,
      };
    }

    if (referencesCount > 3 || affectedComponentsCount >= 2) {
      return {
        riskLevel: 'MEDIUM',
        riskReason: `Moderate coupling: ${referencesCount} references in ${affectedComponentsCount} components. Call sites require coordinated updates.`,
        confidence,
      };
    }

    return {
      riskLevel: 'LOW',
      riskReason: `Localized impact: ${referencesCount} references in ${affectedComponentsCount} external component(s). Public contracts should still be preserved.`,
      confidence,
    };
  }

  private deriveConfidence(
    assessment: QueryAssessment,
    referencesCount: number
  ): 'HIGH' | 'MEDIUM' | 'UNCERTAIN' {
    if (!assessment.unique || !assessment.queryComplete || assessment.truncated || referencesCount === 0) {
      return 'UNCERTAIN';
    }
    if (assessment.source === 'serena-mcp' || assessment.source === 'roslyn') {
      return 'HIGH';
    }
    return 'MEDIUM';
  }

  private generateRecommendations(
    symbolName: string,
    targetFile: string,
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN',
    affected: string[],
    referencesCount: number,
    assessment: QueryAssessment
  ): string[] {
    const recs: string[] = [];

    if (riskLevel === 'UNKNOWN' || !assessment.unique || !assessment.queryComplete || referencesCount === 0) {
      recs.push(`Locate the exact symbol definition and verify call sites before modifying "${symbolName}".`);
      recs.push('Do not delete or rename based on a missing or incomplete reference list.');
      recs.push(`Run tests and search for reflection/DI registrations that mention ${symbolName}.`);
      return recs;
    }

    if (riskLevel === 'CRITICAL' || riskLevel === 'HIGH') {
      const interfaceName = symbolName.startsWith('I') ? symbolName : `I${symbolName}`;
      recs.push(`Add interface (${interfaceName}) before modifying concrete implementation to decouple callers.`);
    } else if (riskLevel === 'MEDIUM') {
      recs.push(`Preserve existing method signatures or add non-breaking overloads to maintain compatibility.`);
    } else {
      recs.push(`Perform targeted modifications while keeping public contract intact.`);
    }

    const hasPersistence = affected.some((a) =>
      /(Save|Store|Memory|Db|Database|Repo|Persistence|Session|Cache)/i.test(a)
    );
    const hasUI = affected.some((a) =>
      /(View|Window|Dialog|Presenter|Page|Panel|Control)/i.test(a)
    );

    if (hasPersistence && (riskLevel === 'HIGH' || riskLevel === 'CRITICAL')) {
      recs.push(`Split persistence layer from state/business logic to isolate data mutations and side effects.`);
    } else if (hasUI && (riskLevel === 'HIGH' || riskLevel === 'CRITICAL')) {
      recs.push(`Decouple UI presentation components from domain logic using command patterns or event buses.`);
    } else if (affected.length >= 3) {
      recs.push(`Isolate high-impact callers (${affected.slice(0, 2).join(', ')}) with adapter layers or facade boundaries.`);
    } else {
      recs.push(`Verify caller assumptions in ${affected.length > 0 ? affected[0] : 'local module'}.`);
    }

    if (affected.length > 0) {
      recs.push(`Update tests covering caller workflows in: ${affected.slice(0, 3).join(', ')}.`);
    } else {
      recs.push(`Run existing unit and regression tests to verify zero behavioral regressions.`);
    }

    return recs;
  }

  private formatReport(data: {
    targetFile: string;
    referencesCount: number;
    affected: string[];
    riskLevel: string;
    recommendations: string[];
    source?: string;
    confidence?: string;
    analysisCompleteness?: string;
    limitations?: string[];
    uniqueResolution?: boolean;
    queryComplete?: boolean;
  }): string {
    const affectedLines =
      data.affected.length > 0
        ? data.affected.map((a) => `- ${a}`).join('\n')
        : '- (None reported; not proof of zero impact)';

    const recLines = data.recommendations.map((r, i) => `${i + 1}. ${r}`).join('\n');

    const lines = [
      `# Impact Analysis`,
      ``,
      `Target:`,
      `${data.targetFile}`,
      ``,
      `References:`,
      `${data.referencesCount}`,
      ``,
      `Affected:`,
      `${affectedLines}`,
      ``,
      `Risk:`,
      `${data.riskLevel}`,
    ];

    if (data.confidence) {
      lines.push(``, `Confidence:`, `${data.confidence}`);
    }

    if (data.source) {
      lines.push(``, `Source:`, `${data.source}`);
    }

    if (data.uniqueResolution !== undefined) {
      lines.push(``, `Unique Resolution:`, `${data.uniqueResolution}`);
    }

    if (data.queryComplete !== undefined) {
      lines.push(``, `Query Complete:`, `${data.queryComplete}`);
    }

    if (data.analysisCompleteness) {
      lines.push(``, `Analysis Completeness:`, `${data.analysisCompleteness}`);
    }

    if (data.limitations && data.limitations.length > 0) {
      lines.push(``, `Limitations:`, data.limitations.map((l) => `- ${l}`).join('\n'));
    }

    lines.push(``, `Recommended:`, `${recLines}`);

    return lines.join('\n');
  }
}
