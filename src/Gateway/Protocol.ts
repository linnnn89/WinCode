import { Tool } from '@modelcontextprotocol/server';
import { createHash } from 'node:crypto';

/** Stable across object key order; array order is part of a schema's contract. */
export function contractHash(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical) :
    item && typeof item === 'object' ? Object.fromEntries(Object.entries(item)
      .sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, child]) => [key, canonical(child)])) : item;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function toolsContractHash(tools: Tool[]): string {
  return contractHash([...tools].sort((a, b) => a.name.localeCompare(b.name, 'en')));
}

export const WINCODE_TOOLS: Tool[] = [
  {
    name: 'wincode_ui_list_windows',
    description: 'Lists visible top-level Windows windows without activation, screenshots or control traversal. Optional filters are combined with AND. Select a returned PID and HWND explicitly; titles do not establish project ownership. Results may become stale immediately.',
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      pid: { type: 'integer', minimum: 1, maximum: 2147483647 },
      processName: { type: 'string', minLength: 1, maxLength: 128, description: 'Exact process name without .exe, case-insensitive.' },
      titleContains: { type: 'string', minLength: 1, maxLength: 128, description: 'Literal case-insensitive title substring.' },
      maxWindows: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
    } },
  },
  {
    name: 'workspace_open',
    description: 'Opens a workspace and returns a compact project summary and at most 8 entry paths. Default output is bounded to 8000 UTF-16 characters; counts describe bounded discovery, not a complete inventory. Directory tree is opt-in and bounded; use wincode_list_directory for focused browsing.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: {
          type: 'string',
          minLength: 1, maxLength: 4096,
          description: 'Path to the workspace project directory to open.',
        },
        includeTree: { type: 'boolean', default: false, description: 'Include a bounded compatibility directory tree. Never an unbounded inventory.' },
        maxOutputChars: { type: 'integer', minimum: 2048, maximum: 32768, default: 8000, description: 'Budget for the entire compact JSON text including escaping and metadata; not model tokens.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'wincode_list_directory',
    description: 'Lists a bounded directory within the active workspace on demand. Returns relative paths, traversal gaps and actual visited/returned counts. Does not change symbol-search or cache-fingerprint rules. Use a narrower path after truncation; no snapshot or cursor is retained.',
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        path: { type: 'string', minLength: 1, maxLength: 4096, default: '.', description: 'Relative in-workspace directory. Parent traversal and outside-workspace links are rejected.' },
        maxDepth: { type: 'integer', minimum: 1, maximum: 5, default: 1 },
        maxEntries: { type: 'integer', minimum: 1, maximum: 500, default: 100, description: 'Maximum directory entries examined, including omitted entries.' },
        maxOutputChars: { type: 'integer', minimum: 2048, maximum: 32768, default: 8000 },
        includeIgnored: { type: 'boolean', default: false, description: 'Explicitly include normally hidden generated directories within the workspace.' },
      },
    },
  },
  {
    name: 'wincode_hello_world',
    description: 'Heartbeat plus layered adapter status and lightweight runtime health (uptime, cache bytes, managed child processes, Node memory, last adapter error). Reports whether Serena command exists, handshake succeeded, project is active, and semantic query is usable. available/fallback does not mean Serena is connected.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        greeting: {
          type: 'string',
          maxLength: 1024,
          description: 'Optional custom greeting message to echo back.',
        },
        toolName: { type: 'string', minLength: 1, maxLength: 128, description: 'Return the input schema registered in this running instance for one exact tool name. Compare with this connection tools/list; source or dist changes do not update an existing process.' },
      },
    },
  },
  {
    name: 'wincode_analyze_workspace',
    description: 'Workspace overview from project files. For .NET, emits sln/csproj dependency graph and entry points. Directory folder names are hints only, not architecture judgments.',
    inputSchema: {
      type: 'object',
      properties: {
        maxDepth: {
          type: 'number',
          description: 'Maximum directory tree depth to inspect (default 2)',
        },
      },
    },
  },
  {
    name: 'wincode_prepare_context',
    description: 'Returns compact file evidence with actual source ranges and omission metadata. Explicit lineRanges report final complete-line coverage and recoverable missing ranges after serialization; a partial last line is not covered. Other requests do not establish full method/task coverage. maxTokens budgets ALL response text using characters/4 (not a model tokenizer). Set includeFullText for packed bodies; legacy opts into JSON plus Markdown.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        task: {
          type: 'string',
          minLength: 1, maxLength: 8192,
          description: 'Description of the coding task or query the agent is working on (e.g. "分析这个项目架构").',
        },
        candidateFiles: {
          type: 'array',
          maxItems: 20,
          items: { type: 'string', minLength: 1, maxLength: 1024 },
          description: 'Literal in-workspace file paths to prioritize, not an exclusive search scope. No glob patterns or parent traversal.',
        },
        scopeFiles: {
          type: 'array', minItems: 1, maxItems: 20,
          items: { type: 'string', minLength: 1, maxLength: 1024 },
          description: 'Exclusive literal file scope; skips workspace symbol search. candidateFiles/lineRanges must stay inside it. Cannot combine with focusAreas.',
        },
        symbol: {
          type: 'string', minLength: 1, maxLength: 128,
          description: 'Exact case-sensitive declaration name within required scopeFiles. Local pattern matching, not semantic analysis. Ambiguous/missing targets return issues instead of file-head evidence. Cannot combine with lineRanges.',
        },
        lineRanges: {
          type: 'array', minItems: 1, maxItems: 8,
          items: {
            type: 'object', required: ['file', 'startLine', 'endLine'],
            properties: {
              file: { type: 'string', minLength: 1, maxLength: 1024 },
              startLine: { type: 'integer', minimum: 1 },
              endLine: { type: 'integer', minimum: 1 },
            },
          },
          description: 'Inclusive 1-based ranges, one per file, at most 500 lines each. Skips symbol search; out-of-bounds ranges return issues. Cannot combine with symbol/includeFullText. Budget may truncate returned lines.',
        },
        focusAreas: {
          type: 'array',
          maxItems: 5,
          items: { type: 'string', minLength: 1, maxLength: 1024 },
          description: 'Literal in-workspace files or directories, e.g. ["src/Core"]. No globs. Adds at most 8 immediate code files, scanning at most 1000 entries per directory; gaps appear in fileIssues.',
        },
        compress: {
          type: 'boolean',
          description: 'Forwarded to Repomix CLI --compress when includeFullText is true and the CLI is installed. Builtin fallback does not AST-compress.',
        },
        outputFormat: {
          type: 'string',
          enum: ['markdown', 'xml'],
          description: 'Output format of packed snapshot when includeFullText is true (default: markdown).',
        },
        includeFullText: {
          type: 'boolean',
          description: 'If true, pack related file bodies within maxTokens. Default false: snippets with locations only.',
        },
        responseFormat: {
          type: 'string', enum: ['compact', 'legacy'], default: 'compact',
          description: 'compact returns one JSON text block without repeated evidence. legacy preserves JSON plus Markdown; both blocks share maxTokens.',
        },
        maxTokens: {
          type: 'integer', minimum: 512, maximum: 65536, default: 8000,
          description: 'Total returned text budget estimated as UTF-16 characters / 4, including JSON and metadata (default 8000). Actual model tokens can differ.',
        },
      },
      required: ['task'],
    },
  },
  {
    name: 'wincode_find_code_symbol',
    description: 'Locates code symbols with signatures and line numbers. Uses Serena when handshake and project activation succeed; otherwise local text scan. Result includes source, queryComplete, uniqueTypeMatch, and limitations.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Symbol name or search query.',
        },
        kind: {
          type: 'string',
          description: 'Optional filter: class, interface, method, function, type, enum.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'wincode_find_references',
    description: 'Finds all call sites and usages of a specified symbol across the repository. Uses Serena semantic references when available; degrades to local text retrieval with explicit limitations annotation (text retrieval does not guarantee symbol identity or cross-file reference completeness).',
    inputSchema: {
      type: 'object',
      properties: {
        symbolName: {
          type: 'string',
          description: 'Exact symbol name, or the full upstream namePath including containers and overload indices such as Service/Save[0]. Pair a full namePath with its defining relativePath. Simple names require a complete unique semantic resolution; ambiguity does not select the first result.',
        },
        relativePath: {
          type: 'string',
          description: 'Defining file relative to the workspace. Pair it with the full namePath for precise references; omitted paths are resolved only from a complete unique semantic candidate.',
        },
      },
      required: ['symbolName'],
    },
  },
  {
    name: 'analyze_change_impact',
    description: 'Estimates change blast radius from uniquely resolved symbols. Confidence depends on unique resolution and query completeness, not on source=serena-mcp alone. Zero references yield UNKNOWN, never safe-to-delete.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Name of the class, component, or file to evaluate (e.g. "MemoryService" or "MemoryService.cs").',
        },
      },
      required: ['target'],
    },
  },
  {
    name: 'wincode_analyze_change_impact',
    description: 'Alias for analyze_change_impact. Same unique-resolution and UNKNOWN-on-incomplete-query contract.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Name of the class, method, or component to evaluate.',
        },
      },
      required: ['target'],
    },
  },
  {
    name: 'wincode_diagnose_project',
    description: 'Diagnoses project health, Windows/.NET SDK readiness, solution files, Serena/Repomix status, and a lightweight runtime snapshot (uptime, cache, child processes). dotnet --version is not semantic analysis.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'wincode_plan_refactoring',
    description: 'Provides structured refactoring guidance, step-by-step breakdown, and safety boundaries for a component.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Component or symbol name to refactor.',
        },
        goal: {
          type: 'string',
          description: 'Goal or rationale for the refactoring.',
        },
      },
      required: ['target', 'goal'],
    },
  },
  {
    name: 'wincode_safe_move_to_trash',
    description: 'Safely moves an obsolete or deleted file into the project trash/ directory with metadata instead of permanent deletion.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Non-empty relative path of the file within the current workspace to safely move to trash. Absolute paths and drive-relative paths (e.g., C:foo) are strictly rejected.',
        },
        reason: {
          type: 'string',
          description: 'Reason for removal.',
        },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'wincode_ui_inspect',
    description: 'Inspects a Windows desktop application window using UI Automation. Returns a bounded control tree (JSON) and optional annotated screenshot (MCP image content). Requires either pid or hwnd.',
    inputSchema: {
      type: 'object',
      properties: {
        pid: {
          type: 'integer',
          minimum: 1,
          description: 'Process ID of the target Windows desktop application.',
        },
        hwnd: {
          type: 'string',
          description: 'Window handle of the target window (hex e.g. "0x00120ABC" or decimal string).',
        },
        capture: {
          type: 'string',
          enum: ['none', 'original', 'annotated'],
          default: 'none',
          description: 'Screenshot capture mode: "none" (default), "original" (raw window image), or "annotated" (with numbered badges matching UiNode.id).',
        },
        query: {
          type: 'object', additionalProperties: false,
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
          description: 'Require explicit PID+HWND; never use screen-pixel capture fallback. No activation or restore. Window capture may fail or produce unusable pixels; inspect captureMethod and imageOmitted.',
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
  },
];

// Review accepts the same target/capture controls as inspect, plus a deliberately closed source scope.
const uiInspectTool = WINCODE_TOOLS.find(tool => tool.name === 'wincode_ui_inspect')!;
WINCODE_TOOLS.push({
  name: 'wincode_ui_review',
  description: 'Collects one UI snapshot and literal AutomationId candidates in supplied WPF XAML files. Returns source lines and ambiguity, not verified runtime/source identity or automatic defect diagnosis.',
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
    },
    required: ['candidateFiles'],
  },
});
