/**
 * Task context for agents: ranked file evidence (path/symbol/line/snippet) inside a token budget.
 * Does not invent architecture advice when evidence is missing. includeFullText packs only the related set.
 */
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
  includeFullText?: boolean;
  maxTokens?: number;
}

export interface ContextEvidence {
  file: string;
  line?: number;
  symbol?: string;
  snippet: string;
  reason: string;
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
    budgetTokens: number;
    includeFullText: boolean;
  };
  guidance: string[];
  executiveSummary: string;
  formattedContent: string;
  evidence: ContextEvidence[];
  relatedFiles: { path: string; included: boolean; reason: string }[];
  omittedFiles: string[];
  evidenceInsufficient: boolean;
  limitations: string[];
}

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'this',
  'that',
  'with',
  'from',
  'into',
  'please',
  'analyze',
  'analysis',
  'architecture',
  'refactor',
  'project',
  'workspace',
  'code',
  'file',
]);

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

  async prepareContext(options: PreparedContextOptions | string): Promise<PreparedContextResult> {
    const opts: PreparedContextOptions =
      typeof options === 'string' ? { task: options } : options;
    const task = opts.task;
    const includeFullText = Boolean(opts.includeFullText);
    const budgetTokens = Math.max(512, opts.maxTokens ?? 8000);
    const maxChars = budgetTokens * 4;

    const identity: ProjectIdentity = await this.workspace.identifyProject();
    const keywords = this.extractKeywords(task);
    const limitations: string[] = [];

    const keySymbols: CodeSymbol[] = [];
    for (const kw of keywords.slice(0, 4)) {
      const detailed =
        typeof (this.serena as any).findSymbolsDetailed === 'function'
          ? await this.serena.findSymbolsDetailed(kw)
          : { symbols: await this.serena.findSymbols(kw), source: 'serena-adapter-fallback' as const };
      if ('limitations' in detailed && Array.isArray(detailed.limitations)) {
        limitations.push(...detailed.limitations);
      }
      keySymbols.push(...(detailed.symbols || []).slice(0, 5));
    }

    const related = new Map<string, string>();
    for (const cand of opts.candidateFiles || []) {
      related.set(this.normalizeRel(cand), 'candidateFiles');
    }
    for (const sym of keySymbols) {
      if (sym.file) {
        related.set(this.normalizeRel(sym.file), `symbol ${sym.name}`);
      }
    }
    if (related.size === 0 && keywords.length === 0) {
      if (identity.primarySolution) {
        related.set(this.normalizeRel(identity.primarySolution), 'solution file');
      }
      if (identity.type === 'node') {
        related.set('package.json', 'package manifest');
      }
    }
    if (opts.focusAreas && opts.focusAreas.length > 0) {
      await this.addFocusAreaFiles(related, opts.focusAreas, 8);
    }

    const evidence: ContextEvidence[] = [];
    let usedChars = 0;

    for (const [rel, reason] of related) {
      if (usedChars >= maxChars) break;
      const snippet = await this.readSnippet(rel, keySymbols, includeFullText, Math.min(4000, maxChars - usedChars));
      if (!snippet) continue;
      const symbol = keySymbols.find((s) => this.normalizeRel(s.file) === rel);
      evidence.push({
        file: rel,
        line: symbol?.line,
        symbol: symbol?.name,
        snippet: snippet.text,
        reason,
      });
      usedChars += snippet.text.length;
    }

    let snapshotSource = 'evidence-snippets';
    let fromCache = false;
    let packedContent = '';

    if (includeFullText && related.size > 0) {
      const packOptions: RepomixPackOptions = {
        outputFormat: opts.outputFormat || 'markdown',
        compress: opts.compress,
        candidateFiles: Array.from(related.keys()),
        maxFiles: 20,
      };
      const snapshot = await this.repomix.packWorkspace(packOptions);
      snapshotSource = snapshot.source;
      fromCache = snapshot.fromCache;
      packedContent = snapshot.content;
      if (packedContent.length > maxChars) {
        packedContent =
          packedContent.slice(0, Math.max(500, maxChars - 80)) +
          `\n\n[truncated to maxTokens=${budgetTokens}; pass a smaller candidateFiles set or raise maxTokens]\n`;
        limitations.push('Full-text snapshot was truncated to the requested token budget.');
      }
    } else if (includeFullText && related.size === 0) {
      limitations.push('No related files selected; refusing to dump the workspace as full text.');
    }

    const omittedFiles = Array.from(related.keys()).filter(
      (rel) => !evidence.some((e) => e.file === rel)
    );
    const evidenceInsufficient = evidence.length === 0;
    if (evidenceInsufficient) {
      limitations.push(
        '证据不足：未定位到与任务相关的符号或可读文件，无法据此判断职责拆分或架构建议。请提供 candidateFiles，或改用 includeFullText 拉取指定文件全文。'
      );
    }

    const uniqueLimitations = Array.from(new Set(limitations));
    const guidance = this.generateGuidance(task, identity, evidence, evidenceInsufficient);

    const executiveSummary = [
      `# AI Agent Context Snapshot`,
      `**Target Task**: "${task}"`,
      `**Project**: ${identity.name} (${identity.type.toUpperCase()}, Primary Language: ${identity.language})`,
      identity.primarySolution
        ? `**Solution**: ${identity.primarySolution} (${identity.projectFiles.length} projects)`
        : null,
      identity.targetFramework ? `**Target Framework**: ${identity.targetFramework}` : null,
      `**Budget**: ${budgetTokens} tokens; includeFullText=${includeFullText}`,
      `**Evidence files**: ${evidence.length}; omitted: ${omittedFiles.length}`,
      evidenceInsufficient ? `**Evidence**: insufficient` : `**Evidence**: ${evidence.length} snippet(s) with file locations`,
    ]
      .filter(Boolean)
      .join('\n');

    let formattedContent = `${executiveSummary}\n\n`;

    if (guidance.length > 0) {
      formattedContent += `## Guidance\n`;
      for (const item of guidance) {
        formattedContent += `- ${item}\n`;
      }
      formattedContent += `\n`;
    }

    if (keySymbols.length > 0) {
      formattedContent += `## Symbols\n`;
      for (const sym of keySymbols.slice(0, 12)) {
        formattedContent += `- \`${sym.kind}\` **${sym.name}** (${sym.file}:${sym.line})\n`;
      }
      formattedContent += `\n`;
    }

    formattedContent += `## Evidence\n\n`;
    if (evidence.length === 0) {
      formattedContent += `_No file-backed evidence. Not an architecture conclusion._\n\n`;
    } else {
      for (const item of evidence) {
        formattedContent += `### ${item.file}${item.line ? `:${item.line}` : ''}\n`;
        formattedContent += `Reason: ${item.reason}${item.symbol ? ` (${item.symbol})` : ''}\n\n`;
        formattedContent += '```\n' + item.snippet + '\n```\n\n';
      }
    }

    if (omittedFiles.length > 0) {
      formattedContent += `## Omitted related files\n`;
      for (const file of omittedFiles) {
        formattedContent += `- ${file} (call again with includeFullText=true or candidateFiles)\n`;
      }
      formattedContent += `\n`;
    }

    if (includeFullText && packedContent) {
      formattedContent += `## Packed snapshot\n\n${packedContent}\n`;
    }

    if (uniqueLimitations.length > 0) {
      formattedContent += `## Limitations\n`;
      for (const item of uniqueLimitations) {
        formattedContent += `- ${item}\n`;
      }
    }

    const relatedFiles = Array.from(related.entries()).map(([p, reason]) => ({
      path: p,
      included: evidence.some((e) => e.file === p),
      reason,
    }));

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
        packedFiles: evidence.length,
        totalCharacters: formattedContent.length,
        estimatedTokens: Math.ceil(formattedContent.length / 4),
        source: snapshotSource,
        fromCache,
        budgetTokens,
        includeFullText,
      },
      guidance,
      executiveSummary,
      formattedContent,
      evidence,
      relatedFiles,
      omittedFiles,
      evidenceInsufficient,
      limitations: uniqueLimitations,
    };
  }

  private async addFocusAreaFiles(
    related: Map<string, string>,
    focusAreas: string[],
    cap: number
  ): Promise<void> {
    const root = this.workspace.root;
    const codeExts = new Set(['.ts', '.js', '.cs', '.tsx', '.jsx', '.py', '.xaml', '.csproj', '.sln']);

    for (const area of focusAreas.slice(0, 5)) {
      if (related.size >= cap) break;
      const full = path.isAbsolute(area) ? area : path.join(root, area);
      try {
        const stat = await fs.stat(full);
        if (stat.isFile()) {
          related.set(this.normalizeRel(full), 'focusAreas');
          continue;
        }
        if (!stat.isDirectory()) continue;
        const entries = await fs.readdir(full, { withFileTypes: true });
        for (const entry of entries) {
          if (related.size >= cap) break;
          if (!entry.isFile()) continue;
          const ext = path.extname(entry.name).toLowerCase();
          if (!codeExts.has(ext) && entry.name.toLowerCase() !== 'dockerfile') continue;
          related.set(this.normalizeRel(path.join(full, entry.name)), 'focusAreas');
        }
      } catch {
        // Ignore missing focus areas
      }
    }
  }

  private extractKeywords(task: string): string[] {
    return task
      .split(/[\s,._\-:;，。、]+/)
      .map((w) => w.trim())
      .filter((w) => w.length > 2 && /[A-Za-z0-9_]/.test(w) && !STOPWORDS.has(w.toLowerCase()));
  }

  private normalizeRel(filePath: string): string {
    if (!filePath) return '';
    const root = this.workspace.root;
    const resolved = path.isAbsolute(filePath) ? filePath : path.join(root, filePath);
    return path.relative(root, resolved).replace(/\\/g, '/') || filePath.replace(/\\/g, '/');
  }

  private async readSnippet(
    rel: string,
    symbols: CodeSymbol[],
    full: boolean,
    maxChars: number
  ): Promise<{ text: string } | null> {
    const fullPath = path.isAbsolute(rel) ? rel : path.join(this.workspace.root, rel);
    try {
      const content = await fs.readFile(fullPath, 'utf-8');
      if (full) {
        return { text: content.length > maxChars ? content.slice(0, maxChars) + '\n...' : content };
      }
      const lines = content.split(/\r?\n/);
      const symbol = symbols.find((s) => this.normalizeRel(s.file) === this.normalizeRel(rel));
      const center = symbol?.line && symbol.line > 0 ? symbol.line - 1 : 0;
      const start = Math.max(0, center - 8);
      const end = Math.min(lines.length, start + 24);
      const slice = lines.slice(start, end).join('\n');
      return { text: slice.slice(0, maxChars) };
    } catch {
      return null;
    }
  }

  private generateGuidance(
    task: string,
    identity: ProjectIdentity,
    evidence: ContextEvidence[],
    insufficient: boolean
  ): string[] {
    if (insufficient) {
      return [
        '证据不足，无法给出拆分或架构结论。下面不是建议，只是缺口说明。',
        '提供 candidateFiles，或对已定位符号调用 find_references / analyze_change_impact。',
      ];
    }

    const files = evidence.map((e) => e.file).join(', ');
    const guidance = [`Located file-backed evidence in: ${files}.`];
    if (identity.primarySolution) {
      guidance.push(`Solution file: ${identity.primarySolution} (${identity.projectFiles.length} projects listed).`);
    }
    guidance.push('Use analyze_change_impact on a uniquely resolved type before editing public contracts.');
    return guidance;
  }
}
