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

/** Short names change the spelling of a directory component, never its depth or volume.
 * The Gateway must confirm every alternate root before dispatching these relative arguments. */
export function dynamicNavigationPath(value: string, root: string, rootsToConfirm: Set<string>): string {
  if (!path.isAbsolute(value)) return value;
  const full = path.resolve(value);
  const volume = path.parse(full).root;
  const rootVolume = path.parse(root).root;
  if (path.relative(volume, rootVolume) !== '' || (process.platform === 'win32' &&
    (path.parse(value).root.length < 2 || /^[\\/]{2}[?.][\\/]/.test(value)))) throw new Error('Path is outside-workspace.');
  const depth = root.slice(rootVolume.length).split(path.sep).filter(Boolean).length;
  const parts = full.slice(volume.length).split(path.sep).filter(Boolean);
  if (parts.length < depth) throw new Error('Path is outside-workspace.');
  const prefix = path.join(volume, ...parts.slice(0, depth));
  const relative = navigationPath(value, prefix);
  if (prefix !== root) {
    if (process.platform !== 'win32') throw new Error('Path is outside-workspace.');
    rootsToConfirm.add(prefix);
  }
  return relative;
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

function nextRead(file: string, line: number, fileLineCount: number, workspacePath?: string) {
  return { ...(workspacePath && { workspacePath }), task: 'Inspect the located source; text matches and declarations are not semantic identity.',
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
  const field = data.matches ? 'matches' : 'symbols';
  const fits = () => JSON.stringify(data).length <= maxCharacters;
  while (!fits()) {
    data.truncated = true;
    data.queryComplete = false;
    data.nextAction = 'narrow_scope_or_increase_output_budget';
    if (data.fileIssues.length > 1) { data.fileIssues.pop(); data.fileIssuesOmitted++; }
    else if ((data.scopePaths?.length ?? 0) > 1) { data.scopePaths!.pop(); data.scopePathsOmitted = (data.scopePathsOmitted ?? 0) + 1; }
    else if (data[field]!.length) {
      const items = data[field]!;
      items.pop();
      data.returnedItems = items.length;
      if (fits()) return data;
      // Only the item prefix and its count change in this stage. Keep the existing metadata omission order.
      const keep = (count: number) => { data[field] = items.slice(0, count); data.returnedItems = count; };
      let low = 0, high = Math.max(0, items.length - 1);
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        keep(middle);
        if (fits()) low = middle;
        else high = middle - 1;
      }
      keep(low);
    }
    else if (data.fileIssues.length) { data.fileIssues.pop(); data.fileIssuesOmitted++; }
    else if (data.scopePaths?.length) { data.scopePaths.pop(); data.scopePathsOmitted = (data.scopePathsOmitted ?? 0) + 1; }
    else if (data.nextRequest) delete data.nextRequest;
    else if (data.limitations.length) data.limitations.pop();
    else throw new Error('Navigation metadata exceeds the output budget; use a shorter path or increase maxOutputChars.');
  }
  return data;
}

export async function searchText(config: WinCodeConfig, options: TextSearchOptions, operation?: OperationContext, workspacePath?: string) {
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
          previewTruncated: start > 0 || end < lines[index].length, nextRequest: nextRead(file, index + 1, lines.length, workspacePath) };
      }
    }, scopePaths, operation);
  return boundedResponse({ ...scanMetadata(scan), scope: 'literal-text', query: options.query,
    caseSensitive: options.caseSensitive ?? false, scopePaths, matches: scan.items }, maxOutputChars);
}

export async function fileOutline(config: WinCodeConfig, options: FileOutlineOptions, operation?: OperationContext, workspacePath?: string) {
  const { file, maxSymbols, maxOutputChars } = validateFileOutline(options, config.workspaceRoot);
  let fileLineCount: number | null = null, sizeBytes: number | null = null;
  const declarationsSupported = declarationExtensions.includes(path.extname(file).toLowerCase());
  const scan = await scanLocalFiles(config.workspaceRoot, config.timeouts.fileScanMs, textExtensions, maxSymbols,
    (content, relativeFile, extension, byteLength) => {
      fileLineCount = content.split(/\r?\n/).length;
      sizeBytes = byteLength;
      return declarationsSupported ? parseTextDeclarations(content, relativeFile, extension, () => checkOperation(operation))
        .map(symbol => ({ ...symbol, file: symbol.file.replace(/\\/g, '/'), nextRequest: nextRead(file, symbol.line, fileLineCount!, workspacePath) })) : [];
    }, file, operation);
  return boundedResponse({ ...scanMetadata(scan), scope: 'file-declarations', file, fileLineCount, sizeBytes,
    ...(fileLineCount !== null ? { nextRequest: nextRead(file, 1, fileLineCount, workspacePath) } : {}),
    declarationsSupported, symbols: scan.items }, maxOutputChars);
}
