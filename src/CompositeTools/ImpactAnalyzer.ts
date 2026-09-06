import path from 'path';
import { SerenaAdapter, CodeSymbol, SymbolReference, SERENA_DEGRADED_LIMITATIONS } from '../Adapters/SerenaAdapter.js';
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
  source: 'serena-mcp' | 'serena-adapter-fallback' | 'unknown';
  analysisCompleteness: 'semantic' | 'degraded' | 'unindexed';
  limitations: string[];
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

export class ImpactAnalyzer {
  private serena: SerenaAdapter;
  private config?: WinCodeConfig;

  constructor(serena: SerenaAdapter, config?: WinCodeConfig) {
    this.serena = serena;
    this.config = config;
  }

  /**
   * Analyzes downstream blast radius, affected components, coupling risk,
   * and provides architectural recommendations before modifying code.
   */
  async analyzeImpact(target: string): Promise<ImpactReport> {
    const rawTarget = target.trim();
    if (!rawTarget) {
      throw new Error('Target parameter is required for impact analysis.');
    }

    // 1. Target resolution
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

    // Resolve matching symbols with source tracking
    let symbols: CodeSymbol[] = [];
    let source: 'serena-mcp' | 'serena-adapter-fallback' | 'unknown' = 'unknown';

    if (typeof (this.serena as any).findSymbolsDetailed === 'function') {
      const symRes = await (this.serena as any).findSymbolsDetailed(symbolName);
      symbols = symRes.symbols || [];
      source = symRes.source;
    } else {
      symbols = await this.serena.findSymbols(symbolName);
      source = 'serena-adapter-fallback';
    }

    let matchedSymbol: CodeSymbol | undefined;
    if (symbols.length > 0) {
      matchedSymbol =
        symbols.find(
          (s) =>
            s.name.toLowerCase() === symbolName.toLowerCase() &&
            ['class', 'interface', 'struct', 'enum'].includes((s.kind || '').toLowerCase())
        ) ||
        symbols.find((s) => s.name.toLowerCase() === symbolName.toLowerCase()) ||
        symbols[0];
    }

    // [P1 Fix]: If symbol is not declared / found in workspace index and no explicit file matches
    const isSymbolDeclared = Boolean(matchedSymbol || explicitFileHint);
    if (!isSymbolDeclared) {
      const riskLevel: 'UNKNOWN' = 'UNKNOWN';
      const confidence: 'UNCERTAIN' = 'UNCERTAIN';
      const analysisCompleteness: 'unindexed' = 'unindexed';
      const limitations = [
        '未在工作区索引中找到符号声明，无法验证下游影响，切勿直接假设可安全重构或删除。',
        '本地正则扫描仅作为文本检索降级方案，不保证符号身份、重载区分或跨文件引用完整性。',
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
        source,
        confidence,
        analysisCompleteness,
        limitations,
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
        source,
        analysisCompleteness,
        limitations,
        recommendations,
        formattedReport,
        matchedSymbols: [],
        affectedFiles: [],
        downstreamImpacts: [],
      };
    }

    // Determine targetFile
    let targetFile = '';
    if (matchedSymbol?.file) {
      targetFile = path.basename(matchedSymbol.file);
    } else if (explicitFileHint) {
      targetFile = path.basename(explicitFileHint);
    } else {
      targetFile = `${symbolName}.cs`;
    }

    // 2. Discover references with source awareness
    let refs: SymbolReference[] = [];
    if (typeof (this.serena as any).findReferencesDetailed === 'function') {
      const refRes = await (this.serena as any).findReferencesDetailed(symbolName);
      refs = refRes.references || [];
      if (refRes.source) source = refRes.source;
    } else {
      refs = await this.serena.findReferences(symbolName);
    }
    const referencesCount = refs.length;

    // 3. Resolve affected callers / components
    const componentMap = new Map<string, AffectedComponent>();
    const fileMap = new Map<string, number>();

    for (const ref of refs) {
      const normalizedFile = ref.file.replace(/\\/g, '/');
      fileMap.set(normalizedFile, (fileMap.get(normalizedFile) || 0) + 1);

      // Check if reference is in the definition file itself (internal vs external)
      const baseFile = path.basename(normalizedFile);
      const isInternal =
        targetFile &&
        (baseFile.toLowerCase() === targetFile.toLowerCase() ||
          normalizedFile.toLowerCase().endsWith(targetFile.toLowerCase()));

      // Extract component name from file
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

    // 4. Calculate Risk Rating
    const { riskLevel, riskReason, confidence } = this.calculateRisk(
      symbolName,
      targetFile,
      referencesCount,
      affectedComponents.length,
      affected,
      source
    );

    const analysisCompleteness: 'semantic' | 'degraded' =
      source === 'serena-mcp' ? 'semantic' : 'degraded';
    const limitations =
      source === 'serena-mcp' ? [] : [...SERENA_DEGRADED_LIMITATIONS];

    // 5. Generate Architectural Recommendations
    const recommendations = this.generateRecommendations(
      symbolName,
      targetFile,
      riskLevel,
      affected,
      referencesCount,
      source
    );

    // 6. Generate Clean Markdown Formatted Report
    const formattedReport = this.formatReport({
      targetFile,
      referencesCount,
      affected,
      riskLevel,
      recommendations,
      source,
      confidence,
      analysisCompleteness,
      limitations,
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
      source,
      analysisCompleteness,
      limitations,
      recommendations,
      formattedReport,
      matchedSymbols: symbols,
      affectedFiles,
      downstreamImpacts,
    };
  }

  /**
   * Extracts clean component or class name from a file path
   */
  private extractComponentName(filePath: string): string {
    const base = path.basename(filePath);
    const withoutExt = base.replace(/\.[^.]+$/, '');

    // Handle generic names like index.ts or mod.rs
    if (['index', 'mod', 'main', 'program'].includes(withoutExt.toLowerCase())) {
      const parentDir = path.basename(path.dirname(filePath));
      if (parentDir && parentDir !== '.' && parentDir !== '/') {
        return parentDir;
      }
    }

    // Strip XAML extension if WPF (e.g. MainWindow.xaml.cs -> MainWindow)
    return withoutExt.replace(/\.xaml$/i, '');
  }

  /**
   * Risk assessment considering references, affected fan-out, and module semantics
   */
  private calculateRisk(
    symbolName: string,
    targetFile: string,
    referencesCount: number,
    affectedComponentsCount: number,
    affected: string[],
    source: 'serena-mcp' | 'serena-adapter-fallback' | 'unknown'
  ): {
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';
    riskReason: string;
    confidence: 'HIGH' | 'MEDIUM' | 'UNCERTAIN';
  } {
    const isCoreModule =
      /(Service|Manager|Store|Repository|Gateway|Context|Router|Core|Client)$/i.test(symbolName) ||
      /(Core|Gateway|Services|Data|Database|Infrastructure)/i.test(targetFile);

    if (referencesCount > 30 || affectedComponentsCount >= 7) {
      return {
        riskLevel: 'CRITICAL',
        riskReason: `Massive blast radius: ${referencesCount} references across ${affectedComponentsCount} external components. High danger of cascading failures.`,
        confidence: source === 'serena-mcp' ? 'HIGH' : 'MEDIUM',
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
        confidence: source === 'serena-mcp' ? 'HIGH' : 'MEDIUM',
      };
    }

    if (referencesCount > 3 || affectedComponentsCount >= 2) {
      return {
        riskLevel: 'MEDIUM',
        riskReason: `Moderate coupling: ${referencesCount} references in ${affectedComponentsCount} components. Call sites require coordinated updates.`,
        confidence: source === 'serena-mcp' ? 'HIGH' : 'MEDIUM',
      };
    }

    if (referencesCount === 0) {
      if (source !== 'serena-mcp') {
        // [User Rule]: 降级或未连接真实 Serena 时，不得将“未找到引用”直接解释为“无影响”或“低风险”
        return {
          riskLevel: 'UNKNOWN',
          riskReason: `本地正则文本降级扫描下未匹配到显式引用。由于文本扫描不保证符号身份、重载区分、跨文件引用完整性或安全重命名，不得将“未找到引用”直接解释为“无影响”或“低风险”。建议连接真实 Serena 语义服务进行完整分析。`,
          confidence: 'UNCERTAIN',
        };
      }
      return {
        riskLevel: 'LOW',
        riskReason: `Serena 语义分析未发现跨工程外部引用，属于高置信度的局部影响。`,
        confidence: 'HIGH',
      };
    }

    // 1-3 references
    if (source !== 'serena-mcp') {
      return {
        riskLevel: 'LOW',
        riskReason: `本地文本检索检测到 ${referencesCount} 处匹配引用（降级模式仅供参考，不保证跨文件引用完整性，重构时请保持公共契约并进行必要人工核查）。`,
        confidence: 'MEDIUM',
      };
    }

    return {
      riskLevel: 'LOW',
      riskReason: `Localized impact: ${referencesCount} references verified via Serena semantic analysis. Safe for targeted in-place refactoring.`,
      confidence: 'HIGH',
    };
  }

  /**
   * Contextual architectural guidance to prevent blind modifications
   */
  private generateRecommendations(
    symbolName: string,
    targetFile: string,
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN',
    affected: string[],
    referencesCount: number,
    source?: 'serena-mcp' | 'serena-adapter-fallback' | 'unknown'
  ): string[] {
    const recs: string[] = [];

    // Recommendation 1: Interface abstraction
    if (riskLevel === 'CRITICAL' || riskLevel === 'HIGH') {
      const interfaceName = symbolName.startsWith('I') ? symbolName : `I${symbolName}`;
      recs.push(`Add interface (${interfaceName}) before modifying concrete implementation to decouple callers.`);
    } else if (riskLevel === 'MEDIUM') {
      recs.push(`Preserve existing method signatures or add non-breaking overloads to maintain compatibility.`);
    } else if (riskLevel === 'UNKNOWN') {
      recs.push(`Locate the exact symbol definition or verify if defined in external packages before modifying.`);
    } else {
      recs.push(`Perform targeted modifications while keeping public contract intact.`);
    }

    // Recommendation 2: Decoupling persistence/layering or semantic caution
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
    } else if (source !== 'serena-mcp' && referencesCount === 0) {
      recs.push('连接真实 Serena 语义服务或启动 Roslyn/TypeScript LSP，防止遗漏反射或跨项目间接调用。');
    } else if (riskLevel === 'UNKNOWN') {
      recs.push(`Avoid deleting or renaming without checking runtime reflections or DI registrations.`);
    } else {
      recs.push(`Verify caller assumptions in ${affected.length > 0 ? affected[0] : 'local module'}.`);
    }

    // Recommendation 3: Verification & Test strategy
    if (affected.length > 0) {
      const targetCallers = affected.slice(0, 3).join(', ');
      recs.push(`Update tests covering caller workflows in: ${targetCallers}.`);
    } else if (source !== 'serena-mcp' && referencesCount === 0) {
      recs.push('切勿仅因降级文本扫描未匹配到引用就假定变更无影响或低风险，修改前请核对调用点。');
    } else if (riskLevel === 'UNKNOWN') {
      recs.push(`Run full project test suite and verify if any tests mention ${symbolName}.`);
    } else {
      recs.push(`Run existing unit and regression tests to verify zero behavioral regressions.`);
    }

    return recs;
  }

  /**
   * Formats report into concise, high-visibility Markdown
   */
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
  }): string {
    const affectedLines =
      data.affected.length > 0
        ? data.affected.map((a) => `- ${a}`).join('\n')
        : '- (None - localized within file)';

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
      lines.push(``, `Confidence:`, `${data.confidence}${data.source ? ` (${data.source})` : ''}`);
    }

    if (data.analysisCompleteness) {
      lines.push(``, `Analysis Completeness:`, `${data.analysisCompleteness}`);
    }

    if (data.limitations && data.limitations.length > 0) {
      lines.push(``, `Limitations:`, data.limitations.map((l) => `- ${l}`).join('\n'));
    }

    lines.push(
      ``,
      `Recommended:`,
      `${recLines}`,
    );

    return lines.join('\n');
  }
}

