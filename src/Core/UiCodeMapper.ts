import { maskCSharpNonCode } from './CSharpLexicalMask.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AbortError } from './ResourceManager.js';
import { UiSourceEvidence } from './UiSourceMapper.js';

export interface UiCodeCandidate {
  file: string;
  line: number;
  snippet: string;
  fileSha256: string;
  kind: 'declaration' | 'assignment';
  identifier: string;
  relatedSymbol?: string;
  nextRequest: { task: string; scopeFiles: string[]; symbol?: string; lineRanges?: { file: string; startLine: number; endLine: number }[] };
}

export interface UiCodeEvidence {
  method: 'literal-csharp-candidates';
  runtimeSourceVerified: false;
  runtimeBuildSourceIdentity: 'unknown';
  templateResolution: 'unsupported';
  fileScanComplete: boolean;
  files: { file: string; status: string }[];
  clues: {
    nodeId: number;
    xaml: { file: string; line: number; attribute: string; value: string };
    identifier?: string;
    status: 'candidate' | 'ambiguous' | 'unsupported' | 'not-found-in-candidates';
    reason: string;
    searchComplete: boolean;
    candidateCount: number;
    candidates: UiCodeCandidate[];
  }[];
  evaluatedClues: number;
  omittedClueCount: number;
  truncated: boolean;
  limits: { maxFiles: number; maxFileBytes: number; maxTotalBytes: number; maxClues: number; maxCandidates: number; maxOutputChars: number; maxInterpolationDepth: number };
  limitations: string[];
}

export function validateCandidateCodeFiles(value: unknown): asserts value is string[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length < 1 || value.length > 8 || value.some(file =>
    typeof file !== 'string' || !file.trim() || file.length > 512 || path.isAbsolute(file) ||
    /[:\x00-\x1f]/.test(file) || file.split(/[\\/]/).some(part => part === '..') || !/\.cs$/i.test(file))) {
    throw new Error('candidateCodeFiles must contain 1–8 relative in-workspace .cs paths without parent traversal.');
  }
}

const CSHARP_KEYWORDS = new Set(('abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void volatile while').split(' '));

