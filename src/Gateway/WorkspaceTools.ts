import { defineTool, jsonResult } from './ToolDefinition.js';
import { validateWorkspaceDirectoryOptions, validateTrashPath, invalidTrashResult, type WorkspaceOpenOptions, type WorkspaceDirectoryOptions } from '../Core/Workspace.js';
import { RUNTIME_IDENTITY } from '../Core/RuntimeIdentity.js';
import { WINCODE_VERSION } from '../Core/Config.js';
import { contractHash } from './ContractHash.js';

export const WORKSPACE_TOOLS = [
  defineTool<WorkspaceOpenOptions & { path: string }>({
    name: 'workspace_open',
    description: 'Opens a workspace and returns a compact project summary and at most 8 entry paths. Reopening the same healthy workspace preserves the Roslyn Host and snapshot; known HOST_RESTART_REQUIRED or workspace recovery still requires explicit recovery. Default output is bounded to 8000 UTF-16 characters; counts describe bounded discovery, not a complete inventory. Directory tree is opt-in and bounded; use wincode_list_directory for focused browsing.',
    inputSchema: {
      type: 'object',
      additionalProperties: true,
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
  }, {
    aliases: [{ name: 'wincode_workspace_open', listed: false }], switchesWorkspace: true,
    validate: args => { if (!args.path.trim()) throw new Error('path must not be blank.'); },
    execute: async (args, { router, signal }) => jsonResult(await router.openWorkspace(args.path, {
      includeTree: args.includeTree, maxOutputChars: args.maxOutputChars,
    }, signal)),
  }),
  defineTool<WorkspaceDirectoryOptions>({
    name: 'wincode_list_directory',
    description: 'Lists a bounded directory within the active workspace on demand. Returns relative paths, traversal gaps and actual visited/returned counts. Does not change symbol-search or cache-fingerprint rules. Use a narrower path after truncation; no snapshot or cursor is retained.',
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: {
      type: 'object', additionalProperties: true,
      properties: {
        path: { type: 'string', minLength: 1, maxLength: 4096, default: '.', description: 'Relative in-workspace directory. Parent traversal and outside-workspace links are rejected.' },
        maxDepth: { type: 'integer', minimum: 1, maximum: 5, default: 1 },
        maxEntries: { type: 'integer', minimum: 1, maximum: 500, default: 100, description: 'Maximum directory entries examined, including omitted entries.' },
        maxOutputChars: { type: 'integer', minimum: 2048, maximum: 32768, default: 8000 },
        includeIgnored: { type: 'boolean', default: false, description: 'Explicitly include normally hidden generated directories within the workspace.' },
      },
    },
  }, {
    validate: (args, { router }) => { validateWorkspaceDirectoryOptions(args, router.config.workspaceRoot); },
    execute: async (args, { router }) => jsonResult(await router.listDirectory(args)),
  }),
  defineTool<{ greeting?: string; toolName?: string }>({
    name: 'wincode_hello_world',
    description: 'Passive heartbeat: current instance version, tool contracts and known adapter state, without starting probes. healthObservation includes observation time; unknown/null means not probed, and known state may be stale. Use wincode_diagnose_project for active checks. Local text availability does not mean Roslyn semantic analysis is configured.',
    inputSchema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        greeting: {
          type: 'string',
          maxLength: 1024,
          description: 'Optional custom greeting message to echo back.',
        },
        toolName: { type: 'string', minLength: 1, maxLength: 128, description: 'Return the input schema registered in this running instance for one exact tool name. Compare with this connection tools/list; source or dist changes do not update an existing process.' },
      },
    },
  }, {
    allowDuringWorkspaceRecovery: true,
    validate: (args, context) => {
      if (args.toolName !== undefined && !context.tools.some(tool => tool.name === args.toolName))
        throw new Error(`Tool is not registered in this instance: ${args.toolName}`);
    },
    execute: async (args, { router, tools, schemaHash }) => {
      const selectedTool = tools.find(tool => tool.name === args.toolName);
      const health = await router.getRuntimeHealth();
      return jsonResult({
        status: health.status, message: args.greeting || 'Hello from WinCode MCP Gateway!',
        gateway: 'WinCode Agent Gateway', version: WINCODE_VERSION, runtime: RUNTIME_IDENTITY,
        toolContract: { schemaHash, toolCount: tools.length,
          ...(selectedTool ? { tool: { name: selectedTool.name, inputSchema: selectedTool.inputSchema,
            schemaHash: contractHash(selectedTool.inputSchema) } } : {}) },
        platform: process.platform, workspace: router.config.workspaceRoot, timestamp: new Date().toISOString(), health,
        codeProvider: health.codeProvider,
        adapters: {
          ...(health.roslyn ? { roslyn: health.roslyn } : {}),
          text: { available: true, source: 'local-text', details: health.text.details },
          repomix: { available: health.repomix.available, source: health.repomix.source, details: health.repomix.details },
          flaui: { available: health.flaui.available, source: health.flaui.source, details: health.flaui.details },
        }, capabilities: tools.map(tool => tool.name),
      }, true);
    },
  }),
  defineTool<{ maxDepth?: number }>({
    name: 'wincode_analyze_workspace',
    description: 'Workspace overview from project files. For .NET, emits sln/csproj dependency graph and entry points. Directory folder names are hints only, not architecture judgments.',
    inputSchema: {
      type: 'object', additionalProperties: true,
      properties: {
        maxDepth: {
          type: 'number',
          description: 'Maximum directory tree depth to inspect (default 2)',
        },
      },
    },
  }, {
    execute: async (args, { router }) => jsonResult(await router.analyzeWorkspace(args.maxDepth), true),
  }),
  defineTool<Record<string, never>>({
    name: 'wincode_diagnose_project',
    description: 'Diagnoses project health, Windows/.NET SDK readiness, solution files, configured code provider/Repomix status, and a lightweight runtime snapshot. dotnet --version or a live Host does not prove complete semantic evidence.',
    inputSchema: {
      type: 'object', additionalProperties: true,
      properties: {},
    },
  }, {
    execute: async (_args, { router }) => jsonResult(await router.diagnoseProject(), true),
  }),
  defineTool<{ filePath: string; reason?: string }>({
    name: 'wincode_safe_move_to_trash',
    description: 'Safely moves an obsolete or deleted file into the project trash/ directory with metadata instead of permanent deletion.',
    inputSchema: {
      type: 'object', additionalProperties: true,
      properties: {
        filePath: {
          type: 'string', minLength: 1, pattern: '\\S',
          description: 'Non-empty relative path of the file within the current workspace to safely move to trash. Absolute paths and drive-relative paths (e.g., C:foo) are strictly rejected.',
        },
        reason: {
          type: 'string',
          description: 'Reason for removal.',
        },
      },
      required: ['filePath'],
    },
  }, {
    invalidArguments: message => jsonResult(invalidTrashResult(message), true, true),
    validate: (args, { router }) => validateTrashPath(args.filePath, router.config.workspaceRoot, router.config.trashDir),
    execute: async (args, { router }) => {
      const result = await router.moveToTrash(args.filePath, args.reason);
      return jsonResult(result, true, !result.success);
    },
  }),
];
