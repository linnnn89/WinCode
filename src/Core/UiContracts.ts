/**
 * Contracts for Windows UI Runtime Inspection (v0.6)
 * Follows WinCode v0.6运行时UI取证实施方案.md and Grok review guidelines.
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

export interface UiInspectRequest {
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
