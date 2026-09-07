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
  scopeFiles?: string[];
  symbol?: string;
  lineRanges?: { file: string; startLine: number; endLine: number }[];
  focusAreas?: string[];
  compress?: boolean;
  outputFormat?: 'markdown' | 'xml';
  responseFormat?: 'compact' | 'legacy';
  includeFullText?: boolean;
  maxTokens?: number;
}

export interface ContextEvidence {
  file: string;
  line?: number;
  symbol?: string;
  startLine: number;
  endLine: number;
  locationKind: 'symbol' | 'file-start' | 'full-file' | 'line-range';
  truncated: boolean;
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
    selectedFiles?: number;
    returnedFiles?: number | null;
    totalCharacters: number;
    estimatedTokens: number;
    tokenEstimation: 'characters-divided-by-4';
    measurementScope: 'formatted-content' | 'mcp-text-blocks';
    source: string;
    fromCache: boolean;
    budgetTokens: number;
    includeFullText: boolean;
  };
  guidance: string[];
  executiveSummary: string;
  formattedContent: string;
  packedContent?: string;
  packedFileSpans?: { file: string; start: number; end: number }[];
  evidence: ContextEvidence[];
  relatedFiles: { path: string; included: boolean; reason: string }[];
  omittedFiles: string[];
  fileIssues: { path: string; reason: string }[];
  queryComplete: boolean;
  truncated: boolean;
  evidenceInsufficient: boolean;
  limitations: string[];
}

export function validateContextOptions(value: unknown): asserts value is PreparedContextOptions {
  if (!value || typeof value !== 'object') throw new Error('Context options must be an object.');
  const opts = value as Record<string, unknown>;
  if (typeof opts.task !== 'string' || !opts.task.trim() || opts.task.length > 8192) {
    throw new Error('task must be a non-empty string of at most 8192 characters.');
  }
  for (const [key, cap] of [['candidateFiles', 20], ['focusAreas', 5], ['scopeFiles', 20]] as const) {
    const files = opts[key];
    if (files === undefined) continue;
    if (!Array.isArray(files) || files.length > cap || files.some(file => typeof file !== 'string' ||
      !file.trim() || file.length > 1024 || /[\x00-\x1f*?]/.test(file) || file.replace(/\\/g, '/').split('/').includes('..'))) {
      throw new Error(`${key} accepts at most ${cap} literal in-workspace paths; glob patterns and parent traversal are unsupported. Supply an existing file or directory path, e.g. src/Core.`);
    }
  }
  if (opts.scopeFiles !== undefined && (!(opts.scopeFiles as string[]).length || opts.focusAreas !== undefined)) {
    throw new Error('scopeFiles must be non-empty and cannot be combined with focusAreas.');
  }
  if (opts.symbol !== undefined && (typeof opts.symbol !== 'string' || !opts.symbol.trim() ||
    opts.symbol.length > 128 || /\s/.test(opts.symbol) || !opts.scopeFiles || opts.lineRanges !== undefined)) {
    throw new Error('symbol must be an exact name of at most 128 characters, requires scopeFiles, and cannot be combined with lineRanges.');
  }
  if (opts.lineRanges !== undefined) {
    if (!Array.isArray(opts.lineRanges) || !opts.lineRanges.length || opts.lineRanges.length > 8 || opts.includeFullText === true) {
      throw new Error('lineRanges accepts 1-8 file ranges and cannot be combined with includeFullText.');
    }
    for (const range of opts.lineRanges) {
      if (!range || typeof range !== 'object' || !Number.isSafeInteger(range.startLine) || !Number.isSafeInteger(range.endLine) ||
        range.startLine < 1 || range.endLine < range.startLine || range.endLine - range.startLine >= 500) {
        throw new Error('Each line range must contain inclusive positive startLine/endLine, at most 500 lines.');
      }
      validateContextOptions({ task: opts.task, candidateFiles: [range.file] });
    }
  }
  if (opts.maxTokens !== undefined && (!Number.isInteger(opts.maxTokens) ||
    (opts.maxTokens as number) < 512 || (opts.maxTokens as number) > 65536)) {
    throw new Error('maxTokens must be an integer from 512 to 65536 (estimated using characters / 4).');
  }
  for (const key of ['includeFullText', 'compress']) {
    if (opts[key] !== undefined && typeof opts[key] !== 'boolean') throw new Error(`${key} must be a boolean.`);
  }
  if (opts.responseFormat !== undefined && !['compact', 'legacy'].includes(opts.responseFormat as string)) {
    throw new Error('responseFormat must be compact or legacy.');
  }
  if (opts.outputFormat !== undefined && !['markdown', 'xml'].includes(opts.outputFormat as string)) {
    throw new Error('outputFormat must be markdown or xml.');
  }
}

