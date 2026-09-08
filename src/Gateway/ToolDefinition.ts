import type { CallToolResult, Tool } from '@modelcontextprotocol/server';
import type { ToolRouter } from '../Core/ToolRouter.js';

export interface ToolExecutionContext {
  router: ToolRouter;
  signal?: AbortSignal;
  tools: Tool[];
  schemaHash: string;
}

export interface ToolDefinition {
  tool: Tool;
  aliases?: Array<{ name: string; listed: boolean; description?: string }>;
  switchesWorkspace?: boolean;
  invalidArguments?: (message: string) => CallToolResult;
  validate?: (args: Record<string, unknown>, context: ToolExecutionContext) => void;
  execute: (args: Record<string, unknown>, context: ToolExecutionContext) => Promise<CallToolResult>;
}

/** Types are asserted only after the registry validates the declared JSON schema. */
export function defineTool<T extends object>(tool: Tool, behavior: Omit<ToolDefinition, 'tool' | 'validate' | 'execute'> & {
  validate?: (args: T, context: ToolExecutionContext) => void;
  execute: (args: T, context: ToolExecutionContext) => Promise<CallToolResult>;
}): ToolDefinition {
  return { ...behavior, tool,
    validate: behavior.validate && ((args, context) => behavior.validate!(args as T, context)),
    execute: (args, context) => behavior.execute(args as T, context) };
}

export function jsonResult(value: unknown, pretty = false, isError?: boolean): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, pretty ? 2 : undefined) }],
    ...(isError === undefined ? {} : { isError }) };
}
