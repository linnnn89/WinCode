import { randomUUID } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { UI_INSPECT_DEFAULTS, validateUiQuery, type UiInspectRequest, type UiNode } from '../Core/UiContracts.js';
import type { UiReviewResult } from '../CompositeTools/UiReview.js';

export type UiTarget = { pid: number; hwnd: string };
export type UiReadOptions = Pick<UiInspectRequest, 'query' | 'capture' | 'maxDepth' | 'maxNodes' | 'readStates'>;
export type UiReviewOptions = UiReadOptions & { candidateFiles: string[]; candidateCodeFiles?: string[]; textQueries?: string[] };
export type UiReadCaller = (name: string, args: Record<string, unknown>, options: { signal: AbortSignal; timeoutMs: number }) => Promise<CallToolResult>;
export type UiReader = { inspect(options: UiReadOptions): Promise<UiReviewResult>; review(options: UiReviewOptions): Promise<UiReviewResult> };
export type UiWorkflowOptions = { signal?: AbortSignal; timeoutMs?: number; maxSteps?: number; maxIntermediateBytes?: number; maxOutputBytes?: number };
type Step = { step: number; tool: string; status: 'not_started' | 'running' | 'completed' | 'failed'; elapsedMs: number;
  requestId?: string; capturedAt?: string; imageContentIndex?: number; errorCode?: string; evidence?: Record<string, unknown>; evidenceOmitted?: boolean };

class WorkflowStop extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  const checked = value ?? fallback;
  if (!Number.isInteger(checked) || checked < minimum || checked > maximum) throw new Error(`${name} must be ${minimum}–${maximum}.`);
  return checked;
}

/** Projection keeps node identity, state and read failures; geometry/expansion instructions stay inside this workflow. */
function evidence(value: UiReviewResult): Record<string, unknown> {
  const nodes: Array<Omit<UiNode, 'children' | 'bounds' | 'relativeBounds' | 'className'>> = [];
  const visit = (node: UiNode) => {
    const { children, bounds: _bounds, relativeBounds: _relativeBounds, className: _className, ...kept } = node;
    nodes.push(kept);
    children.forEach(visit);
  };
  if (value.tree) visit(value.tree);
  return { pid: value.pid, hwnd: value.hwnd, queryResult: value.queryResult,
    treeComplete: value.treeComplete, truncated: value.truncated, truncateReason: value.truncateReason,
    totalNodes: value.totalNodes, traversalErrors: value.traversalErrors, propertyIssueCount: value.propertyIssueCount,
    nodes, sourceEvidence: value.sourceEvidence, codeEvidence: value.codeEvidence,
    sourceEvidenceOmitted: value.sourceEvidenceOmitted, codeEvidenceOmitted: value.codeEvidenceOmitted,
    captureMethod: value.captureMethod, captureQuality: value.captureQuality, imageOmitted: value.imageOmitted };
}

