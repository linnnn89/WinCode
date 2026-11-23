// C# 6.4.3 distinguishes identifier spelling from its comparison value.
// Consume the whole word before decoding so a mixed or escaped suffix cannot produce an ASCII prefix.
const word = /@?(?:[\p{L}\p{Nl}\p{Nd}\p{Pc}\p{Mn}\p{Mc}\p{Cf}]|\\u[\da-fA-F]{0,4}|\\U[\da-fA-F]{0,8})+/gu;
const validName = /^[\p{L}\p{Nl}_][\p{L}\p{Nl}\p{Nd}\p{Pc}\p{Mn}\p{Mc}\p{Cf}]*$/u;
const typeKeyword = /^(?:class|struct|enum|interface)$/;
const reserved = new Set(('abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void volatile while').split(' '));

export function csharpIdentifierValue(spelling: string): string | undefined {
  const bare = spelling.startsWith('@') ? spelling.slice(1) : spelling;
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(bare)) return bare;
  const decoded = bare.replace(/\\u([\da-fA-F]{4})|\\U([\da-fA-F]{8})/g, (_, short, long) => {
    const value = Number.parseInt(short ?? long, 16);
    return value <= 0x10ffff ? String.fromCodePoint(value) : '\uFFFD';
  });
  return validName.test(decoded) ? decoded.replace(/\p{Cf}/gu, '') : undefined;
}

export function isCSharpKeyword(spelling: string): boolean { return reserved.has(spelling); }

type TypeKind = 'class' | 'struct' | 'enum' | 'interface';
const declaration = new RegExp(String.raw`(?<![@\p{L}\p{Nl}\p{Nd}\p{Pc}\p{Mn}\p{Mc}\p{Cf}])(class|struct|enum|interface) (${word.source})`, 'u');

export function csharpTypeDeclaration(line: string) {
  const match = declaration.exec(line);
  return match && { kind: match[1] as TypeKind, name: csharpIdentifierValue(match[2]) };
}

/** References stay textual and line-based. A type declaration may have a separate use on the same line. */
export function hasCSharpReference(line: string, name: string): boolean {
  if (!line.includes(name) && !line.includes('\\') && !/\p{Cf}/u.test(line)) return false;
  let typeKeywordEnd = -1;
  for (const token of line.matchAll(word)) {
    const spelling = token[0];
    const isDeclaration = typeKeywordEnd >= 0 && /^\s+$/.test(line.slice(typeKeywordEnd, token.index));
    if (!isDeclaration && !reserved.has(spelling) && csharpIdentifierValue(spelling) === name) return true;
    typeKeywordEnd = typeKeyword.test(spelling) ? token.index! + spelling.length : -1;
  }
  return false;
}
