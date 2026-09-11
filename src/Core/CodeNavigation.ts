import path from 'node:path';
import type { WinCodeConfig } from './Config.js';
import { scanLocalFiles, type LocalScanResult } from './LocalTextScanner.js';
import { parseTextDeclarations } from './TextDeclarations.js';
import { boundedInteger, isWorkspacePathInside } from './WorkspaceContracts.js';
import { checkOperation, type OperationContext } from './OperationContext.js';

export interface TextSearchOptions {
  query: string; scopePaths?: string[]; caseSensitive?: boolean; maxResults?: number; maxOutputChars?: number;
}
export interface FileOutlineOptions { file: string; maxSymbols?: number; maxOutputChars?: number; }

const declarationExtensions = ['.cs', '.ts', '.tsx', '.js', '.jsx', '.py'];
const textExtensions = [...declarationExtensions, '.xaml', '.xml', '.csproj', '.sln', '.slnx', '.props', '.targets',
  '.json', '.md', '.txt', '.yml', '.yaml', '.config', '.ps1', '.mjs', '.cjs'];

/** Admission performs lexical checks only; the shared scanner separately validates real paths. */
export function navigationPath(value: unknown, root: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024 || /[\x00-\x1f*?]/.test(value) ||
    value.replace(/\\/g, '/').split('/').includes('..') ||
    value.slice(path.parse(value).root.length).includes(':')) throw new Error('Use a literal in-workspace path without globs or parent traversal.');
  const full = path.resolve(root, value);
  if (!isWorkspacePathInside(root, full, true)) throw new Error('Path is outside-workspace.');
  return path.relative(root, full).replace(/\\/g, '/') || '.';
}

export function validateTextSearch(options: TextSearchOptions, root: string) {
  if (typeof options.query !== 'string' || !options.query.trim() || options.query.length > 256 || /[\r\n\0]/.test(options.query))
    throw new Error('query must be a non-empty single-line literal of at most 256 characters.');
  const scopes = options.scopePaths ?? ['.'];
  if (!Array.isArray(scopes) || !scopes.length || scopes.length > 20) throw new Error('scopePaths accepts 1-20 literal files or directories.');
  if (options.caseSensitive !== undefined && typeof options.caseSensitive !== 'boolean') throw new Error('caseSensitive must be a boolean.');
  return { scopePaths: [...new Set(scopes.map(scope => navigationPath(scope, root)))],
    maxResults: boundedInteger(options.maxResults, 50, 1, 200, 'maxResults'),
    maxOutputChars: boundedInteger(options.maxOutputChars, 8000, 2048, 32768, 'maxOutputChars') };
}

export function validateFileOutline(options: FileOutlineOptions, root: string) {
  const file = navigationPath(options.file, root);
  if (!textExtensions.includes(path.extname(file).toLowerCase())) throw new Error('file must use a supported source or text extension.');
  return { file, maxSymbols: boundedInteger(options.maxSymbols, 100, 1, 200, 'maxSymbols'),
    maxOutputChars: boundedInteger(options.maxOutputChars, 8000, 2048, 32768, 'maxOutputChars') };
}

function nextRead(file: string, line: number, fileLineCount: number) {
  return { task: 'Inspect the located source; text matches and declarations are not semantic identity.',
    lineRanges: [{ file: file.replace(/\\/g, '/'), startLine: Math.max(1, line - 8), endLine: Math.min(fileLineCount, line + 16) }] };
}

export interface NavigationResponse {
  source: 'local-text'; scope: 'literal-text' | 'file-declarations';
  query?: string; caseSensitive?: boolean; scopePaths?: string[]; scopePathsOmitted?: number;
  file?: string; fileLineCount?: number | null; sizeBytes?: number | null; declarationsSupported?: boolean;
  matches?: unknown[]; symbols?: unknown[];
  nextRequest?: ReturnType<typeof nextRead>;
  scanComplete: boolean; queryComplete: boolean; queryError?: string; truncated: boolean;
  fileIssues: LocalScanResult<unknown>['fileIssues']; fileIssuesOmitted: number;
  scannedFiles: number; scannedBytes: number; foundItems: number; returnedItems: number;
  nextAction: string; limitations: string[];
}

