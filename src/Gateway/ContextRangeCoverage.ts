import type { PreparedContextResult } from '../Core/Context.js';

/** 根据最终展示正文计算缺口及续读建议；纯函数，不读取或修改源码。 */
  type LineRange = { startLine: number; endLine: number };
  const groupLines = (lines: number[]): LineRange[] => {
    const ranges: LineRange[] = [];
    for (const line of [...new Set(lines)].sort((a, b) => a - b)) {
      const last = ranges[ranges.length - 1];
      if (last && line === last.endLine + 1) last.endLine = line;
      else ranges.push({ startLine: line, endLine: line });
    }
    return ranges;
  };

export function rangeCoverage(data: PreparedContextResult, originalEvidence: PreparedContextResult['evidence'],
  originalIssues: PreparedContextResult['fileIssues'], requestedRanges: NonNullable<PreparedContextResult['requestedLineRanges']>,
  coverageDetailLimit: number) {
    if (!requestedRanges.length) return null;
    let completeItems = 0;
    let partialItems = 0;
    let missingItems = 0;
    let requestedLines = 0;
    let completeLines = 0;
    const details = requestedRanges.map(requested => {
      const evidenceFor = (items: typeof data.evidence) => items.filter(item => item.file === requested.file && item.locationKind === 'line-range');
      const completeFor = (items: typeof data.evidence) => {
        const lines = new Set<number>();
        for (const item of evidenceFor(items)) {
          // Unknown tail completeness is conservative for older/internal result producers.
          const lastComplete = item.endLine - (item.endLineComplete === true ? 0 : 1);
          for (let line = Math.max(item.startLine, requested.startLine); line <= Math.min(lastComplete, requested.endLine); line++) lines.add(line);
        }
        return lines;
      };
      const originalComplete = completeFor(originalEvidence);
      const finalComplete = completeFor(data.evidence);
      const returned = evidenceFor(data.evidence).filter(item => item.endLine >= requested.startLine && item.startLine <= requested.endLine).map(item => ({
        startLine: Math.max(item.startLine, requested.startLine),
        endLine: Math.min(item.endLine, requested.endLine),
        endLineComplete: item.endLine > requested.endLine || item.endLineComplete === true,
      }));
      const fileIssue = originalIssues.find(item => item.path === requested.file);
      const issue = fileIssue?.reason;
      const missingRanges: Array<LineRange & { reason: string }> = [];
      for (let line = requested.startLine; line <= requested.endLine; line++) {
        if (finalComplete.has(line)) continue;
        const reason = issue || (originalComplete.has(line) ? 'response-budget' : 'source-budget');
        const previous = missingRanges[missingRanges.length - 1];
        if (previous && previous.endLine + 1 === line && previous.reason === reason) previous.endLine = line;
        else missingRanges.push({ startLine: line, endLine: line, reason });
      }
      const status = !missingRanges.length ? 'complete' : returned.length ? 'partial' : 'missing';
      if (status === 'complete') completeItems++;
      else if (status === 'partial') partialItems++;
      else missingItems++;
      requestedLines += requested.endLine - requested.startLine + 1;
      completeLines += finalComplete.size;
      const retry = missingRanges.find(range => ['response-budget', 'source-budget'].includes(range.reason));
      const retryNeedsMoreBudget = Boolean(retry && (finalComplete.size === 0 ||
        returned.some(range => !range.endLineComplete && retry.startLine === range.endLine)));
      const retryBudget = retryNeedsMoreBudget ? Math.min(65536, data.metrics.budgetTokens * 2) : data.metrics.budgetTokens;
      const retryAdvances = retry && (retry.startLine > requested.startLine || retry.endLine < requested.endLine);
      const retryBlocked = retry && retryNeedsMoreBudget && retryBudget <= data.metrics.budgetTokens && !retryAdvances;
      // Keep the original gap intact; suggest only its intersection with the observed file.
      const correctedEnd = issue === 'line-range-out-of-bounds' ? fileIssue?.fileLineCount : undefined;
      const correction = correctedEnd !== undefined && requested.startLine <= correctedEnd ? {
        task: 'Read the valid portion of the requested range; the original request exceeded EOF.',
        lineRanges: [{ file: requested.file, startLine: requested.startLine, endLine: Math.min(requested.endLine, correctedEnd) }],
        maxTokens: data.metrics.budgetTokens,
      } : undefined;
      return {
        file: requested.file,
        ...(fileIssue?.fileLineCount !== undefined ? { fileLineCount: fileIssue.fileLineCount } : {}),
        requested: { startLine: requested.startLine, endLine: requested.endLine },
        returned, completeRanges: groupLines([...finalComplete]), missingRanges, status,
        ...(retryBlocked ? { retryBlockedReason: 'maximum-budget-without-progress',
          nextAction: 'The requested source cannot fit completely at maxTokens=65536. Use a file reader for the remaining long line instead of repeating this request.' } :
          retry ? { nextRequest: {
          task: 'Read the missing source lines.',
          lineRanges: [{ file: requested.file, startLine: retry.startLine, endLine: retry.endLine }],
          maxTokens: retryBudget,
        } } : correction ? { nextRequest: correction } : {}),
      };
    });
    return {
      requestedItems: requestedRanges.length, completeItems, partialItems, missingItems,
      requestedLines, completeLines, allRequestedCovered: completeItems === requestedRanges.length,
      omittedItemCount: Math.max(0, details.length - coverageDetailLimit), details: details.slice(0, coverageDetailLimit),
    };
  }
