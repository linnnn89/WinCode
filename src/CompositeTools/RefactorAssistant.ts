import { CodeSymbolQuery } from '../Core/CodeQueries.js';
import { WorkspaceManager } from '../Core/Workspace.js';
import { ImpactAnalyzer, ImpactReport } from './ImpactAnalyzer.js';

export interface RefactorPlan {
  targetComponent: string;
  scopeSummary: string;
  recommendedSteps: string[];
  safeBoundaries: string[];
  evidence: Pick<ImpactReport, 'riskLevel' | 'riskReason' | 'confidence' | 'source' | 'uniqueResolution' | 'queryComplete' | 'limitations'>;
  suggestedFileMoves?: {
    from: string;
    to: string;
    safeTrashOption: boolean;
  }[];
}

export class RefactorAssistant {
  private workspace: WorkspaceManager;
  private impact: ImpactAnalyzer;

  constructor(workspace: WorkspaceManager, _queries: CodeSymbolQuery, impact: ImpactAnalyzer) {
    this.workspace = workspace;
    this.impact = impact;
  }

  /**
   * Checklist derived from impact analysis. Not an automated refactor engine.
   */
  async planRefactoring(componentName: string, refactorGoal: string, operation?: import('../Core/OperationContext.js').OperationContext): Promise<RefactorPlan> {
    const impactReport = await this.impact.analyzeImpact(componentName, operation);

    const steps: string[] = [];
    if (!impactReport.uniqueResolution) {
      const candidates = impactReport.matchedSymbols.slice(0, 5).map(item => `${item.file}:${item.line ?? '?'}`).join(', ');
      steps.push(`Resolve the target to one declaration before planning edits${candidates ? `; candidates: ${candidates}` : '; supply a concrete file and symbol'}.`);
    } else if (!impactReport.queryComplete) {
      steps.push('Complete the interrupted reference query before deciding the change scope; inspect the reported limitations.');
    } else if (impactReport.riskLevel === 'UNKNOWN' || impactReport.referencesCount === 0) {
      steps.push('Obtain additional caller and entry-point evidence; UNKNOWN or zero references does not establish a safe change scope.');
    } else {
      steps.push(`Inspect ${impactReport.referencesCount} reported references across ${impactReport.affectedFiles.length} files: ${impactReport.affectedFiles.slice(0, 5).join(', ')}.`);
    }
    if (impactReport.source !== 'serena-mcp') steps.push('Verify textual matches against declarations and callers; degraded retrieval does not prove symbol identity.');
    steps.push(`Once the scope is supported, make the smallest change needed for the stated goal: ${refactorGoal}.`);
    steps.push('Validate the changed behavior and affected callers with targeted tests; report coverage gaps and failures.');

    const safeBoundaries = [
      'Do NOT permanently delete obsolete files; move them to project trash/ instead.',
      'Maintain public API contracts unless callers are simultaneously updated.',
      'Protect existing serialization formats and persistent states.',
    ];

    return {
      targetComponent: componentName,
      scopeSummary: `Refactor assessment for "${componentName}" under goal "${refactorGoal}". Risk level: ${impactReport.riskLevel}.`,
      recommendedSteps: steps,
      safeBoundaries,
      evidence: {
        riskLevel: impactReport.riskLevel, riskReason: impactReport.riskReason,
        confidence: impactReport.confidence, source: impactReport.source,
        uniqueResolution: impactReport.uniqueResolution, queryComplete: impactReport.queryComplete,
        limitations: impactReport.limitations,
      },
    };
  }

  /**
   * Safe removal helper: archives an obsolete file to trash
   */
  async archiveFileToTrash(filePath: string, reason: string) {
    return this.workspace.moveToTrash(filePath, reason);
  }
}
