import { defineTool, jsonResult } from './ToolDefinition.js';
import { uiResponse } from './UiResponse.js';
import { UI_INSPECT_DEFAULTS, validateUiQuery, validateWindowQuery, type UiInspectRequest, type UiListWindowsRequest } from '../Core/UiContracts.js';
import { validateCandidateFiles } from '../Core/UiSourceMapper.js';
import { validateCandidateCodeFiles } from '../Core/UiCodeMapper.js';
import { validateTextQueries } from '../Core/UiTextSearch.js';

function validateInspect(args: UiInspectRequest): void {
  validateUiQuery(args.query, args.readStates);
  if (args.backgroundOnly === true && (!args.pid || !args.hwnd))
    throw new Error('backgroundOnly requires explicit pid and hwnd.');
  if (args.hwnd !== undefined && !args.hwnd.trim()) throw new Error('hwnd must be non-empty.');
}

type UiInspectArgs = UiInspectRequest & { responseFormat?: 'full' | 'compact' };
type UiReviewArgs = UiInspectArgs & { candidateFiles: string[]; candidateCodeFiles?: string[]; textQueries?: string[] };

const invalidArguments = (errorMessage: string) => jsonResult({ schemaVersion: '1.0', protocolVersion: '1.0',
  success: false, errorCode: 'INVALID_ARGUMENT', errorMessage }, false, true);

const inspectDefinition = defineTool<UiInspectArgs>({
  name: 'wincode_ui_inspect',
  description: 'Inspects a Windows desktop application window using UI Automation. Returns a bounded control tree (JSON) and optional annotated screenshot (MCP image content). Requires either pid or hwnd.',
  inputSchema: {
    type: 'object', additionalProperties: true,
    properties: {
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
    return uiResponse(await router.inspectUi({ ...input, hwnd: input.hwnd?.trim() }, signal), responseFormat);
  },
});
const uiInspectTool = inspectDefinition.tool;

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
      return uiResponse(await router.reviewUi({ ...input, hwnd: input.hwnd?.trim() }, candidateFiles, signal, textQueries, candidateCodeFiles), responseFormat);
    },
  }),
];
