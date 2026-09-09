import { rangeCoverage } from './ContextRangeCoverage.js';
import { clipContextText, PreparedContextResult } from '../Core/Context.js';

/** One serialization boundary: JSON escaping, metadata and legacy text all share the budget. */
export function contextResponse(context: PreparedContextResult, responseFormat: 'compact' | 'legacy' = 'compact') {
  const data = structuredClone(context);
  const omitted = new Set(data.omittedFiles);
  const selectedFiles = data.relatedFiles.map(item => item.path);
  const requestedRanges = structuredClone(context.requestedLineRanges || []);
  const originalEvidence = structuredClone(context.evidence);
  const originalIssues = structuredClone(context.fileIssues);
  const maxCharacters = data.metrics.budgetTokens * 4;
  let metadataTruncated = false;
  let limitationsOmitted = false;
  let omittedListLimit = 20;
  let coverageDetailLimit = requestedRanges.length;
  data.metrics.measurementScope = 'mcp-text-blocks';
  if (data.task.length > 256) { data.task = clipContextText(data.task, 256); metadataTruncated = true; data.truncated = true; }

  function render(): { type: 'text'; text: string }[] {
    // A symbol window has no parsed end boundary. Continue from the final serialized
    // tail, including a partial last line, without calling the whole method complete.
    const evidence = data.evidence.map(item => {
      if (item.locationKind !== 'symbol') return item;
      const startLine = item.endLine + (item.endLineComplete === true ? 1 : 0);
      const endLine = Math.min(startLine + 79, item.fileLineCount ?? 0);
      const needsMoreBudget = item.endLineComplete !== true;
      const maxTokens = needsMoreBudget ? Math.min(65536, data.metrics.budgetTokens * 2) : data.metrics.budgetTokens;
      const blocked = needsMoreBudget && maxTokens <= data.metrics.budgetTokens && startLine <= item.startLine;
      return { ...item, symbolCoverage: 'unknown',
        ...(blocked ? { nextAction: 'Use a file reader for the remaining long line; maximum response budget reached.' } :
          endLine >= startLine ? { nextRequest: {
            task: 'Read following source lines; the symbol end boundary remains unknown.',
            lineRanges: [{ file: item.file, startLine, endLine }], maxTokens,
          } } : {}),
      };
    });
    const bodyStatus = (file: string): 'complete' | 'partial' | 'omitted' | 'unknown' => {
      if (!data.metrics.includeFullText) {
        const item = data.evidence.find(item => item.file === file);
        return !item ? 'omitted' : item.truncated ? 'partial' : 'complete';
      }
      if (!data.packedContent || data.metrics.packedFiles === 0) return 'omitted';
      if (!data.packedFileSpans) return 'unknown';
      const span = data.packedFileSpans.find(item => item.file === file);
      if (!span || span.start >= data.packedContent.length) return 'omitted';
      return span.end <= data.packedContent.length ? 'complete' : 'partial';
    };
    const returned = selectedFiles.filter(file => ['complete', 'partial'].includes(bodyStatus(file)));
    for (const file of selectedFiles) if (bodyStatus(file) === 'omitted') omitted.add(file);
    if (!data.metrics.includeFullText) data.metrics.packedFiles = data.evidence.length;
    data.metrics.selectedFiles = selectedFiles.length;
    data.metrics.returnedFiles = data.metrics.includeFullText && data.metrics.packedFiles > 0 && !data.packedFileSpans && data.packedContent ? null : returned.length;
    data.evidenceInsufficient = data.metrics.returnedFiles === 0 || (data.metrics.includeFullText && !data.packedContent);
    data.omittedFiles = [...omitted].slice(0, omittedListLimit);
    if (omitted.size > omittedListLimit) metadataTruncated = true;
    const { formattedContent, executiveSummary, packedContent, packedFileSpans, requestedLineRanges, ...base } = data;
    const common = { ...base,
      evidence,
      bodyStatusScope: data.metrics.includeFullText ? 'packed-file' : 'displayed-snippet',
      relatedFiles: data.relatedFiles.map(item => ({...item, included: returned.includes(item.path), bodyStatus: bodyStatus(item.path)})),
      responseFormat, metadataTruncated, limitationsOmitted, omittedFileCount: omitted.size,
      coverage: rangeCoverage(data, originalEvidence, originalIssues, requestedRanges, coverageDetailLimit), taskCoverage: null };
    if (responseFormat === 'compact') {
      return [{ type: 'text', text: JSON.stringify({ ...common,
        // A packed body has its own file delimiters. Snippet ranges must not describe that body.
        evidence: data.metrics.includeFullText ? data.evidence.map(({ file, reason, line, symbol }) => ({ file, reason, line, symbol, bodyStatus: bodyStatus(file) })) : evidence,
        ...(data.metrics.includeFullText ? { packedContent: packedContent || '' } : {}),
      }) }];
    }
    const summary = `# AI Agent Context Snapshot\nTask: ${data.task}`;
    const markdown = [summary, ...data.guidance,
      ...data.evidence.map(item => `### ${item.file}:${item.startLine}-${item.endLine}\nReason: ${item.reason}\n\n\`\`\`\n${item.snippet}\n\`\`\``),
      ...(packedContent ? ['## Packed snapshot', packedContent] : []),
      ...data.limitations,
      ...(data.truncated ? ['Output is partial; inspect truncation and omission metadata.'] : []),
    ].join('\n\n');
    return [{ type: 'text', text: JSON.stringify({ ...common, executiveSummary: summary }) }, { type: 'text', text: markdown }];
  }

  function measured() {
    // Metrics include their own serialized digits. The bounded integer lengths converge quickly.
    for (let pass = 0; pass < 8; pass++) {
      const content = render();
      const length = content.reduce((total, item) => total + item.text.length, 0);
      const estimate = Math.ceil(length / 4);
      if (data.metrics.totalCharacters === length && data.metrics.estimatedTokens === estimate) return content;
      data.metrics.totalCharacters = length;
      data.metrics.estimatedTokens = estimate;
    }
    throw new Error('Could not stabilize context response metrics.');
  }

  // Each iteration shortens a string or removes an item; input lists and strings are bounded upstream.
  for (let pass = 0; pass < 256; pass++) {
    const content = measured();
    const excess = data.metrics.totalCharacters - maxCharacters;
    if (excess <= 0) return { content };
    data.truncated = true;
    // Preserve source before optional lists/prose. Counts and loss flags survive list shortening.
    if (data.relatedFiles.length > 1) { metadataTruncated = true; data.relatedFiles.pop(); continue; }
    if (data.fileIssues.length > 1) { metadataTruncated = true; data.fileIssues.pop(); continue; }
    if (data.guidance.length) { metadataTruncated = true; data.guidance.pop(); continue; }
    if (omittedListLimit > 1 && omitted.size > 1) { metadataTruncated = true; omittedListLimit--; continue; }
    if (data.task.length > 64) { metadataTruncated = true; data.task = clipContextText(data.task, 64); continue; }
    // Keep one actionable gap when it is small; long path metadata must not crowd out source.
    if (coverageDetailLimit > 1 || (coverageDetailLimit === 1 &&
      JSON.stringify(rangeCoverage(data, originalEvidence, originalIssues, requestedRanges, coverageDetailLimit)?.details[0]).length > maxCharacters / 4)) {
      metadataTruncated = true; coverageDetailLimit--; continue;
    }
    if (data.packedContent) {
      data.packedContent = clipContextText(data.packedContent, Math.max(0, data.packedContent.length - Math.max(128, excess)));
      continue;
    }
    const last = data.evidence[data.evidence.length - 1];
    if (last) {
      if (last.snippet.length > 64 && !(responseFormat === 'compact' && data.metrics.includeFullText)) {
        if (last.line && last.line > last.startLine && last.line <= last.endLine) {
          last.snippet = last.snippet.split('\n').slice(last.line - last.startLine).join('\n');
          last.startLine = last.line;
        }
        const previousSnippet = last.snippet;
        last.snippet = clipContextText(previousSnippet, Math.max(64, previousSnippet.length - Math.max(128, Math.ceil(excess / (responseFormat === 'legacy' ? 2 : 1)))));
        if (last.snippet.length < previousSnippet.length) last.endLineComplete = previousSnippet[last.snippet.length] === '\n';
        last.endLine = last.startLine + last.snippet.split('\n').length - 1;
        last.truncated = true;
      } else {
        if (coverageDetailLimit > 0) { metadataTruncated = true; coverageDetailLimit--; continue; }
        omitted.add(last.file);
        data.evidence.pop();
      }
      continue;
    }
    metadataTruncated = true;
    if (data.relatedFiles.length) { data.relatedFiles.pop(); continue; }
    if (data.fileIssues.length) { data.fileIssues.pop(); continue; }
    if (coverageDetailLimit > 0) { coverageDetailLimit--; continue; }
    if (data.guidance.length) { data.guidance.pop(); continue; }
    if (omittedListLimit > 1 && omitted.size > 1) { omittedListLimit--; continue; }
    if (data.limitations.length) {
      const index = data.limitations.length - 1;
      limitationsOmitted = true;
      if (data.limitations[index].length > 80) data.limitations[index] = clipContextText(data.limitations[index], 80);
      else data.limitations.pop();
      continue;
    }
    if (data.task.length > 32) { data.task = clipContextText(data.task, 32); continue; }
    if (omittedListLimit) { omittedListLimit = 0; continue; }
    throw new Error('Context metadata exceeds maxTokens; narrow candidateFiles or increase maxTokens.');
  }
  throw new Error('Context response exceeded its bounded serialization work. Narrow candidateFiles.');
}
