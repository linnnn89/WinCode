import { defineTool, jsonResult } from './ToolDefinition.js';
import { uiResponse } from './UiResponse.js';
import { UI_INSPECT_DEFAULTS, validateUiQuery, validateUiScope, validateWindowQuery, validateUiAction,
  type UiAction, type UiInspectRequest, type UiListWindowsRequest } from '../Core/UiContracts.js';
import { validateCandidateFiles } from '../Core/UiSourceMapper.js';
import { validateCandidateCodeFiles } from '../Core/UiCodeMapper.js';
import { validateTextQueries } from '../Core/UiTextSearch.js';

function validateInspect(args: UiInspectRequest): void {
  validateUiScope(args.scopePath, 'inspect');
  validateUiQuery(args.query, args.readStates);
  if (args.backgroundOnly === true && (!args.pid || !args.hwnd))
    throw new Error('backgroundOnly requires explicit pid and hwnd.');
  if (args.hwnd !== undefined && !args.hwnd.trim()) throw new Error('hwnd must be non-empty.');
}

/** 动作工具在任何受理与进程启动之前先做完整契约校验。 */
function validateActionRequest(args: UiActionArgs, action: UiAction): void {
  if (args.hwnd !== undefined && (typeof args.hwnd !== 'string' || !args.hwnd.trim())) throw new Error('hwnd must be non-empty.');
  validateUiAction({
    action, pid: args.pid, hwnd: args.hwnd,
    targetAutomationId: args.targetAutomationId, targetName: args.targetName,
    targetControlType: args.targetControlType, inputText: args.inputText, clearBefore: args.clearBefore,
    expanded: args.expanded,
    scopePath: args.scopePath,
  });
}

type UiInspectArgs = UiInspectRequest & { responseFormat?: 'full' | 'compact' };
type UiReviewArgs = UiInspectArgs & { candidateFiles: string[]; candidateCodeFiles?: string[]; textQueries?: string[] };

/** 动作参数：定位与输入字段与取证参数分开声明，避免把 query/readStates 误当成动作范围。 */
type UiActionArgs = {
  scopePath?: UiInspectRequest['scopePath'];
  pid?: number; hwnd?: string;
  targetAutomationId?: string; targetName?: string; targetControlType?: string;
  inputText?: string; clearBefore?: boolean;
  expanded?: boolean;
};
type UiTypeArgs = UiActionArgs & { inputText: string; mode?: 'type' | 'setValue' };

const scopePathProperty = {
  type: 'array', minItems: 1, maxItems: 50,
  description: 'inspectionVersion 5: ordered exact parent selectors. Each hop resolves one strict descendant in the previous scope; the final query/action stays inside the last parent. Does not expand hidden parents.',
  items: { type: 'object', additionalProperties: false, properties: {
    automationId: { type:'string', minLength:1, maxLength:256 },
    name: { type:'string', minLength:1, maxLength:256 },
    controlType: { type:'string', minLength:1, maxLength:256 },
  }, anyOf: [{required:['automationId']}, {required:['name']}, {required:['controlType']}] },
};

const actionTargetProperties = {
  pid: { type: 'integer', minimum: 1,
    description: 'Process ID of the target Windows desktop application.' },
  hwnd: { type: 'string', maxLength: 32,
    description: 'Window handle of the target window (hex e.g. "0x00120ABC" or decimal string).' },
  targetAutomationId: { type: 'string', minLength: 1, maxLength: 256,
    description: 'Exact case-sensitive AutomationId of the single control to act on.' },
  targetName: { type: 'string', minLength: 1, maxLength: 256,
    description: 'Exact case-sensitive Name of the single control to act on.' },
  targetControlType: { type: 'string', minLength: 1, maxLength: 256,
    description: 'Exact case-sensitive control type (for example "Button"); combine with other fields to stay unique.' },
} as const;

const invalidArguments = (errorMessage: string) => jsonResult({ schemaVersion: '1.0', protocolVersion: '1.0',
  success: false, errorCode: 'INVALID_ARGUMENT', errorMessage }, false, true);

