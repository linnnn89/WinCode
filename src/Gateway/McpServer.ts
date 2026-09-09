import { Server, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { ToolRouter, WorkspaceRecoveryRequiredError } from '../Core/ToolRouter.js';
import { WINCODE_VERSION } from '../Core/Config.js';
import { AbortError } from '../Core/ResourceManager.js';
import { CodeQueryError } from '../Core/CodeQueries.js';
import { ToolRegistry } from './ToolRegistry.js';
import { toolErrorResult, codeRecoveryAction, type ToolExecutionContext } from './ToolDefinition.js';

export class WinCodeMcpServer {
  private server: Server;
  private stopPromise: Promise<void> | null = null;
  private startPromise: Promise<void> | null = null;
  onDisconnect?: () => void;
  private readonly registry = new ToolRegistry();

  constructor(private readonly router: ToolRouter) {
    this.server = new Server({ name: 'wincode-agent-gateway', version: WINCODE_VERSION }, { capabilities: { tools: {} } });
    this.server.onclose = () => this.onDisconnect?.();
    this.registerHandlers();
  }

  private registerHandlers(): void {
    this.server.setRequestHandler('tools/list', async () => ({ tools: this.registry.list() }));
    this.server.setRequestHandler('tools/call', async (request, ctx) => {
      await this.startPromise?.catch(() => {});
      const { name, arguments: input = {} } = request.params;
      const signal = ctx.mcpReq.signal ? AbortSignal.any([ctx.mcpReq.signal, this.router.shutdownSignal]) : this.router.shutdownSignal;
      if (this.router.isShuttingDown || signal?.aborted) {
        return toolErrorResult(this.router.isShuttingDown ? 'SHUTDOWN' : 'CANCELLED',
          this.router.isShuttingDown ? 'WinCode is shutting down; tool call rejected.' : 'Tool call was cancelled.',
          this.router.isShuttingDown ? 'restart_gateway' : 'none');
      }
      const definition = this.registry.resolve(name);
      if (!definition) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool: ${name}`);
      const context: ToolExecutionContext = { router: this.router, signal, tools: this.registry.list(), schemaHash: this.registry.schemaHash };
      let args: Record<string, unknown>;
      try {
        args = this.registry.prepare(name, input, context);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return definition.invalidArguments?.(message) ?? toolErrorResult('INVALID_ARGUMENT', message, 'correct_arguments');
      }
      let acquired = false;
      try {
        if (!definition.switchesWorkspace) {
          await this.router.acquireRequestSlot(signal, definition.allowDuringWorkspaceRecovery);
          acquired = true;
        }
        return await definition.execute(args, context);
      } catch (error) {
        // 根变化后的失败必须携带真实恢复状态；取消不能掩盖已发生的部分状态变更。
        const recovery = error instanceof WorkspaceRecoveryRequiredError ? error.recovery : this.router.workspaceRecoveryState;
        const details = recovery ? { workspaceRecovery: recovery } : {};
        if (error instanceof AbortError || (error instanceof Error && error.name === 'AbortError') || signal?.aborted)
          return toolErrorResult('CANCELLED', 'Tool call was cancelled.', recovery?.recoveryAction ?? 'none', details);
        if (error instanceof WorkspaceRecoveryRequiredError)
          return toolErrorResult('WORKSPACE_RECOVERY_REQUIRED', error.message, error.recovery.recoveryAction, details);
        if (error instanceof CodeQueryError)
          return toolErrorResult(error.errorCode, error.message, recovery?.recoveryAction ?? codeRecoveryAction(error.errorCode), details);
        return toolErrorResult(this.router.isShuttingDown ? 'SHUTDOWN' : 'TOOL_EXECUTION_FAILED',
          error instanceof Error ? error.message : String(error),
          recovery?.recoveryAction ?? (this.router.isShuttingDown ? 'restart_gateway' : 'inspect_error'), details);
      } finally {
        if (acquired) this.router.endRequest();
      }
    });
  }

  start(): Promise<void> {
    this.startPromise ??= this.startOnce();
    return this.startPromise;
  }

  private async startOnce(): Promise<void> {
    // Connect first so EOF can cancel even a slow initialization; tool calls await startPromise.
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    await this.router.initialize();
    if (this.router.isShuttingDown) throw new AbortError('Gateway startup cancelled.');
    console.error(`[WinCode Gateway] MCP Server ${WINCODE_VERSION} running on stdio transport.`);
  }

  /** Concurrent stop callers share the existing shutdown path. */
  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopOnce();
    return this.stopPromise;
  }

  private async stopOnce(): Promise<void> {
    const failures: unknown[] = [];
    try { await this.router.dispose(); }
    catch (error) { failures.push(error); }
    try { await this.server.close(); }
    catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Gateway shutdown failed.');
  }
}
