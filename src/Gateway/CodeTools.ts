import { defineTool, jsonResult } from './ToolDefinition.js';
import { contextResponse } from './ContextResponse.js';
import { referenceResponse } from './ReferenceResponse.js';
import { validateContextScope, type PreparedContextOptions } from '../Core/Context.js';
import type { SymbolLocation } from '../Core/CodeQueries.js';
import { validateTextSearch, validateFileOutline, type TextSearchOptions, type FileOutlineOptions } from '../Core/CodeNavigation.js';

/** 引用、影响与重构共用同一位置校验契约。 */
const symbolLocationSchema = {
          type: 'object', additionalProperties: true, required: ['snapshotId', 'project', 'file', 'position'],
          properties: {
            snapshotId: { type: 'string', minLength: 32, maxLength: 32, pattern: '^[a-f0-9]{32}$' },
            project: { type: 'string', minLength: 1, maxLength: 4096 },
            file: { type: 'string', minLength: 1, maxLength: 4096 },
            position: { type: 'integer', minimum: 0 },
          },
          description: 'Copy the location returned by the current Roslyn symbol search. project/file are workspace-relative; position is a zero-based UTF-16 offset. This is not a durable ID. Local text mode rejects this field.',
        };

export const CODE_TOOLS = [
  defineTool<TextSearchOptions>({
    name: 'wincode_search_text',
    description: 'Searches a literal single-line string in bounded workspace files/directories without a semantic Host. Returns one match per line, UTF-16 columns, clipped previews and executable prepare_context nextRequest arguments. Inspect queryComplete, fileIssues and omitted counts; zero matches do not prove absence outside the scanned scope.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', additionalProperties: true, required: ['query'], properties: {
      query: { type: 'string', minLength: 1, maxLength: 256, description: 'Literal text, not a regular expression; no newlines.' },
      scopePaths: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 1024 },
        description: 'Exclusive literal files or directories; defaults to the workspace. Prefer a narrow scope. In-workspace absolute paths are accepted; no globs or parent traversal.' },
      caseSensitive: { type: 'boolean', default: false },
      maxResults: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      maxOutputChars: { type: 'integer', minimum: 2048, maximum: 32768, default: 8000, description: 'Budget for the entire serialized JSON text, not model tokens.' },
    } },
  }, {
    validate: (args, { router }) => { validateTextSearch(args, router.config.workspaceRoot); },
    execute: async (args, { router, signal }) => jsonResult(await router.searchText(args, signal)),
  }),
  defineTool<FileOutlineOptions>({
    name: 'wincode_file_outline',
    description: 'Reads one bounded UTF-8 source/text file, reports its observed line count/byte size and local declaration outline with prepare_context nextRequest arguments. No method-end or semantic identity claim. Other supported text formats return metadata with declarationsSupported=false. Lexical failures identify the affected file.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', additionalProperties: true, required: ['file'], properties: {
      file: { type: 'string', minLength: 1, maxLength: 1024, description: 'Literal file inside the workspace; absolute paths accepted. No globs or parent traversal.' },
      maxSymbols: { type: 'integer', minimum: 1, maximum: 200, default: 100 },
      maxOutputChars: { type: 'integer', minimum: 2048, maximum: 32768, default: 8000 },
    } },
  }, {
    validate: (args, { router }) => { validateFileOutline(args, router.config.workspaceRoot); },
    execute: async (args, { router, signal }) => jsonResult(await router.fileOutline(args, signal)),
  }),
  defineTool<PreparedContextOptions>({
    name: 'wincode_prepare_context',
    description: 'Returns compact file evidence with actual source ranges and omission metadata. Explicit lineRanges report final complete-line coverage and recoverable missing ranges after serialization; a partial last line is not covered. Other requests do not establish full method/task coverage. maxTokens budgets ALL response text using characters/4 (not a model tokenizer). Set includeFullText for packed bodies; legacy opts into JSON plus Markdown.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      additionalProperties: true,
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
            type: 'object', additionalProperties: true, required: ['file', 'startLine', 'endLine'],
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
  }, {
    validate: (args, { router }) => { validateContextScope(args, router.config.workspaceRoot); },
    execute: async (args, { router, signal }) => contextResponse(await router.prepareContext(args, signal), args.responseFormat),
  }),
  defineTool<{ query: string; kind?: string }>({
    name: 'wincode_find_code_symbol',
    description: 'Locates code declarations with signatures and positions using the configured provider. Direct Roslyn returns snapshot-bound location objects for exact reference selection; old locations expire after edits/reloads or changing connections. Inspect source, queryComplete, truncation and limitations.',
    inputSchema: {
      type: 'object', additionalProperties: true,
      properties: {
        query: {
          type: 'string', minLength: 1, maxLength: 256, pattern: '\\S',
          description: 'Symbol name or search query.',
        },
        kind: {
          type: 'string', maxLength: 128,
          description: 'Optional filter: class, interface, method, function, type, enum.',
        },
      },
      required: ['query'],
    },
  }, {
    execute: async (args, { router, signal }) => jsonResult(await router.findCodeSymbols(args.query, args.kind, signal), true),
  }),
  defineTool<{ symbolName: string; relativePath?: string; symbolLocation?: SymbolLocation; limit?: number; maxOutputChars?: number }>({
    name: 'wincode_find_references',
    description: 'Queries references within the configured provider scope. For direct Roslyn pass a returned declaration location as symbolLocation and its name as symbolName; simple names return candidates without choosing a potentially ambiguous overload. Stale locations must be searched again. Zero or incomplete references do not imply safe deletion.',
    inputSchema: {
      type: 'object', additionalProperties: true,
      properties: {
        symbolName: {
          type: 'string', minLength: 1, maxLength: 256, pattern: '\\S',
          description: 'Plain symbol name. With Roslyn, select a returned symbolLocation to identify an overload. Old Serena namePath identities are retired.',
        },
        relativePath: {
          type: 'string', maxLength: 4096,
          description: 'Defining file relative to the workspace. Roslyn uses it to scope candidates; local text references remain a workspace-wide textual scan.',
        },
        symbolLocation: symbolLocationSchema,
        limit: {
          type: 'integer', minimum: 1, maximum: 1000,
          description: 'Maximum returned Roslyn references, default 100. Requires symbolLocation; does not change local-text search or semantic coverage. totalReferences counts the known snapshot results, not just the returned entries.',
        },
        maxOutputChars: {
          type: 'integer', minimum: 2048, maximum: 32768, default: 8000,
          description: 'Budget for the entire formatted JSON text in UTF-16 characters, including escaping and metadata; not model tokens. Applies to both providers and may return fewer entries than limit. Check returnedReferences, totalReferences, truncated and outputOmissions.',
        },
      },
      required: ['symbolName'],
    },
  }, {
    validate: args => { if (args.limit !== undefined && !args.symbolLocation) throw new Error('limit requires a Roslyn symbolLocation; search and select a declaration first.'); },
    execute: async (args, { router, signal }) => referenceResponse(await router.findCodeReferences(
      args.symbolName, args.relativePath, signal, args.symbolLocation, args.limit), args.maxOutputChars),
  }),
  defineTool<{ target: string; symbolLocation?: SymbolLocation }>({
    name: 'analyze_change_impact',
    description: 'Estimates change blast radius from uniquely resolved symbols. Confidence depends on unique resolution and query completeness, not on provider alone. Zero or incomplete references yield UNKNOWN, never safe-to-delete.',
    inputSchema: {
      type: 'object', additionalProperties: true,
      properties: {
        symbolLocation: symbolLocationSchema,
        target: {
          type: 'string', minLength: 1, maxLength: 4096, pattern: '\\S',
          description: 'Name of the class, component, or file to evaluate (e.g. "MemoryService" or "MemoryService.cs").',
        },
      },
      required: ['target'],
    },
  }, {
    aliases: [{ name: 'wincode_analyze_change_impact', listed: true,
      description: 'Alias for analyze_change_impact. Same unique-resolution and UNKNOWN-on-incomplete-query contract.' }],
    validate: args => { if (!args.target) throw new Error('target is required.'); },
    execute: async (args, { router, signal }) => {
      const impact = await (args.symbolLocation ? router.analyzeChangeImpact(args.target, signal, args.symbolLocation) : router.analyzeChangeImpact(args.target, signal));
      return jsonResult(impact, true);
    },
  }),
  defineTool<{ target: string; goal: string; symbolLocation?: SymbolLocation }>({
    name: 'wincode_plan_refactoring',
    description: 'Provides structured refactoring guidance, step-by-step breakdown, and safety boundaries for a component.',
    inputSchema: {
      type: 'object', additionalProperties: true,
      properties: {
        symbolLocation: symbolLocationSchema,
        target: {
          type: 'string', minLength: 1, maxLength: 4096, pattern: '\\S',
          description: 'Component or symbol name to refactor.',
        },
        goal: {
          type: 'string', minLength: 1, maxLength: 8192, pattern: '\\S',
          description: 'Goal or rationale for the refactoring.',
        },
      },
      required: ['target', 'goal'],
    },
  }, {
    execute: async (args, { router, signal }) => jsonResult(await (args.symbolLocation ? router.planRefactoring(args.target, args.goal, signal, args.symbolLocation) : router.planRefactoring(args.target, args.goal, signal)), true),
  }),
];