const inspectDefinition = defineTool<UiInspectArgs>({
  name: 'wincode_ui_inspect',
  description: 'Inspects a Windows desktop application window using UI Automation. Returns a bounded control tree (JSON) and optional annotated screenshot (MCP image content). Requires either pid or hwnd.',
  inputSchema: {
    type: 'object', additionalProperties: true,
    properties: {
      scopePath: scopePathProperty,
      responseFormat: { type: 'string', enum: ['full', 'compact'], default: 'full',
        description: 'compact keeps snapshot IDs/hierarchy/states and image, omits per-node geometry/className, shares code candidates and adds a summary plus live-UI expansion requests. full preserves the complete response shape.' },
      pid: {
        type: 'integer',
        minimum: 1,
        description: 'Process ID of the target Windows desktop application.',
      },
      hwnd: {
        type: 'string', maxLength: 32,
        description: 'Window handle of the target window (hex e.g. "0x00120ABC" or decimal string).',
      },
      capture: {
        type: 'string',
        enum: ['none', 'original', 'annotated'],
        default: 'none',
        description: 'Screenshot capture mode: "none" (default), "original" (raw window image), or "annotated" (with numbered badges matching UiNode.id).',
      },
      query: {
        type: 'object', additionalProperties: true,
        description: 'Exact case-sensitive AND filters. Search is bounded separately from returned subtree; only a complete unique match becomes the tree. IDs are snapshot-local.',
        properties: {
          automationId: {type:'string', minLength:1, maxLength:256},
          name: {type:'string', minLength:1, maxLength:256},
          controlType: {type:'string', minLength:1, maxLength:256},
          maxSearchNodes: {type:'integer', minimum:1, maximum:5000, default:1000},
          maxMatches: {type:'integer', minimum:1, maximum:20, default:10},
        },
        anyOf: [{required:['automationId']}, {required:['name']}, {required:['controlType']}],
      },
      readStates: {type:'boolean', default:false, description:'Read toggle, selection and expand/collapse states only; no actions or input values.'},
      backgroundOnly: {
        type: 'boolean', default: false,
        description: 'Require explicit PID+HWND; never use screen-pixel capture fallback. No activation or restore. Window capture may fail or produce unusable pixels; inspect captureMethod, captureQuality and imageOmitted. Quality is a hint, not a usability verdict.',
      },
      maxDepth: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        default: 6,
        description: 'Maximum depth of the control tree traversal (default: 6).',
      },
      maxNodes: {
        type: 'integer',
        minimum: 1,
        maximum: 5000,
        default: 300,
        description: 'Maximum total nodes to collect across the control tree (default: 300).',
      },
    },
    anyOf: [
      { required: ['pid'] },
      { required: ['hwnd'] },
    ],
  },
}, {
  invalidArguments, validate: validateInspect,
  requestBudget: 'ui',
  execute: async (args, { router, signal }) => {
    const { responseFormat, ...input } = args;
    return uiResponse(await router.inspectUi({ ...input, hwnd: input.hwnd?.trim() }, signal), responseFormat, input.scopePath);
  },
});
const uiInspectTool = inspectDefinition.tool;

const clickDefinition = defineTool<UiActionArgs>({
  name: 'wincode_ui_click',
  description: 'Clicks exactly one Windows UI Automation control identified by an exact selector. Only UI Automation Invoke/Toggle/SelectionItem patterns are used: no mouse simulation, no window activation. The selector must match one control inside the target window, otherwise nothing is clicked. Requires either pid or hwnd.',
  annotations: { readOnlyHint: false, destructiveHint: true },
  inputSchema: {
    type: 'object', additionalProperties: true,
    properties: actionTargetProperties,
    anyOf: [{ required: ['pid'] }, { required: ['hwnd'] }],
  },
}, {
  invalidArguments,
  validate: args => validateActionRequest(args, 'click'),
  requestBudget: 'ui',
  // 点击可能已经发生：请求在收尾阶段过期也不能把副作用报告成未执行。
  preserveOutcomeOnInterruption: true,
  execute: async (args, { router, signal }) => {
    const result = await router.performUiAction({ ...args, hwnd: args.hwnd?.trim(), action: 'click' }, signal);
    return jsonResult(result, false, !result.success);
  },
});

const typeDefinition = defineTool<UiTypeArgs>({
  name: 'wincode_ui_type',
  description: 'Writes text into exactly one Windows UI Automation control identified by an exact selector. Prefer mode="setValue" for background work: it writes through ValuePattern, needs no keyboard focus, and accepts an empty string to clear the value. mode="type" requests keyboard focus on the control, which may bring its window to the front: use it only when the user approved foreground interaction. Text is never echoed back. Requires either pid or hwnd.',
  annotations: { readOnlyHint: false, destructiveHint: true },
  inputSchema: {
    type: 'object', additionalProperties: true,
    properties: {
      ...actionTargetProperties,
      inputText: { type: 'string', maxLength: 4096,
        description: 'Text to write. mode="type" requires at least one character; mode="setValue" also accepts an empty string, which clears the value. It is never returned in the result.' },
      clearBefore: { type: 'boolean', default: false,
        description: 'mode="type" only: select and delete the existing content before typing.' },
      mode: { type: 'string', enum: ['type', 'setValue'], default: 'type',
        description: 'type (default) sends keyboard input and needs confirmed focus; setValue writes the value through ValuePattern without keyboard focus.' },
    },
    required: ['inputText'],
    anyOf: [{ required: ['pid'] }, { required: ['hwnd'] }],
  },
}, {
  invalidArguments,
  validate: args => validateActionRequest(args, args.mode === 'setValue' ? 'setValue' : 'type'),
  requestBudget: 'ui',
  preserveOutcomeOnInterruption: true,
  execute: async (args, { router, signal }) => {
    const { mode, ...rest } = args;
    const action = mode === 'setValue' ? 'setValue' : 'type';
    const result = await router.performUiAction({ ...rest, hwnd: rest.hwnd?.trim(), action }, signal);
    return jsonResult(result, false, !result.success);
  },
});

