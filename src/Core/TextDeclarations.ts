import { maskScriptNonCode } from './ScriptLexicalMask.js';
import { maskCSharpNonCode } from './CSharpLexicalMask.js';
import type { CodeSymbol } from './CodeQueries.js';

export class TextLexicalError extends Error {
  readonly code = 'TEXT_LEXICAL_UNCERTAINTY';
  constructor(message = 'Cannot reliably delimit comments/literals; no declarations returned for this file.') { super(message); }
}

/** 解析已提供的正文，不读取磁盘、不启动进程；正则匹配不提供语义身份或完整引用保证。 */
export function parseTextDeclarations(content: string, relPath: string, ext: string, checkpoint: () => void = () => {}): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  const originalLines = content.split(/\r?\n/);
  const masked = ext === '.cs' ? maskCSharpNonCode(content, checkpoint, 16) : maskScriptNonCode(content, ext === '.py', checkpoint, ext === '.tsx' || ext === '.jsx');
  if (masked === null) throw new TextLexicalError();
  const lines = masked.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    checkpoint();
    const line = lines[i];
    // Collapse masked whitespace once; overlapping optional whitespace patterns must not backtrack over it.
    const trimmed = line.trim().replace(/\s+/g, ' ');
    if (trimmed.length > 16384) throw new TextLexicalError('Declaration line exceeds the 16384 character parsing budget; no declarations returned for this file.');
    const lineNum = i + 1;

    // C# symbol patterns
    if (ext === '.cs') {
      const classMatch = trimmed.match(/\bclass ([A-Za-z0-9_]+)/);
      if (classMatch) {
        symbols.push({ name: classMatch[1], kind: 'class', file: relPath, line: lineNum, signature: originalLines[i].trim() });
        continue;
      }

      const structMatch = trimmed.match(/\bstruct ([A-Za-z0-9_]+)/);
      if (structMatch) {
        symbols.push({ name: structMatch[1], kind: 'struct', file: relPath, line: lineNum, signature: originalLines[i].trim() });
        continue;
      }

      const enumMatch = trimmed.match(/\benum ([A-Za-z0-9_]+)/);
      if (enumMatch) {
        symbols.push({ name: enumMatch[1], kind: 'enum', file: relPath, line: lineNum, signature: originalLines[i].trim() });
        continue;
      }

      const interfaceMatch = trimmed.match(/\binterface ([A-Za-z0-9_]+)/);
      if (interfaceMatch) {
        symbols.push({ name: interfaceMatch[1], kind: 'interface', file: relPath, line: lineNum, signature: originalLines[i].trim() });
        continue;
      }

      const visibility = /\b(?:public|private|protected|internal) /.exec(trimmed);
      const open = visibility ? trimmed.indexOf('(', visibility.index + visibility[0].length) : -1;
      if (visibility && open >= 0) {
        const header = trimmed.slice(visibility.index + visibility[0].length, open).trim();
        const tokens = header.split(' ');
        const name = tokens.pop() ?? '';
        const returnType = tokens.join(' ').replace(/^(?:(?:async|static|virtual|override|sealed) )+/, '');
        if (/^[A-Za-z0-9_]+$/.test(name) && returnType && /^[A-Za-z0-9_<>?, \[\]]+$/.test(returnType) &&
          !['if', 'for', 'while', 'switch', 'using', 'catch'].includes(name)) {
          symbols.push({ name, kind: 'method', file: relPath, line: lineNum, signature: originalLines[i].trim() });
          continue;
        }
      }
    }

    // TypeScript / JavaScript symbol patterns
    if (ext === '.ts' || ext === '.js' || ext === '.tsx' || ext === '.jsx') {
      const classMatch = trimmed.match(/(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_]+)/);
      if (classMatch) {
        symbols.push({ name: classMatch[1], kind: 'class', file: relPath, line: lineNum, signature: originalLines[i].trim() });
        continue;
      }

      const interfaceMatch = trimmed.match(/(?:export\s+)?interface\s+([A-Za-z0-9_]+)/);
      if (interfaceMatch) {
        symbols.push({ name: interfaceMatch[1], kind: 'interface', file: relPath, line: lineNum, signature: originalLines[i].trim() });
        continue;
      }

      const enumMatch = trimmed.match(/(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z0-9_]+)/);
      if (enumMatch) {
        symbols.push({ name: enumMatch[1], kind: 'enum', file: relPath, line: lineNum, signature: originalLines[i].trim() });
        continue;
      }

      const typeMatch = trimmed.match(/(?:export\s+)?type\s+([A-Za-z0-9_]+)\s*=/);
      if (typeMatch) {
        symbols.push({ name: typeMatch[1], kind: 'type', file: relPath, line: lineNum, signature: originalLines[i].trim() });
        continue;
      }

      const funcMatch = trimmed.match(/(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/);
      if (funcMatch) {
        symbols.push({ name: funcMatch[1], kind: 'function', file: relPath, line: lineNum, signature: originalLines[i].trim() });
        continue;
      }

      const arrowFuncMatch = trimmed.match(/^(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::\s*[^=]+)?\s*=>/);
      if (arrowFuncMatch) {
        symbols.push({ name: arrowFuncMatch[1], kind: 'function', file: relPath, line: lineNum, signature: originalLines[i].trim() });
        continue;
      }

      const classMethodMatch = trimmed.match(/^(?:public|private|protected)?\s*(?:static\s+)?(?:async\s+)?([A-Za-z0-9_]+)\s*\([^)]*\)\s*(?::\s*[^;{]+)?\s*\{/);
      if (classMethodMatch && !['if', 'for', 'while', 'switch', 'constructor', 'catch'].includes(classMethodMatch[1])) {
        symbols.push({ name: classMethodMatch[1], kind: 'method', file: relPath, line: lineNum, signature: originalLines[i].trim() });
        continue;
      }
    }

    // Python symbol patterns
    if (ext === '.py') {
      const classMatch = trimmed.match(/^class\s+([A-Za-z0-9_]+)/);
      if (classMatch) {
        symbols.push({ name: classMatch[1], kind: 'class', file: relPath, line: lineNum, signature: originalLines[i].trim() });
        continue;
      }

      const defMatch = trimmed.match(/^(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*\(/);
      if (defMatch) {
        symbols.push({ name: defMatch[1], kind: 'function', file: relPath, line: lineNum, signature: originalLines[i].trim() });
        continue;
      }
    }
  }

  return symbols;
}