function scanMetadata(scan: LocalScanResult<unknown>) {
  return { source: 'local-text' as const, scanComplete: scan.complete, queryComplete: scan.complete,
    queryError: scan.error, truncated: scan.truncated, fileIssues: scan.fileIssues, fileIssuesOmitted: scan.fileIssuesOmitted,
    scannedFiles: scan.filesRead, scannedBytes: scan.bytesRead, foundItems: scan.items.length, returnedItems: scan.items.length,
    nextAction: scan.fileIssues.length ? 'inspect_file_issues' : scan.items.length ? 'follow_next_request' : 'refine_query_or_scope',
    limitations: ['Text evidence only; scan completion does not establish semantic or task coverage.'] };
}

/** Budget the serialized transport form, retaining total counts when any details are omitted. */
function boundedResponse(data: NavigationResponse, maxCharacters: number): NavigationResponse {
  const items = data.matches ?? data.symbols!;
  while (JSON.stringify(data).length > maxCharacters) {
    data.truncated = true;
    data.queryComplete = false;
    data.nextAction = 'narrow_scope_or_increase_output_budget';
    if (data.fileIssues.length > 1) { data.fileIssues.pop(); data.fileIssuesOmitted++; }
    else if ((data.scopePaths?.length ?? 0) > 1) { data.scopePaths!.pop(); data.scopePathsOmitted = (data.scopePathsOmitted ?? 0) + 1; }
    else if (items.length) { items.pop(); data.returnedItems = items.length; }
    else if (data.fileIssues.length) { data.fileIssues.pop(); data.fileIssuesOmitted++; }
    else if (data.scopePaths?.length) { data.scopePaths.pop(); data.scopePathsOmitted = (data.scopePathsOmitted ?? 0) + 1; }
    else if (data.nextRequest) delete data.nextRequest;
    else if (data.limitations.length) data.limitations.pop();
    else throw new Error('Navigation metadata exceeds the output budget; use a shorter path or increase maxOutputChars.');
  }
  return data;
}

export async function searchText(config: WinCodeConfig, options: TextSearchOptions, operation?: OperationContext) {
  const { scopePaths, maxResults, maxOutputChars } = validateTextSearch(options, config.workspaceRoot);
  // Escaping keeps regex punctuation literal; matching itself cannot introduce user regex backtracking.
  const literal = new RegExp(options.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), options.caseSensitive ? '' : 'i');
  const scan = await scanLocalFiles(config.workspaceRoot, config.timeouts.fileScanMs, textExtensions, maxResults,
    function* (content, file) {
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        checkOperation(operation);
        const match = literal.exec(lines[index]);
        if (!match) continue;
        const start = Math.max(0, match.index - 80);
        const end = Math.min(lines[index].length, match.index + options.query.length + 80);
        yield { file: file.replace(/\\/g, '/'), line: index + 1, column: match.index + 1,
          preview: lines[index].slice(start, end), previewStartColumn: start + 1,
          previewTruncated: start > 0 || end < lines[index].length, nextRequest: nextRead(file, index + 1, lines.length) };
      }
    }, scopePaths, operation);
  return boundedResponse({ ...scanMetadata(scan), scope: 'literal-text', query: options.query,
    caseSensitive: options.caseSensitive ?? false, scopePaths, matches: scan.items }, maxOutputChars);
}

export async function fileOutline(config: WinCodeConfig, options: FileOutlineOptions, operation?: OperationContext) {
  const { file, maxSymbols, maxOutputChars } = validateFileOutline(options, config.workspaceRoot);
  let fileLineCount: number | null = null, sizeBytes: number | null = null;
  const declarationsSupported = declarationExtensions.includes(path.extname(file).toLowerCase());
  const scan = await scanLocalFiles(config.workspaceRoot, config.timeouts.fileScanMs, textExtensions, maxSymbols,
    (content, relativeFile, extension, byteLength) => {
      fileLineCount = content.split(/\r?\n/).length;
      sizeBytes = byteLength;
      return declarationsSupported ? parseTextDeclarations(content, relativeFile, extension, () => checkOperation(operation))
        .map(symbol => ({ ...symbol, file: symbol.file.replace(/\\/g, '/'), nextRequest: nextRead(file, symbol.line, fileLineCount!) })) : [];
    }, file, operation);
  return boundedResponse({ ...scanMetadata(scan), scope: 'file-declarations', file, fileLineCount, sizeBytes,
    ...(fileLineCount !== null ? { nextRequest: nextRead(file, 1, fileLineCount) } : {}),
    declarationsSupported, symbols: scan.items }, maxOutputChars);
}
