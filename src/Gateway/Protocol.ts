import { Tool } from '@modelcontextprotocol/sdk/types.js';

export const WINCODE_TOOLS: Tool[] = [
  {
    name: 'wincode_hello_world',
    description: 'Minimal connectivity and heartbeat verification tool for AI coding agents (Codex, Claude, etc.). Confirms WinCode Gateway is online.',
    inputSchema: {
      type: 'object',
      properties: {
        greeting: {
          type: 'string',
          description: 'Optional custom greeting message to echo back.',
        },
      },
    },
  },
  {
    name: 'wincode_analyze_workspace',
    description: 'High-level workspace and architecture analysis. Detects project types, .NET solutions, architecture layers, and key entry points without dumping raw files.',
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
    description: 'Prepares concise, high-semantic, decision-ready context for an agent task. Extracts relevant symbols and packs only essential files to minimize tokens.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Description of the coding task or query the agent is working on.',
        },
        candidateFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of candidate file paths to prioritize.',
        },
      },
      required: ['task'],
    },
  },
  {
    name: 'wincode_find_code_symbol',
    description: 'Locates code symbols (classes, interfaces, methods, functions) across the workspace with signatures and line numbers (powered by Serena code intelligence).',
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
    description: 'Finds all call sites and usages of a specified symbol across the repository.',
    inputSchema: {
      type: 'object',
      properties: {
        symbolName: {
          type: 'string',
          description: 'Exact name of the symbol to trace.',
        },
      },
      required: ['symbolName'],
    },
  },
  {
    name: 'wincode_analyze_change_impact',
    description: 'Analyzes the downstream blast radius, coupling, and risk level before modifying or refactoring a symbol/component.',
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
    description: 'Diagnoses project health, Windows/.NET SDK readiness, solution files, and development prerequisites.',
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
          description: 'Relative or absolute path of the file to move to trash.',
        },
        reason: {
          type: 'string',
          description: 'Reason for removal.',
        },
      },
      required: ['filePath'],
    },
  },
];