/** Caller must be a connected standard MCP client (for example WinCodeSession.call). No interpreter or server bypass. */
export async function runReadonlyUiWorkflow<T>(call: UiReadCaller, target: UiTarget,
  workflow: (reader: UiReader) => Promise<T>, options: UiWorkflowOptions = {}) {
  if (!Number.isInteger(target.pid) || target.pid < 1 || typeof target.hwnd !== 'string' ||
    target.hwnd.length > 32 || !/^(0x[\da-f]+|\d+)$/i.test(target.hwnd) || BigInt(target.hwnd) <= 0n) throw new Error('Supply an explicit positive PID and HWND.');
  const fixed = { ...target };
  const timeoutMs = bounded(options.timeoutMs, 15000, 1, 30000, 'timeoutMs');
  const maxSteps = bounded(options.maxSteps, 16, 1, 16, 'maxSteps');
  const intermediateLimit = bounded(options.maxIntermediateBytes, 512 * 1024, 1, 512 * 1024, 'maxIntermediateBytes');
  const outputLimit = bounded(options.maxOutputBytes, 32 * 1024, 8192, 128 * 1024, 'maxOutputBytes');
  const executionId = randomUUID();
  const started = performance.now();
  const deadline = Date.now() + timeoutMs;
  const own = new AbortController();
  const timer = setTimeout(() => own.abort(new WorkflowStop('DEADLINE_EXCEEDED', 'Readonly workflow deadline exceeded.')), timeoutMs);
  const signal = AbortSignal.any([own.signal, ...(options.signal ? [options.signal] : [])]);
  const steps: Step[] = [];
  const images: Array<Extract<CallToolResult['content'][number], { type: 'image' }>> = [];
  let intermediateBytes = 0;
  let accepting = true;
  let stopped: WorkflowStop | undefined;
  let tail: Promise<unknown> = Promise.resolve();

  const cancellation = () => signal.reason instanceof WorkflowStop ? signal.reason :
    new WorkflowStop('CANCELLED', 'Readonly workflow cancelled; no subsequent calls will be dispatched.');
  const read = (tool: 'wincode_ui_inspect' | 'wincode_ui_review', input: UiReadOptions | UiReviewOptions): Promise<UiReviewResult> => {
    if (!accepting) return Promise.reject(new WorkflowStop('WORKFLOW_CLOSED', 'Workflow has already returned.'));
    const step: Step = { step: steps.length + 1, tool, status: 'not_started', elapsedMs: 0 };
    if (steps.length >= maxSteps) {
      stopped ??= new WorkflowStop('STEP_BUDGET_EXCEEDED', 'Readonly workflow step budget exceeded.');
      return Promise.reject(stopped);
    }
    steps.push(step);
    // Even Promise.all in the client program cannot bypass this FIFO.
    const pending = tail.then(async () => {
      if (signal.aborted) stopped ??= cancellation();
      if (stopped) throw stopped;
      const begin = performance.now();
      try {
        const allowed = ['query', 'capture', 'maxDepth', 'maxNodes', 'readStates',
          ...(tool === 'wincode_ui_review' ? ['candidateFiles', 'candidateCodeFiles', 'textQueries'] : [])];
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key)))
          throw new WorkflowStop('INVALID_ARGUMENT', 'Readonly options contain unsupported fields.');
        validateUiQuery(input.query, input.readStates);
        if (input.capture !== undefined && !['none', 'original', 'annotated'].includes(input.capture))
          throw new WorkflowStop('INVALID_ARGUMENT', 'Unsupported capture mode.');
        if (input.capture && input.capture !== 'none' && images.length)
          throw new WorkflowStop('IMAGE_BUDGET_EXCEEDED', 'A workflow may return at most one native image.');
        const args = { ...input, ...fixed, backgroundOnly: true, responseFormat: 'compact', capture: input.capture ?? 'none' };
        if (Buffer.byteLength(JSON.stringify(args)) > 65536) throw new WorkflowStop('INPUT_BUDGET_EXCEEDED', 'Input exceeds 64 KiB.');
        step.status = 'running';
        let rejectAbort!: () => void;
        const aborted = new Promise<never>((_, reject) => {
          rejectAbort = () => reject(cancellation());
          signal.addEventListener('abort', rejectAbort, { once: true });
        });
        let result: CallToolResult;
        try {
          signal.throwIfAborted();
          result = await Promise.race([call(tool, args, { signal, timeoutMs: Math.max(1, deadline - Date.now()) }), aborted]);
        } finally { signal.removeEventListener('abort', rejectAbort); }
        const texts = result.content.filter(block => block.type === 'text');
        intermediateBytes += texts.reduce((sum, block) => sum + Buffer.byteLength(block.text), 0);
        if (intermediateBytes > intermediateLimit) throw new WorkflowStop('INTERMEDIATE_BUDGET_EXCEEDED', 'Intermediate text exceeds workflow budget.');
        if (texts.length !== 1) throw new WorkflowStop('INVALID_RESPONSE', 'Expected one JSON text block.');
        const value = JSON.parse(texts[0].text) as UiReviewResult;
        if (!value || typeof value !== 'object' || typeof value.success !== 'boolean')
          throw new WorkflowStop('INVALID_RESPONSE', 'Missing business success status.');
        step.requestId = value.requestId;
        step.capturedAt = value.capturedAt;
        // The client program receives the payload too; later edits must not rewrite observation evidence.
        step.evidence = structuredClone(evidence(value));
        if (result.isError || !value.success) throw new WorkflowStop(value.errorCode ?? 'TOOL_ERROR', value.errorMessage ?? 'MCP tool failed.');
        if (value.pid !== fixed.pid || !value.hwnd || BigInt(value.hwnd) !== BigInt(fixed.hwnd))
          throw new WorkflowStop('TARGET_CHANGED', 'Response does not belong to the fixed PID and HWND.');
        if (value.queryResult && value.queryResult.status !== 'unique')
          throw new WorkflowStop('QUERY_' + value.queryResult.status.toUpperCase().replace('-', '_'), 'Query did not identify a complete unique region.');
        const nodeIssues = (node: UiNode): boolean => Boolean(node.propertyIssues?.length) || node.children.some(nodeIssues);
        if (!value.tree || value.treeComplete !== true || value.truncated || value.traversalErrors || value.propertyIssueCount || nodeIssues(value.tree) ||
          value.queryResult?.searchComplete === false || value.sourceEvidenceOmitted || value.codeEvidenceOmitted ||
          (tool === 'wincode_ui_review' && !value.sourceEvidence) ||
          (value.sourceEvidence && (!value.sourceEvidence.fileScanComplete || value.sourceEvidence.truncated)) ||
          (value.codeEvidence && (!value.codeEvidence.fileScanComplete || value.codeEvidence.truncated)))
          throw new WorkflowStop('INCOMPLETE_OBSERVATION', 'Required evidence is incomplete; do not treat missing state as false.');
        const receivedImages = result.content.filter(block => block.type === 'image');
        if (input.capture && input.capture !== 'none' && (!receivedImages.length || value.imageOmitted))
          throw new WorkflowStop('IMAGE_UNAVAILABLE', 'Requested native image was not returned.');
        if (images.length + receivedImages.length > 1 || receivedImages.some(block => Buffer.from(block.data, 'base64').length > UI_INSPECT_DEFAULTS.MAX_IMAGE_BYTES))
          throw new WorkflowStop('IMAGE_BUDGET_EXCEEDED', 'Native image budget exceeded.');
        if (receivedImages.length) step.imageContentIndex = images.length + 1;
        images.push(...receivedImages);
        step.status = 'completed';
        return value;
      } catch (error) {
        stopped ??= signal.aborted ? cancellation() : error instanceof WorkflowStop ? error :
          new WorkflowStop('WORKFLOW_ERROR', error instanceof Error ? error.message : String(error));
        // Preflight failures did not issue a tool request.
        if (step.status === 'running') step.status = 'failed';
        step.errorCode = stopped.code;
        throw stopped;
      } finally { step.elapsedMs = Math.round((performance.now() - begin) * 1000) / 1000; }
    });
    tail = pending.catch(() => {});
    return pending;
  };

  let findings: T | undefined;
  let rejectWorkflowAbort!: () => void;
  const workflowAborted = new Promise<never>((_, reject) => {
    rejectWorkflowAbort = () => reject(cancellation());
    signal.addEventListener('abort', rejectWorkflowAbort, { once: true });
  });
  try {
    if (signal.aborted) throw cancellation();
    findings = await Promise.race([workflow({ inspect: input => read('wincode_ui_inspect', input), review: input => read('wincode_ui_review', input) }), workflowAborted]);
  } catch (error) {
    stopped ??= error instanceof WorkflowStop ? error : new WorkflowStop('WORKFLOW_ERROR', error instanceof Error ? error.message : String(error));
  } finally {
    accepting = false;
    await tail;
    signal.removeEventListener('abort', rejectWorkflowAbort);
    clearTimeout(timer);
    if (signal.aborted) stopped ??= cancellation();
  }
  const report = { version: 1, executionId, target: fixed, status: stopped ? 'stopped' : 'completed', success: !stopped,
    errorCode: stopped?.code, errorMessage: stopped?.message.slice(0, 2048), findings: stopped ? undefined : findings, steps,
    metrics: { elapsedMs: performance.now() - started, dispatchedCalls: steps.filter(step => step.status !== 'not_started').length,
      intermediateTextBytes: intermediateBytes, images: images.length },
    observationSemantics: 'Ordered live observations; request/node IDs belong to their own step, not an atomic multi-step snapshot.' };
  let text: string;
  try { text = JSON.stringify(report); }
  catch { report.success = false; report.status = 'stopped'; report.errorCode = 'INVALID_FINDINGS'; report.findings = undefined; text = JSON.stringify(report); }
  if (Buffer.byteLength(text) > outputLimit) {
    report.success = false; report.status = 'stopped'; report.errorCode = 'OUTPUT_BUDGET_EXCEEDED'; report.findings = undefined;
    report.errorMessage = 'Evidence omitted because final text exceeded its budget; do not infer full completion.';
    steps.forEach(step => { if (step.evidence) { delete step.evidence; step.evidenceOmitted = true; } });
    text = JSON.stringify(report);
  }
  if (Buffer.byteLength(text) > outputLimit) throw new Error('Workflow status metadata exceeds output budget.');
  const content: [{ type: 'text'; text: string }, ...typeof images] = [{ type: 'text', text }, ...images];
  return { report, content, isError: !report.success };
}
