/**
 * Bounded Windows UI inspection contracts. Optional query/state fields require inspectionVersion 2.
 */

export interface UiRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface UiNode {
  id: number;
  parentId: number | null;
  automationId?: string;
  name?: string;
  controlType?: string;
  className?: string;
  bounds?: UiRect;
  relativeBounds?: UiRect;
  isEnabled?: boolean;
  isOffscreen?: boolean;
  propertyIssues?: string[];
  states?: { toggle: string; selection: string; expandCollapse: string };
  children: UiNode[];
}

export interface UiCandidateWindow {
  hwnd: string;
  title: string;
  className: string;
  bounds: UiRect;
  isIconic: boolean;
  titleTruncated?: boolean;
}

export type UiCaptureMode = 'none' | 'original' | 'annotated';

export interface UiQuery {
  automationId?: string; name?: string; controlType?: string;
  maxSearchNodes?: number; maxMatches?: number;
}

/** Shared MCP/adapter boundary; rejected scopes must never launch the native helper. */
export function validateUiQuery(query: unknown, readStates: unknown): void {
  if (readStates !== undefined && typeof readStates !== "boolean") throw new Error("readStates must be boolean.");
  if (query === undefined) return;
  if (!query || typeof query !== "object" || Array.isArray(query)) throw new Error("query must be an object.");
  const q = query as Record<string, unknown>;
  if (Object.keys(q).some(k => !["automationId", "name", "controlType", "maxSearchNodes", "maxMatches"].includes(k)) ||
      ![q.automationId, q.name, q.controlType].some(v => v !== undefined)) throw new Error("query requires an exact-match condition and no unknown fields.");
  for (const key of ["automationId", "name", "controlType"]) {
    const v = q[key];
    if (v !== undefined && (typeof v !== "string" || !v.trim() || v.length > 256 || /[\x00-\x1f]/.test(v))) throw new Error("Invalid query condition.");
  }
  for (const [key, limit] of [["maxSearchNodes", 5000], ["maxMatches", 20]] as const) {
    const v = q[key];
    if (v !== undefined && (!Number.isInteger(v) || (v as number) < 1 || (v as number) > limit)) throw new Error(`Invalid ${key}.`);
  }
}

export interface UiInspectRequest {
  query?: UiQuery;
  readStates?: boolean;
  schemaVersion?: string;
  requestId?: string;
  action?: 'inspect' | 'health' | 'ping' | 'listWindows';
  processName?: string;
  titleContains?: string;
  maxWindows?: number;
  pid?: number;
  hwnd?: string;
  capture?: UiCaptureMode;
  backgroundOnly?: boolean;
  maxDepth?: number;
  maxNodes?: number;
  timeoutMs?: number;
}

export type UiTruncateReason = 'maxDepth' | 'maxNodes' | 'timeout' | 'budgetLimit' | 'maxWindows' | 'enumerationFailed';

export interface UiInspectResult {
  inspectionVersion?: number;
  helperPeakWorkingSetBytes?: number;
  treeComplete?: boolean;
  traversalErrors?: number;
  propertyIssueCount?: number;
  queryResult?: { status: "unique" | "ambiguous" | "not-found" | "incomplete"; searchComplete: boolean; visitedNodes: number; reason?: string; matches: UiNode[] };
  auditNotice?: { directory: string; totalBytes: number; warningBytes: number; stopBytes: number;
    blocked: boolean; message?: string };
  windows?: Array<UiCandidateWindow & { pid: number; processName?: string; processNameStatus: 'available' | 'unavailable' }>;
  capturedAt?: string;
  enumerationComplete?: boolean;
  schemaVersion: string;
  protocolVersion: string;
  requestId: string;
  success: boolean;
  action?: string;
  status?: string;
  pid?: number;
  hwnd?: string;
  captureOrigin?: UiRect;
  captureMethod?: string;
  backgroundOnly?: boolean;
  imageWidth?: number;
  imageHeight?: number;
  imageScale?: number;
  imageOmitted?: boolean;
  imageOmittedReason?: string;
  tree?: UiNode;
  totalNodes?: number;
  maxDepthReached?: number;
  truncated?: boolean;
  truncateReason?: UiTruncateReason;
  screenshotPngBase64?: string;
  annotatedPngBase64?: string;
  candidateWindows?: UiCandidateWindow[];
  errorCode?: string;
  errorMessage?: string;
}

export type UiListWindowsRequest = Pick<UiInspectRequest, 'pid' | 'processName' | 'titleContains' | 'maxWindows'>;

/** Reject unbounded/ambiguous filters before launching the helper. Strings are literal filters. */
export function validateWindowQuery(value: UiListWindowsRequest): void {
  if ((value.pid !== undefined && (!Number.isSafeInteger(value.pid) || value.pid < 1 || value.pid > 2147483647)) ||
      (value.maxWindows !== undefined && (!Number.isInteger(value.maxWindows) || value.maxWindows < 1 || value.maxWindows > 100)) ||
      [value.processName, value.titleContains].some(s => s !== undefined &&
        (typeof s !== 'string' || !s.trim() || s.length > 128 || /[\x00-\x1f]/.test(s)))) {
    throw new Error('Invalid window filters: positive PID, maxWindows 1–100, nonempty single-line strings up to 128 characters required.');
  }
}

export const UiErrorCodes = {
  WINDOW_NOT_FOUND: 'WINDOW_NOT_FOUND',
  NO_VISIBLE_WINDOWS: 'NO_VISIBLE_WINDOWS',
  MULTIPLE_WINDOWS: 'MULTIPLE_WINDOWS',
  WINDOW_MINIMIZED: 'WINDOW_MINIMIZED',
  WINDOW_EMPTY_BOUNDS: 'WINDOW_EMPTY_BOUNDS',
  UIA_ELEMENT_NOT_AVAILABLE: 'UIA_ELEMENT_NOT_AVAILABLE',
  HWND_PID_MISMATCH: 'HWND_PID_MISMATCH',
  TIMEOUT: 'TIMEOUT',
  CANCELLED: 'CANCELLED',
  VERSION_MISMATCH: 'VERSION_MISMATCH',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  HOST_UNAVAILABLE: 'HOST_UNAVAILABLE',
  HOST_ERROR: 'HOST_ERROR',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  PLATFORM_NOT_SUPPORTED: 'PLATFORM_NOT_SUPPORTED',
  BUSY: 'BUSY',
  SHUTDOWN: 'SHUTDOWN',
} as const;

export type UiErrorCode = (typeof UiErrorCodes)[keyof typeof UiErrorCodes];

export const UI_INSPECT_DEFAULTS = {
  TIMEOUT_MS: 10_000,
  MAX_DEPTH: 6,
  MAX_NODES: 300,
  MAX_TEXT_JSON_BYTES: 128 * 1024,
  MAX_IMAGE_BYTES: 2 * 1024 * 1024,
  MAX_HOST_TRANSPORT_BYTES: 6 * 1024 * 1024,
  MAX_JSON_BYTES: 6 * 1024 * 1024,
} as const;