/** Closed-file textual navigation. It neither evaluates bindings nor establishes runtime causality. */
export async function mapUiCodeCandidates(
  workspaceRoot: string, candidateCodeFiles: string[], sourceEvidence: UiSourceEvidence, signal?: AbortSignal
): Promise<UiCodeEvidence> {
  validateCandidateCodeFiles(candidateCodeFiles);
  const result: UiCodeEvidence = {
    method: 'literal-csharp-candidates', runtimeSourceVerified: false, runtimeBuildSourceIdentity: 'unknown',
    templateResolution: 'unsupported', fileScanComplete: false, files: [], clues: [], evaluatedClues: 0,
    omittedClueCount: 0, truncated: false,
    limits: { maxFiles: 8, maxFileBytes: 256 * 1024, maxTotalBytes: 1024 * 1024, maxClues: 40, maxCandidates: 200, maxOutputChars: 16000, maxInterpolationDepth: 12 },
    limitations: [
      'Only explicit candidateCodeFiles are searched; missing matches do not establish absence.',
      'Bindings, DataContext, templates and runtime/source build identity are not resolved. A disabled state does not prove a CanExecute cause.',
      'C# matches are declaration/assignment text candidates, not semantic references. Constructor arguments do not prove command execution.',
      'Multiline or complex declarations, generated properties and preprocessor conditions are not evaluated.',
      'Interpolated raw strings or interpolation nesting beyond the reported limit make that file unsupported.',
    ],
  };
  const deadline = Date.now() + 2000;
  const checkpoint = () => {
    if (signal?.aborted) throw new AbortError();
    if (Date.now() >= deadline) throw new Error('Code candidate lookup deadline exceeded.');
  };
  checkpoint();
  const ambiguousXaml = new Set<number>();
  for (const node of sourceEvidence.nodes) {
    if (node.candidateCount > 1 || node.status === 'ambiguous') ambiguousXaml.add(node.nodeId);
    for (const xaml of node.candidates) for (const [attribute, value] of Object.entries(xaml.declarations)) {
      if (!['Click', 'Command', 'CommandParameter', 'IsEnabled', 'Text'].includes(attribute)) continue;
      if (attribute !== 'Click' && attribute !== 'Command' && !value.startsWith('{')) continue;
      result.evaluatedClues++;
      if (result.clues.length >= result.limits.maxClues) { result.truncated = true; continue; }
      const identifier = attribute === 'Click' ? /^[A-Za-z_][A-Za-z0-9_]*$/.exec(value)?.[0]
        : /^\{Binding\s+(?:Path\s*=\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\}$/.exec(value)?.[1];
      result.clues.push({ nodeId: node.nodeId, xaml: { file: xaml.file, line: xaml.line, attribute, value },
        identifier: identifier && identifier.length <= 128 && value.length < 256 ? identifier : undefined,
        status: identifier && identifier.length <= 128 && value.length < 256 ? 'not-found-in-candidates' : 'unsupported',
        reason: 'unsupported-or-complex-xaml-value', searchComplete: false, candidateCount: 0, candidates: [],
      });
    }
  }
  const identifiers = new Set(result.clues.flatMap(clue => clue.identifier ? [clue.identifier] : []));
  const matches = new Map<string, UiCodeCandidate[]>();
  let matchedCandidates = 0;
  const root = await fs.realpath(workspaceRoot);
  let remainingBytes = result.limits.maxTotalBytes;
  const seen = new Set<string>();
  // Unsupported bindings need no source I/O; report that these files were not searched.
  for (const file of candidateCodeFiles) {
    checkpoint();
    if (!identifiers.size) { result.files.push({ file, status: 'not-scanned-no-supported-clues' }); continue; }
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      const real = await fs.realpath(path.resolve(root, file));
      const relative = path.relative(root, real);
      if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
        result.files.push({ file, status: 'outside-workspace' }); continue;
      }
      if (!/\.cs$/i.test(real)) { result.files.push({ file, status: 'not-csharp' }); continue; }
      const identity = process.platform === 'win32' ? real.toLowerCase() : real;
      if (seen.has(identity)) continue;
      seen.add(identity);
      handle = await fs.open(real, 'r');
      const before = await handle.stat();
      if (!before.isFile() || before.size > result.limits.maxFileBytes || before.size + 1 > remainingBytes) {
        result.files.push({ file, status: 'file-budget-or-not-regular' }); result.truncated = true; continue;
      }
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
      const code = maskCSharpNonCode(source, checkpoint, result.limits.maxInterpolationDepth);
      if (code === null) { result.files.push({ file, status: 'unsupported-or-unclosed-literal' }); continue; }
      const fileSha256 = createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex');
      const relativeFile = relative.replace(/\\/g, '/');
      const lines = code.split(/\r?\n/);
      const rawLines = source.split(/\r?\n/);
      let partial = false;
      for (let index = 0; index < lines.length; index++) {
        checkpoint();
        if (index >= 10000 || matchedCandidates >= result.limits.maxCandidates) { partial = true; break; }
        const line = lines[index];
        if (line.length > 2000) { partial = true; continue; }
        for (const token of line.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
          const identifier = token[0];
          if (!identifiers.has(identifier)) continue;
          const left = line.slice(0, token.index).split(/[;{}]/).pop()!.trim();
          const right = line.slice(token.index! + identifier.length);
          const declaration = /^[\s]*(?:\(|\{|=>|[=;])/.test(right) &&
            /^(?:(?:public|private|protected|internal|static|readonly|virtual|override|sealed|async|partial|new|required)\s+)*[A-Za-z_][A-Za-z0-9_.<>?,\[\]]*\s*$/.test(left) &&
            !/^(?:return|await|throw|yield|case|using|namespace|class|struct|interface|enum)$/.test(left);
          const assignment = /^\s*=(?!=|>)/.test(right);
          if (!declaration && !assignment) continue;
          const argument = assignment ? /^\s*=\s*new\s+(?:[A-Za-z_][A-Za-z0-9_]*\.)*[A-Za-z_][A-Za-z0-9_]*(?:<[^;(){}]*>)?\s*\(\s*(?:this\.)?([A-Za-z_][A-Za-z0-9_]*)\s*(?=[,)])/.exec(right)?.[1] : undefined;
          const relatedSymbol = argument && argument.length <= 128 && !CSHARP_KEYWORDS.has(argument) ? argument : undefined;
          const candidate: UiCodeCandidate = {
            file: relativeFile, line: index + 1, snippet: rawLines[index].slice(Math.max(0, token.index! - 80), token.index! + 320),
            fileSha256, kind: declaration ? 'declaration' : 'assignment', identifier, relatedSymbol,
            nextRequest: { task: 'Inspect this source candidate; runtime binding identity is unverified.', scopeFiles: [relativeFile],
              // A constructor argument can be a local delegate or shadowed name. Inspect the assignment first.
              lineRanges: [{ file: relativeFile, startLine: index + 1, endLine: index + 1 }],
            },
          };
          const list = matches.get(identifier) || []; list.push(candidate); matches.set(identifier, list);
          matchedCandidates++;
          if (matchedCandidates >= result.limits.maxCandidates) { partial = true; break; }
        }
      }
      if (partial) result.truncated = true;
      result.files.push({ file: relativeFile, status: partial ? 'partial-literal-scan' : 'scanned-literals' });
    } catch (error) {
      checkpoint();
      result.files.push({ file, status: 'unreadable' });
    } finally { await handle?.close(); }
  }
  checkpoint();
  result.fileScanComplete = result.files.length > 0 && result.files.every(file => file.status === 'scanned-literals');
  for (const clue of result.clues) {
    if (!clue.identifier) continue;
    const candidates = matches.get(clue.identifier) || [];
    const ambiguous = ambiguousXaml.has(clue.nodeId) || candidates.filter(item => item.kind === 'declaration').length > 1 ||
      new Set(candidates.map(item => item.file)).size > 1 || candidates.filter(item => item.kind === 'assignment').length > 1;
    clue.candidateCount = candidates.length;
    clue.candidates = candidates.slice(0, 5);
    clue.searchComplete = result.fileScanComplete && sourceEvidence.fileScanComplete && !sourceEvidence.truncated;
    clue.status = ambiguous ? 'ambiguous' : candidates.length ? 'candidate' : 'not-found-in-candidates';
    clue.reason = ambiguous ? 'multiple-source-candidates' : candidates.length ? 'literal-identifier-candidate' :
      clue.searchComplete ? 'no-match-in-explicit-candidates' : 'incomplete-candidate-scan';
    if (candidates.length > 5) result.truncated = true;
  }
  result.omittedClueCount = result.evaluatedClues - result.clues.length;
  while (JSON.stringify(result).length > result.limits.maxOutputChars) {
    checkpoint();
    result.truncated = true;
    const populated = [...result.clues].reverse().find(clue => clue.candidates.length > 0);
    if (populated) { populated.candidates.pop(); continue; }
    if (result.clues.length) { result.clues.pop(); result.omittedClueCount++; continue; }
    throw new Error('Code candidate metadata exceeds its output budget.');
  }
  checkpoint();
  return result;
}
