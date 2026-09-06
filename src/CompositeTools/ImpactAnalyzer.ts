import path from 'path';
import { SerenaAdapter, CodeSymbol, SymbolReference } from '../Adapters/SerenaAdapter.js';
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
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  riskReason: string;
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

    // Resolve matching symbols
    const symbols = await this.serena.findSymbols(symbolName);
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

    // Determine targetFile
    let targetFile = '';
    if (matchedSymbol?.file) {
      targetFile = path.basename(matchedSymbol.file);
    } else if (explicitFileHint) {
      targetFile = path.basename(explicitFileHint);
    } else {
      targetFile = `${symbolName}.cs`;
    }

    // 2. Discover references
    const refs = await this.serena.findReferences(symbolName);
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
    const { riskLevel, riskReason } = this.calculateRisk(
      symbolName,
      targetFile,
      referencesCount,
      affectedComponents.length,
      affected
    );

    // 5. Generate Architectural Recommendations
    const recommendations = this.generateRecommendations(
      symbolName,
      targetFile,
      riskLevel,
      affected,
      referencesCount
    );

    // 6. Generate Clean Markdown Formatted Report
    const formattedReport = this.formatReport({
      targetFile,
      referencesCount,
      affected,
      riskLevel,
      recommendations,
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
    affected: string[]
  ): { riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; riskReason: string } {
    const isCoreModule =
      /(Service|Manager|Store|Repository|Gateway|Context|Router|Core|Client)$/i.test(symbolName) ||
      /(Core|Gateway|Services|Data|Database|Infrastructure)/i.test(targetFile);

    if (referencesCount > 30 || affectedComponentsCount >= 7) {
      return {
        riskLevel: 'CRITICAL',
        riskReason: `Massive blast radius: ${referencesCount} references across ${affectedComponentsCount} external components. High danger of cascading failures.`,
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
      };
    }

    if (referencesCount > 3 || affectedComponentsCount >= 2) {
      return {
        riskLevel: 'MEDIUM',
        riskReason: `Moderate coupling: ${referencesCount} references in ${affectedComponentsCount} components. Call sites require coordinated updates.`,
      };
    }

    return {
      riskLevel: 'LOW',
      riskReason: `Localized impact: ${referencesCount} references. Safe for targeted in-place refactoring or updates.`,
    };
  }

  /**
   * Contextual architectural guidance to prevent blind modifications
   */
  private generateRecommendations(
    symbolName: string,
    targetFile: string,
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL',
    affected: string[],
    referencesCount: number
  ): string[] {
    const recs: string[] = [];

    // Recommendation 1: Interface abstraction
    if (riskLevel === 'CRITICAL' || riskLevel === 'HIGH') {
      const interfaceName = symbolName.startsWith('I') ? symbolName : `I${symbolName}`;
      recs.push(`Add interface (${interfaceName}) before modifying concrete implementation to decouple callers.`);
    } else if (riskLevel === 'MEDIUM') {
      recs.push(`Preserve existing method signatures or add non-breaking overloads to maintain compatibility.`);
    } else {
      recs.push(`Perform targeted modifications while keeping public contract intact.`);
    }

    // Recommendation 2: Decoupling persistence/layering
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

    // Recommendation 3: Verification & Test strategy
    if (affected.length > 0) {
      const targetCallers = affected.slice(0, 3).join(', ');
      recs.push(`Update tests covering caller workflows in: ${targetCallers}.`);
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
  }): string {
    const affectedLines =
      data.affected.length > 0
        ? data.affected.map((a) => `- ${a}`).join('\n')
        : '- (None - localized within file)';

    const recLines = data.recommendations.map((r, i) => `${i + 1}. ${r}`).join('\n');

    return [
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
      ``,
      `Recommended:`,
      `${recLines}`,
    ].join('\n');
  }
}

