import { SerenaAdapter, CodeSymbol } from '../Adapters/SerenaAdapter.js';
import { WorkspaceManager } from '../Core/Workspace.js';
import { ImpactAnalyzer } from './ImpactAnalyzer.js';

export interface RefactorPlan {
  targetComponent: string;
  scopeSummary: string;
  recommendedSteps: string[];
  safeBoundaries: string[];
  suggestedFileMoves?: {
    from: string;
    to: string;
    safeTrashOption: boolean;
  }[];
}

export class RefactorAssistant {
  private workspace: WorkspaceManager;
  private serena: SerenaAdapter;
  private impact: ImpactAnalyzer;

  constructor(workspace: WorkspaceManager, serena: SerenaAdapter, impact: ImpactAnalyzer) {
    this.workspace = workspace;
    this.serena = serena;
    this.impact = impact;
  }

  /**
   * Checklist derived from impact analysis. Not an automated refactor engine.
   */
  async planRefactoring(componentName: string, refactorGoal: string): Promise<RefactorPlan> {
    const impactReport = await this.impact.analyzeImpact(componentName);

    const steps: string[] = [
      `1. Audit call sites: verify ${impactReport.referencesCount} references across ${impactReport.affectedFiles.length} files.`,
      `2. Extract Interface/Contract: Create an abstraction to decouple dependent callers.`,
      `3. Implement incremental changes: Keep existing method signatures as compatibility shims or redirects.`,
      `4. Verify behavior: Run project tests to validate zero regression.`,
    ];

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
    };
  }

  /**
   * Safe removal helper: archives an obsolete file to trash
   */
  async archiveFileToTrash(filePath: string, reason: string) {
    return this.workspace.moveToTrash(filePath, reason);
  }
}
