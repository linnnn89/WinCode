import { jsonResult } from './ToolDefinition.js';
import { UI_INSPECT_DEFAULTS } from '../Core/UiContracts.js';
import type { UiReviewResult } from '../CompositeTools/UiReview.js';
import { compactUi } from './UiCompact.js';

/** Preserve snapshot, source-evidence and image budgets at the MCP serialization boundary. */
export function uiResponse(result: UiReviewResult, responseFormat: 'full' | 'compact' = 'full') {
  // Extract image data for MCP image block; omit base64 payload from text JSON
  const imageBase64 = result.annotatedPngBase64 || result.screenshotPngBase64;
  const {
    annotatedPngBase64: _omittedAnnotated,
    screenshotPngBase64: _omittedScreenshot,
    ...body
  } = result;

  const cleanResult = structuredClone(body);

  const textPayload = {
    ...(responseFormat === 'compact' ? compactUi(cleanResult) : cleanResult),
    hasScreenshot: Boolean(imageBase64),
  };
  let text = JSON.stringify(textPayload);
  // Optional C# navigation must not displace the snapshot or existing XAML evidence.
  if (Buffer.byteLength(text, 'utf8') > UI_INSPECT_DEFAULTS.MAX_TEXT_JSON_BYTES && textPayload.codeEvidence) {
    delete textPayload.codeEvidence;
    textPayload.codeEvidenceOmitted = 'Code candidates exceed remaining text budget.';
    text = JSON.stringify(textPayload);
  }
  if (Buffer.byteLength(text, 'utf8') > UI_INSPECT_DEFAULTS.MAX_TEXT_JSON_BYTES && textPayload.codeEvidenceOmitted) {
    delete textPayload.codeEvidenceOmitted;
    text = JSON.stringify(textPayload);
  }
  // Optional keyword hits spend only spare budget; keep existing ID evidence and UI first.
  while (Buffer.byteLength(text, 'utf8') > UI_INSPECT_DEFAULTS.MAX_TEXT_JSON_BYTES &&
    textPayload.sourceEvidence?.textSearch?.matches.length) {
    textPayload.sourceEvidence.textSearch.matches.pop();
    textPayload.sourceEvidence.textSearch.truncated = true;
    text = JSON.stringify(textPayload);
  }
  if (Buffer.byteLength(text, 'utf8') > UI_INSPECT_DEFAULTS.MAX_TEXT_JSON_BYTES && textPayload.sourceEvidence?.textSearch) {
    delete textPayload.sourceEvidence.textSearch;
    textPayload.sourceEvidence.truncated = true;
    text = JSON.stringify(textPayload);
  }
  // Spend only the unused text budget on source candidates. Never trim the UI tree
  // here: the existing screenshot badges must continue to reference its retained nodes.
  while (Buffer.byteLength(text, 'utf8') > UI_INSPECT_DEFAULTS.MAX_TEXT_JSON_BYTES &&
    textPayload.sourceEvidence?.nodes.length) {
    textPayload.sourceEvidence.nodes.pop();
    textPayload.sourceEvidence.truncated = true;
    textPayload.sourceEvidence.coverage.returnedNodes = textPayload.sourceEvidence.nodes.length;
    text = JSON.stringify(textPayload);
  }
  if (Buffer.byteLength(text, 'utf8') > UI_INSPECT_DEFAULTS.MAX_TEXT_JSON_BYTES && textPayload.sourceEvidence) {
    delete textPayload.sourceEvidence;
    textPayload.sourceEvidenceOmitted = 'Source evidence exceeds remaining text budget.';
    text = JSON.stringify(textPayload);
  }
  if (Buffer.byteLength(text, 'utf8') > UI_INSPECT_DEFAULTS.MAX_TEXT_JSON_BYTES && textPayload.sourceEvidenceOmitted) {
    // A baseline snapshot can occupy the entire budget: even the omission notice is optional.
    delete textPayload.sourceEvidenceOmitted;
    text = JSON.stringify(textPayload);
  }
  if (Buffer.byteLength(text, 'utf8') > UI_INSPECT_DEFAULTS.MAX_TEXT_JSON_BYTES) {
    // A malformed/custom helper must not bypass the final MCP budget.
    return jsonResult({ success: false, errorCode: 'PAYLOAD_TOO_LARGE',
      errorMessage: 'UI text response exceeds 128 KiB.', auditNotice: result.auditNotice,
      imageOmitted: true, hasScreenshot: false }, false, true);
  }

  const content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  > = [
    {
      type: 'text',
      text,
    },
  ];

  if (imageBase64) {
    content.push({
      type: 'image',
      data: imageBase64,
      mimeType: 'image/png',
    });
  }

  return {
    content,
    isError: !result.success,
    ...(!result.success ? { structuredContent: JSON.parse(text) } : {}),
  };
}
