import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AbortError } from './ResourceManager.js';
import { UiNode } from './UiContracts.js';
import { createTextSearch, searchTagText, UiTextSearch } from './UiTextSearch.js';

export interface UiSourceCandidate {
  file: string;
  line: number;
  element: string;
  automationId: string;
  snippet: string;
  fileSha256: string;
  declarations: Record<string, string>;
}

export interface UiSourceEvidence {
  method: 'literal-xaml-candidates';
  runtimeSourceVerified: false;
  fileScanComplete: boolean;
  declarationCoverage: { literalIds: number; unsupportedDeclarations: number };
  coverage: { evaluatedNodes: number; returnedNodes: number; nodesWithAutomationId: number; matchedNodes: number };
  files: Array<{ file: string; status: string }>;
  nodes: Array<{
    nodeId: number;
    status: 'single-candidate' | 'ambiguous' | 'not-found' | 'unsupported';
    reason: 'literal-match' | 'multiple-literal-candidates' | 'missing-automation-id' |
      'possibly-truncated-id' | 'unsupported-id-value' | 'incomplete-file-scan' |
      'no-literal-match' | 'no-literal-match-with-unsupported-declarations';
    candidates: UiSourceCandidate[];
    candidateCount: number;
  }>;
  truncated: boolean;
  limitations: string[];
  textSearch?: UiTextSearch;
}

export function validateCandidateFiles(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16 || value.some(file =>
    typeof file !== 'string' || file.length > 512 || !file.trim() ||
    path.isAbsolute(file) || /[:\x00]/.test(file) ||
    file.split(/[\\/]/).some(part => part === '..') || !/\.xaml$/i.test(file))) {
    throw new Error('candidateFiles must contain 1–16 relative in-workspace .xaml paths without parent traversal.');
  }
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortError();
}

