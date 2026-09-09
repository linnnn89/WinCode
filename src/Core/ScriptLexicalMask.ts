/** 屏蔽 JS/TS 与 Python 非代码区；保留 UTF-16 偏移和换行，不提供语法/语义完整性。 */
export function maskScriptNonCode(source: string, python: boolean, checkpoint: () => void, jsx = false): string | null {
  const output = source.split('');
  let steps = 0;
  const tick = () => { if ((++steps & 1023) === 0) checkpoint(); };
  const commentEnd = (start: number): number | undefined => {
    if (python ? source[start] === '#' : source.startsWith('//', start)) {
      const end = source.indexOf('\n', start); return end < 0 ? source.length : end;
    }
    if (!python && source.startsWith('/*', start)) {
      const end = source.indexOf('*/', start + 2); return end < 0 ? -1 : end + 2;
    }
    return undefined;
  };
  const regexEnd = (start: number): number => {
    let inClass = false;
    for (let i = start + 1; i < source.length; i++) {
      tick();
      if (source[i] === '\\') { i++; continue; }
      if (source[i] === '\n' || source[i] === '\r') return -1;
      if (source[i] === '[') inClass = true;
      if (source[i] === ']') inClass = false;
      if (source[i] === '/' && !inClass) return i + 1;
    }
    return -1;
  };
  // 插值表达式整体省略，包括其中的字符串；不把嵌套正文误当成外部声明。
  const expressionEnd = (start: number, depth: number): number => {
    if (depth > 16) return -1;
    let braces = 1;
    let operand = true;
    for (let i = start; i < source.length;) {
      tick();
      const end = commentEnd(i) ?? literalEnd(i, depth + 1) ??
        (!python && source[i] === '/' && operand ? regexEnd(i) : undefined);
      if (end !== undefined) { if (end < 0) return -1; i = end; operand = false; continue; }
      const ch = source[i];
      if (ch === '{' && ++braces + depth > 16) return -1;
      if (ch === '}' && --braces === 0) return i + 1;
      if (!/\s/.test(ch)) operand = /[({[}=,:;!?&|+*%~<>-]/.test(ch);
      i++;
    }
    return -1;
  };
  const literalEnd = (start: number, depth: number): number | undefined => {
    const quote = source[start];
    if (quote !== '"' && quote !== "'" && (python || quote !== '`')) return undefined;
    if (depth > 16) return -1;
    const triple = python && source.startsWith(quote.repeat(3), start);
    const delimiter = quote.repeat(triple ? 3 : 1);
    const formatted = python && /(?:^|[^\w])(?:f|fr|rf)$/i.test(source.slice(Math.max(0, start - 3), start));
    for (let i = start + delimiter.length; i < source.length;) {
      tick();
      if (source[i] === '\\') { i += 2; continue; }
      if (source.startsWith(delimiter, i)) return i + delimiter.length;
      if (!triple && quote !== '`' && (source[i] === '\n' || source[i] === '\r')) return -1;
      if ((!python && quote === '`' && source.startsWith('${', i)) || (formatted && source[i] === '{')) {
        if (formatted && source[i + 1] === '{') { i += 2; continue; }
        const end = expressionEnd(i + (python ? 1 : 2), depth + 1);
        if (end < 0) return -1;
        i = end; continue;
      }
      i++;
    }
    return -1;
  };
  // JSX 整个元素是文本扫描的非声明区；包含其中的表达式，避免把展示内容当代码。
  const jsxEnd = (start: number, depth: number): number => {
    const tags: string[] = [];
    for (let i = start; i < source.length;) {
      tick();
      if (depth + tags.length > 16) return -1;
      if (source[i] === '{') {
        const end = expressionEnd(i + 1, depth + tags.length + 1);
        if (end < 0) return -1;
        i = end; continue;
      }
      if (source[i] !== '<') { i++; continue; }
      const closing = source[i + 1] === '/';
      i += closing ? 2 : 1;
      const nameStart = i;
      while (i < source.length && /[\w$:.\-]/.test(source[i])) { tick(); i++; }
      const name = source.slice(nameStart, i);
      if (!name && source[i] !== '>') return -1;
      let last = '';
      for (; i < source.length && source[i] !== '>';) {
        tick();
        const ch = source[i];
        if (ch === '"' || ch === "'") {
          const end = source.indexOf(ch, i + 1);
          if (end < 0) return -1;
          i = end + 1; last = ch; continue;
        }
        if (ch === '{') {
          const end = expressionEnd(i + 1, depth + tags.length + 1);
          if (end < 0) return -1;
          i = end; last = '}'; continue;
        }
        if (!/\s/.test(ch)) last = ch;
        i++;
      }
      if (i >= source.length) return -1;
      i++;
      if (closing) { if (last || tags.pop() !== name) return -1; }
      else if (last !== '/') tags.push(name);
      if (!tags.length) return i;
    }
    return -1;
  };
  let operand = true;
  let control = false;
  const parentheses: boolean[] = [];
  checkpoint();
  for (let i = 0; i < source.length;) {
    tick();
    const comment = commentEnd(i);
    const end = comment ?? literalEnd(i, 0) ??
      (jsx && operand && source[i] === '<' && /[a-zA-Z_$>]/.test(source[i + 1] ?? '') ? jsxEnd(i, 0) : undefined) ?? (!python && source[i] === '/' && operand ? regexEnd(i) : undefined);
    if (end !== undefined) {
      if (end < 0) return null;
      for (let j = i; j < end; j++) { tick(); if (source[j] !== '\n' && source[j] !== '\r') output[j] = ' '; }
      i = end;
      if (comment === undefined) operand = false;
      continue;
    }
    if (/[a-zA-Z_$]/.test(source[i])) {
      const start = i++;
      while (i < source.length && /[\w$]/.test(source[i])) { tick(); i++; }
      control = /^(if|while|for|with|switch|catch)$/.test(source.slice(start, i));
      operand = /^(return|throw|case|delete|void|typeof|new|in|of|instanceof|yield|await|else|do)$/.test(source.slice(start, i));
      continue;
    }
    if (source[i] === '(') {
      if (parentheses.length >= 128) return null;
      parentheses.push(control); control = false; operand = true;
    } else if (source[i] === ')') operand = parentheses.pop() ?? false;
    else if (!/\s/.test(source[i])) { control = false; operand = /[({[}=,:;!?&|+*%~<>-]/.test(source[i]); }
    i++;
  }
  checkpoint();
  return output.join('');
}