export const UI_TOOLS = [
  defineTool<UiListWindowsRequest>({
    name: 'wincode_ui_list_windows',
    description: 'Lists visible top-level Windows windows without activation, screenshots or control traversal. Optional filters are combined with AND. Select a returned PID and HWND explicitly; titles do not establish project ownership. Results may become stale immediately.',
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: { type: 'object', additionalProperties: true, properties: {
      pid: { type: 'integer', minimum: 1, maximum: 2147483647 },
      processName: { type: 'string', minLength: 1, maxLength: 128, description: 'Exact process name without .exe, case-insensitive.' },
      titleContains: { type: 'string', minLength: 1, maxLength: 128, description: 'Literal case-insensitive title substring.' },
      maxWindows: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
    } },
  }, {
    invalidArguments,
    validate: args => validateWindowQuery(args),
    requestBudget: 'ui',
    execute: async (args, { router, signal }) => {
      const result = await router.listUiWindows(args, signal);
      const text = JSON.stringify(result);
      if (Buffer.byteLength(text, 'utf8') > UI_INSPECT_DEFAULTS.MAX_TEXT_JSON_BYTES)
        return jsonResult({ success: false, errorCode: 'PAYLOAD_TOO_LARGE',
          errorMessage: 'Window list exceeds text budget.', auditNotice: result.auditNotice }, false, true);
      return jsonResult(result, false, !result.success);
    },
  }),
  inspectDefinition,
  clickDefinition,
  defineTool<UiActionArgs & { expanded: boolean }>({
    name: 'wincode_ui_set_expanded',
    description: 'Sets one unique enabled control to an explicit Expanded or Collapsed state using ExpandCollapsePattern. Already in the requested state is a no-op. No mouse, focus, click fallback or automatic retry. Verify state and child controls with inspect afterwards. Requires inspectionVersion 4; optional scopePath requires version 5 and is checked before sending an action.',
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: { type: 'object', additionalProperties: true,
      properties: { ...actionTargetProperties, scopePath: scopePathProperty, expanded: { type: 'boolean' } }, required: ['expanded'],
      anyOf: [{ required: ['pid'] }, { required: ['hwnd'] }] },
  }, {
    invalidArguments, validate: args => validateActionRequest(args, 'setExpanded'), requestBudget: 'ui',
    preserveOutcomeOnInterruption: true,
    execute: async (args, { router, signal }) => {
      const result = await router.performUiAction({ ...args, hwnd: args.hwnd?.trim(), action: 'setExpanded' }, signal);
      return jsonResult(result, false, !result.success);
    },
  }),
  typeDefinition,
  defineTool<UiReviewArgs>({
    name: 'wincode_ui_review',
    description: 'Collects one UI snapshot and literal AutomationId candidates in supplied WPF XAML files. Optional C# files provide Click/simple Binding candidates and scoped next requests. Reports ambiguity; runtime/source identity and binding causality remain unverified.',
    inputSchema: {
      ...uiInspectTool.inputSchema,
      properties: {
        ...uiInspectTool.inputSchema.properties,
        textQueries: {
          type: 'array', maxItems: 5, items: { type: 'string', minLength: 1, maxLength: 80 },
          description: 'Optional explicit UI keywords/resource keys. Literal case-sensitive attribute search only; hits are not runtime node mappings.',
        },
        candidateFiles: {
          type: 'array', minItems: 1, maxItems: 16,
          items: { type: 'string', maxLength: 512 },
          description: 'Explicit relative in-workspace .xaml files; no recursive repository scan.',
        },
        candidateCodeFiles: {
          type: 'array', minItems: 1, maxItems: 8,
          items: { type: 'string', minLength: 1, maxLength: 512 },
          description: 'Optional explicit relative in-workspace .cs files for literal declarations/assignments. No full-repository scan, DataContext/template resolution, or inferred CanExecute cause.',
        },
      },
      required: ['candidateFiles'],
    },
  }, {
    invalidArguments,
    validate: args => {
      validateInspect(args);
      validateCandidateFiles(args.candidateFiles);
      validateCandidateCodeFiles(args.candidateCodeFiles);
      validateTextQueries(args.textQueries);
    },
    requestBudget: 'ui',
    execute: async (args, { router, signal }) => {
      const { candidateFiles, candidateCodeFiles, textQueries, responseFormat, ...input } = args;
      return uiResponse(await router.reviewUi({ ...input, hwnd: input.hwnd?.trim() }, candidateFiles, signal, textQueries, candidateCodeFiles), responseFormat, input.scopePath);
    },
  }),
];
