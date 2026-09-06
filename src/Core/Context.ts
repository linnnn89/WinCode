import fs from 'node:fs/promises';
import path from 'node:path';
import { WinCodeConfig } from './Config.js';
import { WorkspaceManager, ProjectIdentity } from './Workspace.js';
import { RepomixAdapter, RepomixPackOptions } from '../Adapters/RepomixAdapter.js';
import { SerenaAdapter, CodeSymbol } from '../Adapters/SerenaAdapter.js';

export interface PreparedContextOptions {
  task: string;
  candidateFiles?: string[];
  focusAreas?: string[];
  compress?: boolean;
  outputFormat?: 'markdown' | 'xml';
}

export interface PreparedContextResult {
  task: string;
  project: {
    name: string;
    type: string;
    solution: string | null;
    projects: number;
    language: string;
    targetFramework?: string;
  };
  metrics: {
    packedFiles: number;
    totalCharacters: number;
    estimatedTokens: number;
    source: string;
    fromCache: boolean;
  };
  guidance: string[];
  executiveSummary: string;
  formattedContent: string;
}

export class ContextManager {
  private config: WinCodeConfig;
  private workspace: WorkspaceManager;
  private repomix: RepomixAdapter;
  private serena: SerenaAdapter;

  constructor(
    config: WinCodeConfig,
    workspace: WorkspaceManager,
    repomix: RepomixAdapter,
    serena: SerenaAdapter
  ) {
    this.config = config;
    this.workspace = workspace;
    this.repomix = repomix;
    this.serena = serena;
  }

  /**
   * Phase 3: Prepares high-semantic, decision-ready context for coding agents.
   * Flow: Repomix -> repo snapshot -> Context Formatter -> Return to Agent
   */
  async prepareContext(options: PreparedContextOptions | string): Promise<PreparedContextResult> {
    const opts: PreparedContextOptions =
      typeof options === 'string' ? { task: options } : options;
    const task = opts.task;

    const identity: ProjectIdentity = await this.workspace.identifyProject();

    // 1. Repomix -> repo snapshot
    const packOptions: RepomixPackOptions = {
      outputFormat: opts.outputFormat || 'markdown',
      compress: opts.compress ?? (task.includes('架构') || task.toLowerCase().includes('architecture')),
      include: opts.focusAreas,
    };

    const snapshot = await this.repomix.packWorkspace(packOptions);

    // 2. Extract key symbols relevant to the task
    const keywords = task
      .split(/[\s,._\-:;，。、]+/)
      .filter((w) => w.length > 2)
      .map((w) => w.toLowerCase());

    const keySymbols: CodeSymbol[] = [];
    for (const kw of keywords.slice(0, 4)) {
      const symbols = await this.serena.findSymbols(kw);
      keySymbols.push(...symbols.slice(0, 3));
    }

    // 3. Generate Task-Tailored Reasoning Guidance
    const guidance = this.generateGuidance(task, identity);

    // 4. Context Formatter: Format into structured Agent-ready output
    const executiveSummary = [
      `# AI Agent Context Snapshot`,
      `**Target Task**: "${task}"`,
      `**Project**: ${identity.name} (${identity.type.toUpperCase()}, Primary Language: ${identity.language})`,
      identity.primarySolution ? `**Solution**: ${identity.primarySolution} (${identity.projectFiles.length} projects)` : null,
      identity.targetFramework ? `**Target Framework**: ${identity.targetFramework}` : null,
      `**Snapshot Source**: ${snapshot.source} (${snapshot.fileCount} files, ~${Math.ceil(snapshot.totalCharacters / 4)} tokens)`,
    ]
      .filter(Boolean)
      .join('\n');

    let formattedContent = `${executiveSummary}\n\n`;

    if (guidance.length > 0) {
      formattedContent += `## 🧭 Recommended Focus & Architectural Guidance\n`;
      for (const item of guidance) {
        formattedContent += `- ${item}\n`;
      }
      formattedContent += `\n`;
    }

    if (keySymbols.length > 0) {
      formattedContent += `## 🔍 Key Symbols Related to Task\n`;
      for (const sym of keySymbols) {
        formattedContent += `- \`${sym.kind}\` **${sym.name}** (${sym.file}:${sym.line}) ${sym.signature ? `\`${sym.signature}\`` : ''}\n`;
      }
      formattedContent += `\n`;
    }

    formattedContent += `## 📦 Distilled Codebase Snapshot (Repomix)\n\n`;
    formattedContent += snapshot.content;

    return {
      task,
      project: {
        name: identity.name,
        type: identity.type,
        solution: identity.primarySolution,
        projects: identity.projectFiles.length,
        language: identity.language,
        targetFramework: identity.targetFramework,
      },
      metrics: {
        packedFiles: snapshot.fileCount,
        totalCharacters: snapshot.totalCharacters,
        estimatedTokens: Math.ceil(snapshot.totalCharacters / 4),
        source: snapshot.source,
        fromCache: snapshot.fromCache,
      },
      guidance,
      executiveSummary,
      formattedContent,
    };
  }

  private generateGuidance(task: string, identity: ProjectIdentity): string[] {
    const guidance: string[] = [];
    const lower = task.toLowerCase();

    if (lower.includes('架构') || lower.includes('architecture')) {
      if (identity.isDotNet) {
        guidance.push(`Examine solution-level separation across projects: App (UI/Presentation) vs Core (Domain/Models) vs Infrastructure.`);
        guidance.push(`Inspect Dependency Injection service registrations to understand subsystem boundaries.`);
      } else {
        guidance.push(`Analyze module boundaries between Gateway/Presentation, Core domain, and external Adapters.`);
      }
      guidance.push(`Identify entry points and evaluate dependency flow direction to check for circular couplings.`);
    } else if (lower.includes('重构') || lower.includes('refactor')) {
      guidance.push(`Verify caller references before altering public interfaces or class signatures.`);
      guidance.push(`Adopt an incremental adapter pattern to maintain backward compatibility.`);
    } else {
      guidance.push(`Focus on symbols and files most directly affected by the task objective.`);
    }

    return guidance;
  }
}
