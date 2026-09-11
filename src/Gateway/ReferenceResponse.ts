import type { CallToolResult } from '@modelcontextprotocol/server';
import { CodeQueryError, type FindReferencesResult } from '../Core/CodeQueries.js';
import { jsonResult } from './ToolDefinition.js';

/** Budget the formatted MCP text without changing the query evidence used by composite tools. */
export function referenceResponse(result: FindReferencesResult, maxOutputChars = 8000): CallToolResult {
  const data: FindReferencesResult & {
    returnedReferences: number; limits: { maxOutputChars: number }; outputOmissions: string[];
  } = { ...result, returnedReferences: result.references.length, limits: { maxOutputChars }, outputOmissions: [] };
  const fits = () => JSON.stringify(data, null, 2).length <= maxOutputChars;
  if (!fits()) {
    data.truncated = true;
    data.queryComplete = false;
    data.analysisCompleteness = 'incomplete';

    // Keep whole entries and their exact locations; binary search avoids serializing
    // a large result once per omitted reference. Omission metadata shares the budget.
    const trim = (field: string, count: number, keep: (count: number) => void) => {
      if (!count || fits()) return;
      data.outputOmissions.push(field);
      let low = 0, high = count - 1;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        keep(middle);
        if (fits()) low = middle;
        else high = middle - 1;
      }
      keep(low);
    };
    const issues = result.fileIssues ?? [];
    trim('fileIssues', issues.length, count => {
      data.fileIssues = issues.slice(0, count);
      data.fileIssuesOmitted = (result.fileIssuesOmitted ?? 0) + issues.length - count;
    });
    trim('references', result.references.length, count => {
      data.references = result.references.slice(0, count);
      data.returnedReferences = count;
    });
    const candidates = result.candidates ?? [];
    trim('candidates', candidates.length, count => {
      data.candidates = candidates.slice(0, count);
      data.candidatesTruncated = true;
    });
    if (!fits()) throw new CodeQueryError('OUTPUT_BUDGET_EXCEEDED',
      'Reference identity and coverage metadata exceed maxOutputChars; increase the output budget. Required metadata was not clipped.');
  }
  return jsonResult(data, true);
}
