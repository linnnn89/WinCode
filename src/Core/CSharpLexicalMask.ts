/** 屏蔽 C# 注释与字符串/字符字面量；保持偏移和行号，无法可靠定界时返回 null。 */
export function maskCSharpNonCode(source: string, checkpoint: () => void, maxDepth: number): string | null {
  const output = source.split('');
  let steps = 0;
  const tick = () => { if ((++steps & 1023) === 0) checkpoint(); };
  const mask = (start: number, end: number) => {
    for (let index = start; index < end; index++) {
      tick();
      if (output[index] !== '\n' && output[index] !== '\r') output[index] = ' ';
    }
  };
  const commentEnd = (index: number): number | undefined => {
    if (source.startsWith('//', index)) {
      const end = source.indexOf('\n', index + 2); return end < 0 ? source.length : end;
    }
    if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2); return end < 0 ? -1 : end + 2;
    }
    return undefined;
  };
  // The expression is skipped as text, including its own strings and comments, never evaluated.
  const expressionEnd = (start: number, depth: number): number => {
    if (depth > maxDepth) return -1;
    let braces = 1;
    for (let index = start; index < source.length;) {
      tick();
      const comment = commentEnd(index);
      if (comment !== undefined) { if (comment < 0) return -1; index = comment; continue; }
      const literal = literalEnd(index, depth + 1);
      if (literal !== undefined) { if (literal < 0) return -1; index = literal; continue; }
      if (source[index] === '{') { braces++; if (depth + braces - 1 > maxDepth) return -1; }
      if (source[index] === '}' && --braces === 0) return index + 1;
      index++;
    }
    return -1;
  };
  const literalEnd = (start: number, depth: number): number | undefined => {
    let quoteIndex = start;
    let verbatim = false;
    let interpolated = false;
    if (source.startsWith('$@"', start) || source.startsWith('@$"', start)) {
      quoteIndex += 2; verbatim = true; interpolated = true;
    } else if (source.startsWith('$"', start)) { quoteIndex++; interpolated = true; }
    else if (source.startsWith('@"', start)) { quoteIndex++; verbatim = true; }
    else if (source[start] !== '"' && source[start] !== "'") {
      if (source[start] === '$' && /^\$+"{3,}/.test(source.slice(start))) return -1;
      return undefined;
    }
    if (depth > maxDepth) return -1;
    const quote = source[quoteIndex];
    const count = quote === '"' ? /^"+/.exec(source.slice(quoteIndex))![0].length : 1;
    if (count >= 3) {
      if (interpolated || verbatim) return -1;
      const end = source.indexOf('"'.repeat(count), quoteIndex + count);
      return end < 0 ? -1 : end + count;
    }
    for (let index = quoteIndex + 1; index < source.length;) {
      tick();
      if (source[index] === quote) {
        if (verbatim && source[index + 1] === quote) { index += 2; continue; }
        return index + 1;
      }
      if (!verbatim && (source[index] === '\n' || source[index] === '\r')) return -1;
      if (!verbatim && source[index] === '\\') { index += 2; continue; }
      if (interpolated && source[index] === '{') {
        if (source[index + 1] === '{') { index += 2; continue; }
        const end = expressionEnd(index + 1, depth + 1);
        if (end < 0) return -1;
        index = end; continue;
      }
      if (interpolated && source[index] === '}') {
        if (source[index + 1] !== '}') return -1;
        index += 2; continue;
      }
      index++;
    }
    return -1;
  };
  checkpoint();
  for (let index = 0; index < source.length; index++) {
    tick();
    const end = commentEnd(index) ?? literalEnd(index, 0);
    if (end !== undefined) {
      if (end < 0) return null;
      mask(index, end); index = end - 1;
    }
  }
  return output.join('');
}
