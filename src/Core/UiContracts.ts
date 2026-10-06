/**
 * Bounded Windows UI inspection contracts. Optional query/state fields require inspectionVersion 2;
 * semantic actions require inspectionVersion 3; explicit expand/collapse requires version 4.
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

export type UiAction = 'click' | 'type' | 'setValue' | 'setExpanded';

/** 取证结构版本：2 增加 query/readStates，3 增加语义操作。旧 Helper 不得被当作新能力。 */
export const UI_INSPECTION_VERSIONS = { QUERY_AND_STATES: 2, ACTIONS: 3, EXPAND_COLLAPSE: 4 } as const;

export function isUiAction(action: unknown): action is UiAction {
  return action === 'click' || action === 'type' || action === 'setValue' || action === 'setExpanded';
}

/**
 * 语义操作的共享边界校验：在启动原生 Helper 之前拒绝缺少唯一目标或输入不合规的请求。
 * 只有同一次有界搜索证明唯一的控件才允许被操作，因此至少需要一个精确定位条件。
 */
export function validateUiAction(request: UiInspectRequest): void {
  if (!isUiAction(request.action)) throw new Error('validateUiAction requires a ui action.');
  // 查询与状态读取属于取证范围；与破坏性动作混用会让调用方误以为动作被限定在同一范围内。
  if (request.query !== undefined || request.readStates === true)
    throw new Error('query/readStates describe inspection and are not accepted for an action.');
  const selectors = [request.targetAutomationId, request.targetName, request.targetControlType];
  if (!selectors.some(value => value !== undefined)) throw new Error('A target selector (targetAutomationId, targetName or targetControlType) is required.');
  for (const value of selectors)
    if (value !== undefined && (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\x00-\x1f]/.test(value)))
      throw new Error('Invalid target selector.');
  if (request.clearBefore !== undefined && typeof request.clearBefore !== 'boolean') throw new Error('clearBefore must be boolean.');
  if (request.clearBefore === true && request.action !== 'type') throw new Error('clearBefore is only supported for the type action.');
  if (request.action === 'setExpanded' && typeof request.expanded !== 'boolean') throw new Error('expanded must be boolean.');
  if (request.action !== 'setExpanded' && request.expanded !== undefined) throw new Error('expanded is only supported for setExpanded.');
  if (request.action === 'click' || request.action === 'setExpanded') {
    if (request.inputText !== undefined) throw new Error(`inputText is not accepted for the ${request.action} action.`);
    return;
  }
  if (typeof request.inputText !== 'string' || request.inputText.length > 4096) throw new Error('inputText is required and must be at most 4096 characters.');
  // type 需要真实按键输入，空文本无意义；setValue 允许用空字符串清空值。
  if (request.action === 'type' && request.inputText.length === 0) throw new Error('inputText must not be empty for the type action.');
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
  action?: 'inspect' | 'health' | 'ping' | 'listWindows' | UiAction;
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
  /** 语义操作的目标定位条件；click/type/setValue 至少需要一个。 */
  targetAutomationId?: string;
  targetName?: string;
  targetControlType?: string;
  /** type 的按键文本或 setValue 的写入值；结果只回报长度，不回显内容。 */
  inputText?: string;
  /** 仅 type 有效：先清空目标控件的既有内容。 */
  clearBefore?: boolean;
  expanded?: boolean;
}

export type UiTruncateReason = 'maxDepth' | 'maxNodes' | 'timeout' | 'budgetLimit' | 'maxWindows' | 'enumerationFailed';

export interface UiInspectResult {
  hostIdentity?: { version: string; informationalVersion?: string; configuration?: string; framework?: string };
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
  /** 实际使用的 UIA 模式或输入方式；只描述执行方式，不声明应用已产生预期副作用。 */
  actionMethod?: string;
  actionTarget?: { propertyIssues?: string[]; automationId?: string; name?: string; controlType?: string;
    className?: string; bounds?: UiRect; isEnabled?: boolean; isOffscreen?: boolean };
  /** 已接受的输入字符数；输入内容本身不回显。 */
  inputLength?: number;
  pid?: number;
  hwnd?: string;
  captureOrigin?: UiRect;
  captureMethod?: string;
  /** Bounded raw-pixel hint only; neither status establishes visual usability. */
  captureQuality?: { status: 'suspect-low-variation' | 'unknown'; sampleCount: number;
    maxChannelRange?: number; message: string };
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
  // 语义操作（click/type/setValue）结果码。只有唯一命中的目标才允许被操作。
  TARGET_NOT_FOUND: 'TARGET_NOT_FOUND',
  TARGET_AMBIGUOUS: 'TARGET_AMBIGUOUS',
  TARGET_SEARCH_INCOMPLETE: 'TARGET_SEARCH_INCOMPLETE',
  TARGET_DISABLED: 'TARGET_DISABLED',
  NO_CLICK_PATTERN: 'NO_CLICK_PATTERN',
  NO_EXPAND_COLLAPSE_PATTERN: 'NO_EXPAND_COLLAPSE_PATTERN',
  EXPAND_STATE_UNSUPPORTED: 'EXPAND_STATE_UNSUPPORTED',
  NO_VALUE_PATTERN: 'NO_VALUE_PATTERN',
  VALUE_READONLY: 'VALUE_READONLY',
  FOCUS_FAILED: 'FOCUS_FAILED',
  ACTION_FAILED: 'ACTION_FAILED',
  UNKNOWN_ACTION: 'UNKNOWN_ACTION',
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
