import { SerenaAdapter, CodeSymbol, SymbolReference } from '../Adapters/SerenaAdapter.js';

export interface ImpactReport {
  target: string;
  matchedSymbols: CodeSymbol[];
  referencesCount: number;
  affectedFiles: string[];
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  downstreamImpacts: {
    file: string;
    occurrences: number;
  }[];
  recommendations: string[];
}

export class ImpactAnalyzer {
  private serena: SerenaAdapter;

  constructor(serena: SerenaAdapter) {
    this.serena = serena;
  }

  /**
   * Analyzes the downstream blast radius and risk level of modifying a symbol or component
   */
  async analyzeImpact(symbolOrComponentName: string): Promise<ImpactReport> {
    const symbols = await this.serena.findSymbols(symbolOrComponentName);
    const refs = await this.serena.findReferences(symbolOrComponentName);

    const fileMap = new Map<string, number>();
    for (const ref of refs) {
      fileMap.set(ref.file, (fileMap.get(ref.file) || 0) + 1);
    }

    const affectedFiles = Array.from(fileMap.keys());
    const downstreamImpacts = Array.from(fileMap.entries()).map(([file, occurrences]) => ({
      file,
      occurrences,
    }));

    // Calculate risk rating
    let riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' = 'LOW';
    if (refs.length > 50 || affectedFiles.length > 10) {
      riskLevel = 'CRITICAL';
    } else if (refs.length > 20 || affectedFiles.length > 5) {
      riskLevel = 'HIGH';
    } else if (refs.length > 5 || affectedFiles.length > 2) {
      riskLevel = 'MEDIUM';
    }

    const recommendations: string[] = [];
    if (riskLevel === 'CRITICAL' || riskLevel === 'HIGH') {
      recommendations.push(
        `High coupling detected (${affectedFiles.length} files, ${refs.length} references). Consider extracting an interface or adding adapter layers before modifying.`
      );
      recommendations.push('Run full regression tests after changes.');
    } else if (riskLevel === 'MEDIUM') {
      recommendations.push('Moderate coupling. Verify all caller sites listed in downstreamImpacts.');
    } else {
      recommendations.push('Low blast radius. Safe for direct in-place refactoring or updates.');
    }

    return {
      target: symbolOrComponentName,
      matchedSymbols: symbols,
      referencesCount: refs.length,
      affectedFiles,
      riskLevel,
      downstreamImpacts,
      recommendations,
    };
  }
}
