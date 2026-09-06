import fs from 'node:fs/promises';
import path from 'node:path';
import { WinCodeConfig } from './Config.js';
import { RepomixAdapter } from '../Adapters/RepomixAdapter.js';
import { SerenaAdapter, CodeSymbol } from '../Adapters/SerenaAdapter.js';

export interface PreparedContext {
  task: string;
  summary: string;
  targetFiles: string[];
  keySymbols: CodeSymbol[];
  packedContent: string;
  estimatedTokens: number;
}

export class ContextManager {
  private config: WinCodeConfig;
  private repomix: RepomixAdapter;
  private serena: SerenaAdapter;

  constructor(config: WinCodeConfig, repomix: RepomixAdapter, serena: SerenaAdapter) {
    this.config = config;
    this.repomix = repomix;
    this.serena = serena;
  }

  /**
   * Prepares high-semantic, goal-oriented context for coding agents.
   * Instead of dumping raw entire repos, it filters key files, extracts relevant symbols,
   * and provides decision-ready context.
   */
  async prepareContext(taskDescription: string, candidateFiles?: string[]): Promise<PreparedContext> {
    const root = this.config.workspaceRoot;
    const keywords = taskDescription
      .split(/[\s,._\-:;，。、]+/)
      .filter((w) => w.length > 2)
      .map((w) => w.toLowerCase());

    const keySymbols: CodeSymbol[] = [];
    for (const kw of keywords.slice(0, 5)) {
      const symbols = await this.serena.findSymbols(kw);
      keySymbols.push(...symbols.slice(0, 5));
    }

    // Identify target files from candidate list and found symbols
    const targetFileSet = new Set<string>(candidateFiles || []);
    for (const sym of keySymbols) {
      targetFileSet.add(sym.file);
    }

    const targetFiles = Array.from(targetFileSet);

    // If target files were identified, pack only those files. Otherwise pack workspace snapshot.
    let packedContent = '';
    if (targetFiles.length > 0) {
      packedContent = `# Task Context for: "${taskDescription}"\n\n`;
      for (const relFile of targetFiles.slice(0, 15)) {
        const full = path.join(root, relFile);
        try {
          const content = await fs.readFile(full, 'utf-8');
          packedContent += `--- ${relFile} ---\n${content}\n\n`;
        } catch {
          // File might not exist yet
        }
      }
    } else {
      const packResult = await this.repomix.packWorkspace({ maxFiles: 20 });
      packedContent = packResult.content;
    }

    // Estimate tokens roughly (1 token ~= 4 chars)
    const estimatedTokens = Math.ceil(packedContent.length / 4);

    return {
      task: taskDescription,
      summary: `Context prepared with ${targetFiles.length} key files and ${keySymbols.length} extracted symbols.`,
      targetFiles,
      keySymbols,
      packedContent,
      estimatedTokens,
    };
  }
}
