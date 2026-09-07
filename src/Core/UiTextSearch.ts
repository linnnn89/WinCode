/** Optional textual navigation evidence. Never associates a match with a runtime node. */
export interface UiTextSearch {
  method: 'literal-attribute-search';
  identityMatch: false;
  queries: string[];
  totalMatches: number;
  truncated: boolean;
  matches: Array<{
    query: string; file: string; line: number; element: string; attribute: string;
    kind: 'literal' | 'resource-reference' | 'binding-expression';
    snippet: string; fileSha256: string;
  }>;
  nextChecks: string[];
}

export function validateTextQueries(value: unknown): asserts value is string[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 5 || value.some(query =>
    typeof query !== 'string' || !query.trim() || query.length > 80 || /[\x00-\x1f]/.test(query))) {
    throw new Error('textQueries must contain at most 5 non-empty single-line strings, each up to 80 characters.');
  }
}

export function createTextSearch(queries?: string[]): UiTextSearch | undefined {
  validateTextQueries(queries);
  if (!queries?.length) return undefined;
  return { method: 'literal-attribute-search', identityMatch: false,
    queries: [...new Set(queries.map(query => query.trim()))], totalMatches: 0,
    truncated: false, matches: [], nextChecks: [],
  };
}

const TEXT_ATTRIBUTES = new Set(['Content', 'Text', 'Header', 'Title', 'ToolTip', 'AutomationProperties.Name', 'x:Key']);

export function searchTagText(result: UiTextSearch, tag: string,
  location: { file: string; line: number; element: string; fileSha256: string }): void {
  // The caller already skipped comments/CDATA and enforces the shared file/time budget.
  // Consume complete quoted values; pseudo-attributes embedded in a string are not declarations.
  for (const attr of tag.matchAll(/\s([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    if (!TEXT_ATTRIBUTES.has(attr[1])) continue;
    const value = attr[2] ?? attr[3];
    for (const query of result.queries) {
      const offset = value.indexOf(query); // Plain, case-sensitive substring search, never a regex.
      if (offset < 0) continue;
      result.totalMatches++;
      if (result.matches.length >= 40) { result.truncated = true; continue; }
      const kind = /^\{(?:StaticResource|DynamicResource)\s/.test(value) ? 'resource-reference'
        : value.startsWith('{') && !value.startsWith('{}') ? 'binding-expression' : 'literal';
      const attributeOffset = attr.index! + attr[0].indexOf(attr[1]);
      result.matches.push({ ...location,
        line: location.line + (tag.slice(0, attributeOffset).match(/\n/g) || []).length,
        query, attribute: attr[1], kind,
        // Center on the hit so clipping cannot hide the evidence that justified returning it.
        snippet: value.slice(Math.max(0, offset - 60), Math.max(0, offset - 60) + 240),
      });
    }
  }
}
