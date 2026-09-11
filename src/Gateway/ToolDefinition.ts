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
  workspaceControl?: boolean;
  allowDuringWorkspaceRecovery?: boolean;
  requestLane?: 'status';
  requestBudget?: 'ui' | 'diagnostics' | 'workspace';
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

/** 错误文本和结构化载荷由同一次序列化生成，避免 undefined/可变对象导致两份证据不一致。 */
export function jsonResult(value: unknown, pretty = false, isError?: boolean): CallToolResult {
  if (isError && (value === null || typeof value !== 'object' || Array.isArray(value)))
    throw new TypeError('Tool error payload must be a JSON object.');
  const text = JSON.stringify(value, null, pretty ? 2 : undefined);
  return { content: [{ type: 'text', text }],
    ...(isError ? { structuredContent: JSON.parse(text) } : {}),
    ...(isError === undefined ? {} : { isError }) };
}

/** Gateway 抛出型错误的公共形状；provider 表示报告边界，不猜测实际故障的上游。 */
export function toolErrorResult(errorCode: string, errorMessage: string,
  recoveryAction = 'inspect_error', details: Record<string, unknown> = {}): CallToolResult {
  return jsonResult({ ...details, success: false, errorCode, errorMessage,
    provider: 'wincode', recoveryAction }, false, true);
}

/** 恢复动作只由稳定错误码决定；未知错误须检查，不从消息文字推断、也不自动重放请求。 */
export function codeRecoveryAction(code: string): string {
  switch (code) {
    case 'SNAPSHOT_STALE': case 'INPUTS_CHANGED': case 'LEGACY_SYMBOL_ID': case 'SYMBOL_MISMATCH': return 'search_again';
    case 'HOST_RESTART_REQUIRED': return 'workspace_open';
    case 'UNSUPPORTED_SYMBOL_LOCATION': return 'configure_roslyn';
    case 'HOST_VERSION_MISMATCH': case 'HOST_PROTOCOL_ERROR': return 'check_installation';
    case 'HOST_UNAVAILABLE': case 'PROJECT_EVALUATION_DENIED': return 'check_configuration';
    case 'PROJECT_LOAD_FAILED': return 'check_project';
    case 'INPUT_UNAVAILABLE': return 'repair_inputs';
    case 'INPUT_BUDGET_EXCEEDED': return 'reduce_scope';
    case 'OUTSIDE_WORKSPACE': case 'UNSUPPORTED_LINK': return 'correct_arguments';
    case 'CANCELLED': return 'none';
    default: return 'inspect_error';
  }
}