/** Budget UTF-16 characters without cutting a surrogate pair. */
export function clipContextText(text: string, limit: number): string {
  let end = Math.max(0, Math.min(text.length, Math.floor(limit)));
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  return text.slice(0, end);
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
    validateContextOptions(opts);
    for (const file of [...(opts.candidateFiles || []), ...(opts.focusAreas || [])]) this.normalizeRel(file);
    const scope = opts.scopeFiles ? [...new Set(opts.scopeFiles.map(file => this.normalizeRel(file)))] : undefined;
    const ranges = new Map<string, { startLine: number; endLine: number }>();
    for (const range of opts.lineRanges || []) {
      const file = this.normalizeRel(range.file);
      if (ranges.has(file)) throw new Error('lineRanges supports one range per file.');
      ranges.set(file, range);
    }
    if (scope && [...(opts.candidateFiles || []).map(file => this.normalizeRel(file)), ...ranges.keys()].some(file => !scope.includes(file))) {
      throw new Error('candidateFiles and lineRanges must stay inside scopeFiles.');
    }
    const task = opts.task;
    const includeFullText = Boolean(opts.includeFullText);
    const budgetTokens = Math.max(512, opts.maxTokens ?? 8000);
    const maxChars = budgetTokens * 4;

    const identity: ProjectIdentity = await this.workspace.identifyProject();
    const keywords = scope || ranges.size ? [] : this.extractKeywords(task);
    const limitations: string[] = [];
    const fileIssues: PreparedContextResult['fileIssues'] = [];
    let queryComplete = true;
    let truncated = false;

    const keySymbols: CodeSymbol[] = [];
    const sourceContents = new Map<string, string>();
    if (opts.symbol && scope) {
      for (const file of scope) {
        try {
          const full = await this.resolveFile(file);
          const stat = await fs.stat(full);
          if (!stat.isFile()) { fileIssues.push({ path: file, reason: 'not-file' }); continue; }
          if (stat.size >= 500_000) { fileIssues.push({ path: file, reason: 'file-too-large' }); continue; }
          if (!['.cs', '.ts', '.js', '.py'].includes(path.extname(file).toLowerCase())) {
            fileIssues.push({ path: file, reason: 'unsupported-symbol-language' }); continue;
          }
          const source = await fs.readFile(full, 'utf8');
          sourceContents.set(file, source);
          const matches = this.serena.findSymbolsInContent(source, file)
            .filter(symbol => symbol.name === opts.symbol);
          if (matches.length === 1) keySymbols.push(matches[0]);
          else fileIssues.push({ path: file, reason: matches.length ? `ambiguous-symbol:${matches.length}` : 'symbol-not-found' });
        } catch (error) { fileIssues.push({ path: file, reason: this.readIssue(error) }); }
      }
      if (keySymbols.length > 1 || fileIssues.some(issue => issue.reason.startsWith('ambiguous-symbol'))) {
        for (const match of keySymbols) fileIssues.push({ path: match.file, reason: 'ambiguous-symbol-across-files' });
        keySymbols.length = 0;
      }
      queryComplete = false;
      limitations.push('Scoped symbol matching uses local declaration patterns, not semantic analysis; matches may be incomplete. Use lineRanges for exact known locations.');
    }
    for (const kw of keywords.slice(0, 4)) {
      const detailed =
        typeof (this.serena as any).findSymbolsDetailed === 'function'
          ? await this.serena.findSymbolsDetailed(kw)
          : { symbols: await this.serena.findSymbols(kw), source: 'serena-adapter-fallback' as const };
      if ('limitations' in detailed && Array.isArray(detailed.limitations)) {
        limitations.push(...detailed.limitations);
      }
      if ('queryComplete' in detailed && detailed.queryComplete === false) queryComplete = false;
      keySymbols.push(...(detailed.symbols || []).slice(0, 5));
    }

    // Keep the best task match per file so reason, declaration and excerpt agree.
    const score = (symbol: CodeSymbol) => keywords.some(word => word.toLowerCase() === symbol.name.toLowerCase()) ? 2 :
      keywords.some(word => symbol.name.toLowerCase().includes(word.toLowerCase())) ? 1 : 0;
    keySymbols.sort((a, b) => score(b) - score(a));
    const selectedSymbols = new Map<string, CodeSymbol>();
    for (const symbol of keySymbols) {
      if (!symbol.file) continue;
      try {
        const file = this.normalizeRel(symbol.file);
        if (!selectedSymbols.has(file)) selectedSymbols.set(file, symbol);
      } catch { fileIssues.push({ path: symbol.file, reason: 'outside-workspace' }); }
    }

    const related = new Map<string, string>();
    for (const cand of opts.candidateFiles || []) {
      related.set(this.normalizeRel(cand), 'candidateFiles');
    }
    for (const file of scope || []) related.set(file, 'scopeFiles');
    for (const file of ranges.keys()) related.set(file, 'lineRanges');
    for (const sym of selectedSymbols.values()) {
      if (sym.file) {
        related.set(this.normalizeRel(sym.file), `symbol ${sym.name}`);
      }
    }
    if (related.size === 0 && keywords.length === 0 && !scope && !ranges.size && !opts.focusAreas?.length && !opts.candidateFiles?.length) {
      if (identity.primarySolution) {
        related.set(this.normalizeRel(identity.primarySolution), 'solution file');
      }
      if (identity.type === 'node') {
        related.set('package.json', 'package manifest');
      }
    }
    if (opts.focusAreas && opts.focusAreas.length > 0) {
      await this.addFocusAreaFiles(related, opts.focusAreas, 8, fileIssues);
    }

    const evidence: ContextEvidence[] = [];
    let usedChars = 0;

    for (const [rel, reason] of related) {
      if (opts.symbol && !selectedSymbols.has(rel)) continue;
      if (ranges.size && !ranges.has(rel)) continue;
      if (usedChars >= maxChars || evidence.length >= 20) { truncated = true; break; }
      const snippet = await this.readSnippet(rel, [...selectedSymbols.values()], includeFullText, Math.min(4000, maxChars - usedChars), fileIssues, ranges.get(rel), sourceContents.get(rel));
      if (!snippet) continue;
      const symbol = snippet.symbol;
      evidence.push({
        file: rel,
        line: symbol?.line,
        symbol: symbol?.name,
        startLine: snippet.startLine,
        endLine: snippet.endLine,
        locationKind: ranges.has(rel) ? 'line-range' : includeFullText ? 'full-file' : symbol ? 'symbol' : 'file-start',
        truncated: snippet.truncated,
        snippet: snippet.text,
        reason: symbol ? `symbol ${symbol.name}` : reason.startsWith('symbol ') ? 'file-start; symbol location unavailable' : reason,
      });
      usedChars += snippet.text.length;
      if (!includeFullText && snippet.truncated) truncated = true;
    }

    let snapshotSource = 'evidence-snippets';
    let fromCache = false;
    let packedContent = '';
    let packedFileSpans: PreparedContextResult['packedFileSpans'];
    let packedFileCount = 0;

    if (includeFullText && evidence.length > 0) {
      const packOptions: RepomixPackOptions = {
        outputFormat: opts.outputFormat || 'markdown',
        compress: opts.compress,
        candidateFiles: evidence.map(item => item.file),
        maxFiles: 20,
      };
      const snapshot = await this.repomix.packWorkspace(packOptions);
      snapshotSource = snapshot.source;
      fromCache = snapshot.fromCache;
      packedContent = snapshot.content;
      packedFileCount = snapshot.fileCount;
      packedFileSpans = snapshot.fileSpans;
      if (snapshot.fileCount > 0 && !snapshot.fileSpans) limitations.push('Packed file coverage is unknown: packer supplied no file-body spans.');
      if (snapshot.fileCount === 0) packedContent = '';
      if (snapshot.contentOmitted || snapshot.fileCount < evidence.length) {
        truncated = true;
        limitations.push('Packed snapshot is partial; narrow candidateFiles and check the packer output.');
      }
      if (packedContent.length > maxChars) {
        packedContent = clipContextText(packedContent, maxChars);
        truncated = true;
        limitations.push('Full-text snapshot was truncated to the requested token budget.');
      }
    } else if (includeFullText) {
      limitations.push('No related files selected; refusing to dump the workspace as full text.');
    }

    const omittedFiles = Array.from(related.keys()).filter(
      (rel) => !evidence.some((e) => e.file === rel)
    );
    const evidenceInsufficient = evidence.length === 0 || (includeFullText && !packedContent);
    if (evidenceInsufficient) {
      limitations.push(
        '证据不足：未定位到与任务相关的符号或可读文件，无法据此判断职责拆分或架构建议。请提供 candidateFiles，或改用 includeFullText 拉取指定文件全文。'
      );
    }
    if (!queryComplete && limitations.length === 0) limitations.push('Symbol search is incomplete; missing matches do not prove absence.');

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
        formattedContent += `### ${item.file}:${item.startLine}-${item.endLine}\n`;
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
        packedFiles: includeFullText ? packedFileCount : evidence.length,
        totalCharacters: formattedContent.length,
        estimatedTokens: Math.ceil(formattedContent.length / 4),
        tokenEstimation: 'characters-divided-by-4',
        measurementScope: 'formatted-content',
        source: snapshotSource,
        fromCache,
        budgetTokens,
        includeFullText,
      },
      guidance,
      executiveSummary,
      formattedContent,
      packedContent: includeFullText ? packedContent : undefined,
      packedFileSpans,
      evidence,
      relatedFiles,
      omittedFiles,
      fileIssues,
      queryComplete,
      truncated: truncated || fileIssues.some(item => item.reason === 'selection-limit'),
      evidenceInsufficient,
      limitations: uniqueLimitations,
    };
  }

  private async addFocusAreaFiles(
    related: Map<string, string>,
    focusAreas: string[],
    cap: number,
    issues: PreparedContextResult['fileIssues']
  ): Promise<void> {
    const codeExts = new Set(['.ts', '.js', '.cs', '.tsx', '.jsx', '.py', '.xaml', '.csproj', '.sln']);

    let added = 0;
    for (const area of focusAreas) {
      try {
        const full = await this.resolveFile(area);
        const stat = await fs.stat(full);
        if (stat.isFile()) {
          const file = this.normalizeRel(area);
          if (!related.has(file)) {
            if (added >= cap) issues.push({ path: area, reason: 'selection-limit' });
            else { related.set(file, 'focusAreas'); added++; }
          }
          continue;
        }
        if (!stat.isDirectory()) { issues.push({ path: area, reason: 'not-file' }); continue; }
        let scanned = 0;
        let matched = false;
        const entries = await fs.opendir(full);
        for await (const entry of entries) {
          if (++scanned > 1000) { issues.push({ path: area, reason: 'selection-limit' }); break; }
          if (!entry.isFile()) continue;
          const ext = path.extname(entry.name).toLowerCase();
          if (!codeExts.has(ext) && entry.name.toLowerCase() !== 'dockerfile') continue;
          matched = true;
          const file = this.normalizeRel(path.join(area, entry.name));
          if (related.has(file)) continue;
          if (added >= cap) { issues.push({ path: area, reason: 'selection-limit' }); break; }
          related.set(file, 'focusAreas'); added++;
        }
        if (!matched) issues.push({ path: area, reason: 'no-matching-files' });
      } catch (error) {
        issues.push({ path: area, reason: this.readIssue(error) });
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
    const rel = path.relative(root, resolved);
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('Path is outside-workspace.');
    return rel.replace(/\\/g, '/') || '.';
  }

  private async resolveFile(file: string): Promise<string> {
    const realRoot = await fs.realpath(this.workspace.root);
    const real = await fs.realpath(path.resolve(this.workspace.root, this.normalizeRel(file)));
    const rel = path.relative(realRoot, real);
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('Path is outside-workspace.');
    return real;
  }

  private readIssue(error: unknown): string {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return 'not-found';
    return error instanceof Error && error.message.includes('outside-workspace') ? 'outside-workspace' : 'unreadable';
  }

  private async readSnippet(
    rel: string,
    symbols: CodeSymbol[],
    full: boolean,
    maxChars: number,
    issues: PreparedContextResult['fileIssues'],
    range?: { startLine: number; endLine: number },
    sourceContent?: string
  ): Promise<{ text: string; startLine: number; endLine: number; truncated: boolean; symbol?: CodeSymbol } | null> {
    try {
      const fullPath = await this.resolveFile(rel);
      const stat = await fs.stat(fullPath);
      if (!stat.isFile()) { issues.push({ path: rel, reason: 'not-file' }); return null; }
      if (stat.size >= 500_000) { issues.push({ path: rel, reason: 'file-too-large' }); return null; }
      const content = sourceContent ?? await fs.readFile(fullPath, 'utf-8');
      const lines = content.split(/\r?\n/);
      if (range && range.endLine > lines.length) { issues.push({ path: rel, reason: 'line-range-out-of-bounds' }); return null; }
      const symbol = symbols.find((s) => this.normalizeRel(s.file) === this.normalizeRel(rel) &&
        Number.isInteger(s.line) && s.line! > 0 && s.line! <= lines.length);
      const center = symbol?.line && symbol.line > 0 ? symbol.line - 1 : 0;
      let start = range ? range.startLine - 1 : full ? 0 : Math.max(0, center - 8);
      const end = range ? range.endLine : full ? lines.length : Math.min(lines.length, start + 24);
      let slice = lines.slice(start, end).join('\n');
      let text = clipContextText(slice, maxChars);
      // A long prefix must not spend the whole budget before the matched declaration.
      const declarationOffset = symbol ? lines.slice(start, center).join('\n').length + (center > start ? 1 : 0) : 0;
      const skippedPrefix = !full && symbol && text.length <= declarationOffset;
      if (skippedPrefix) {
        start = center;
        slice = lines.slice(start, end).join('\n');
        text = clipContextText(slice, maxChars);
      }
      const endLine = start + text.split('\n').length;
      return { text, startLine: start + 1, endLine, truncated: Boolean(skippedPrefix) || text.length < slice.length,
        symbol: symbol && symbol.line! >= start + 1 && symbol.line! <= endLine ? symbol : undefined };
    } catch (error) {
      issues.push({ path: rel, reason: this.readIssue(error) });
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

    const guidance = ['Check the displayed range and locationKind; readable file evidence does not establish task coverage.'];
    if (identity.primarySolution) {
      guidance.push(`Solution file: ${identity.primarySolution} (${identity.projectFiles.length} projects listed).`);
    }
    guidance.push('Use analyze_change_impact on a uniquely resolved type before editing public contracts.');
    return guidance;
  }
}