/** Literal declaration search, deliberately not a XAML evaluator or runtime identity resolver. */
export async function mapUiSources(
  workspaceRoot: string, candidateFiles: string[], tree: UiNode, signal?: AbortSignal, textQueries?: string[]
): Promise<UiSourceEvidence> {
  validateCandidateFiles(candidateFiles);
  const result: UiSourceEvidence = {
    method: 'literal-xaml-candidates', runtimeSourceVerified: false, fileScanComplete: false,
    declarationCoverage: { literalIds: 0, unsupportedDeclarations: 0 },
    coverage: { evaluatedNodes: 0, returnedNodes: 0, nodesWithAutomationId: 0, matchedNodes: 0 },
    files: [], nodes: [], truncated: false,
    textSearch: createTextSearch(textQueries),
    limitations: [
      'Candidates refer only to supplied files; no runtime build/source identity has been verified.',
      'Literal start-tag attributes only; namespaces, resources, templates, property elements and Binding/DataContext are not evaluated.',
      'AutomationId is not globally unique. One source declaration can produce multiple runtime controls.',
    ],
  };
  const declarations = new Map<string, UiSourceCandidate[]>();
  const deadline = Date.now() + 2000;
  const checkpoint = () => {
    checkCancelled(signal);
    if (Date.now() >= deadline) throw new Error('Source lookup deadline exceeded.');
  };
  const root = await fs.realpath(workspaceRoot);
  let remainingBytes = 1024 * 1024;
  const seen = new Set<string>();
  for (const file of candidateFiles) {
    checkpoint();
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      const real = await fs.realpath(path.resolve(root, file));
      const relative = path.relative(root, real);
      // Resolve junctions/symlinks before reading: candidate hints never authorize outside files.
      if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
        result.files.push({ file, status: 'outside-workspace' }); continue;
      }
      if (!/\.xaml$/i.test(real)) {
        result.files.push({ file, status: 'not-xaml' }); continue;
      }
      const identity = process.platform === 'win32' ? real.toLowerCase() : real;
      if (seen.has(identity)) continue;
      seen.add(identity);
      handle = await fs.open(real, 'r');
      const before = await handle.stat();
      if (!before.isFile() || before.size > 256 * 1024 || before.size > remainingBytes) {
        result.files.push({ file, status: 'file-budget-or-not-regular' }); result.truncated = true; continue;
      }
      // Fixed-size reads stay bounded even if another process grows the file after stat().
      const buffer = Buffer.alloc(before.size + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        checkpoint();
        const read = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (!read.bytesRead) break;
        bytesRead += read.bytesRead;
      }
      remainingBytes -= bytesRead;
      const after = await handle.stat();
      if (bytesRead !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
        result.files.push({ file, status: 'changed-during-read' }); continue;
      }
      let source: string;
      try { source = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)); }
      catch { result.files.push({ file, status: 'unsupported-encoding' }); continue; }
      if (source.includes('\0')) { result.files.push({ file, status: 'unsupported-encoding' }); continue; }
      const fileSha256 = createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex');
      const relativeFile = relative.replace(/\\/g, '/');
      // Skip complete comments/CDATA/PIs, preserve offsets, and consume quoted > as attribute text.
      // This only produces textual candidates; malformed XML can never imply a resolved UI identity.
      const tokens = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<\?[\s\S]*?(?:\?>|$)|<[^>"']*(?:"[^"]*"[^>"']*|'[^']*'[^>"']*)*>/g;
      let previous = 0;
      let line = 1;
      for (const token of source.matchAll(tokens)) {
        checkpoint();
        line += (source.slice(previous, token.index).match(/\n/g) || []).length;
        previous = token.index!;
        const tag = token[0];
        const element = /^<([\w:.-]+)(?=\s|\/?>)/.exec(tag)?.[1];
        if (!element) continue;
        if (result.textSearch) searchTagText(result.textSearch, tag, {
          file: relativeFile, line, element, fileSha256,
        });
        const attributes: Record<string, string> = Object.create(null);
        for (const attr of tag.matchAll(/\s([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
          attributes[attr[1]] = attr[2] ?? attr[3];
        }
        const id = attributes['AutomationProperties.AutomationId'];
        // Report unsupported syntax as a coverage gap, never as proof that it produced this node.
        if (/(?:^|:)AutomationProperties\.AutomationId$/.test(element) ||
          Object.keys(attributes).some(name => name !== 'AutomationProperties.AutomationId' &&
            /:AutomationProperties\.AutomationId$/.test(name))) {
          result.declarationCoverage.unsupportedDeclarations++;
        }
        // Host clips at 256 characters; a boundary-length ID may already have lost its suffix.
        if (id !== undefined && (!id || id.length >= 256 || /[&{}]/.test(id))) {
          result.declarationCoverage.unsupportedDeclarations++;
          continue;
        }
        if (!id) continue;
        result.declarationCoverage.literalIds++;
        const hits = declarations.get(id) || [];
        hits.push({ file: relativeFile, line, element, fileSha256, automationId: id,
          snippet: tag.slice(0, 600),
          declarations: Object.fromEntries(Object.entries(attributes)
            .filter(([name]) => ['Command', 'CommandParameter', 'Click', 'Text', 'IsEnabled'].includes(name))
            .map(([name, value]) => [name, value.slice(0, 256)])),
        });
        declarations.set(id, hits);
      }
      result.files.push({ file: relativeFile, status: 'scanned-literals' });
    } catch (error) {
      checkpoint();
      result.files.push({ file, status: 'unreadable' });
    } finally { await handle?.close(); }
  }
  // A single candidate in readable files is still only a partial search when another file failed.
  result.fileScanComplete = result.files.every(file => file.status === 'scanned-literals');
  const pending = [tree];
  while (pending.length && result.nodes.length < 100) {
    checkpoint();
    const node = pending.pop()!;
    const id = node.automationId;
    const supported = Boolean(id && id.length < 256 && !/[&{}]/.test(id));
    const hits = supported ? declarations.get(id!) || [] : [];
    const reason = !id ? 'missing-automation-id' : id.length >= 256 ? 'possibly-truncated-id'
      : !supported ? 'unsupported-id-value' : hits.length > 1 ? 'multiple-literal-candidates'
      : hits.length ? 'literal-match' : !result.fileScanComplete ? 'incomplete-file-scan'
      : result.declarationCoverage.unsupportedDeclarations > 0 ? 'no-literal-match-with-unsupported-declarations'
      : 'no-literal-match';
    if (id) result.coverage.nodesWithAutomationId++;
    if (hits.length) result.coverage.matchedNodes++;
    result.nodes.push({ nodeId: node.id,
      reason,
      status: !supported ? 'unsupported' : hits.length > 1 ? 'ambiguous' : hits.length ? 'single-candidate' : 'not-found',
      candidates: hits.slice(0, 5), candidateCount: hits.length });
    if (hits.length > 5) result.truncated = true;
    pending.push(...node.children.slice().reverse());
  }
  if (pending.length) result.truncated = true;
  result.coverage.evaluatedNodes = result.nodes.length;
  result.coverage.returnedNodes = result.nodes.length;
  if (result.textSearch) {
    result.textSearch.nextChecks.push('Text hits are navigation evidence only; compare the source and runtime control manually.');
    if (!result.fileScanComplete) result.textSearch.nextChecks.push('Resolve unreadable/omitted candidate files before interpreting missing matches.');
    if (!result.textSearch.totalMatches) result.textSearch.nextChecks.push('Narrow the candidate view or supply a known resource key; localized text is not resolved automatically.');
    if (result.textSearch.matches.some(match => match.kind === 'resource-reference')) result.textSearch.nextChecks.push('Inspect the referenced resource declaration separately; this scan does not resolve resource dictionaries.');
    if (result.textSearch.truncated) result.textSearch.nextChecks.push('Narrow the queries or candidate files to inspect omitted matches.');
  }
  return result;
}
