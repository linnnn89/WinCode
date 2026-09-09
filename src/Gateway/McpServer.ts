import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { ToolRouter, WorkspaceRecoveryRequiredError } from '../Core/ToolRouter.js';
import { WINCODE_VERSION } from '../Core/Config.js';
import { AbortError } from '../Core/ResourceManager.js';
import { CodeQueryError } from '../Core/CodeQueries.js';
import { ToolRegistry } from './ToolRegistry.js';
import { jsonResult, type ToolExecutionContext } from './ToolDefinition.js';

export class WinCodeMcpServer {
  private server: Server;
  private stopPromise: Promise<void> | null = null;
  private readonly registry = new ToolRegistry();

  constructor(private readonly router: ToolRouter) {
    this.server = new Server({ name: 'wincode-agent-gateway', version: WINCODE_VERSION }, { capabilities: { tools: {} } });
    this.registerHandlers();
  }

  private registerHandlers(): void {
    this.server.setRequestHandler('tools/list', async () => ({ tools: this.registry.list() }));
    this.server.setRequestHandler('tools/call', async (request, ctx) => {
      const { name, arguments: input = {} } = request.params;
      const signal = ctx.mcpReq.signal;
      if (this.router.isShuttingDown || signal?.aborted) {
        return jsonResult({ status: 'failed', reason: 'cancelled', provider: 'wincode',
          recoverable: !this.router.isShuttingDown,
          message: this.router.isShuttingDown ? 'WinCode is shutting down; tool call rejected.' : 'Tool call was cancelled.' }, true, true);
      }
      const definition = this.registry.resolve(name);
      const context: ToolExecutionContext = { router: this.router, signal, tools: this.registry.list(), schemaHash: this.registry.schemaHash };
      let args: Record<string, unknown>;
      try {
        args = this.registry.prepare(name, input, context);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return definition?.invalidArguments?.(message) ??
          { content: [{ type: 'text' as const, text: `Tool Execution Error: ${message}` }], isError: true };
      }
      let acquired = false;
      try {
        if (!definition!.switchesWorkspace) {
          await this.router.acquireRequestSlot(signal, definition!.allowDuringWorkspaceRecovery);
          acquired = true;
        }
        return await definition!.execute(args, context);
      } catch (error) {
        if (error instanceof AbortError || (error instanceof Error && error.name === 'AbortError') || signal?.aborted) {
          return jsonResult({ schemaVersion: '1.0', protocolVersion: '1.0', success: false,
            errorCode: 'CANCELLED', errorMessage: 'Tool call was cancelled.',
            ...(this.router.workspaceRecoveryState ? { workspaceRecovery: this.router.workspaceRecoveryState } : {}) }, true, true);
        }
        if (error instanceof WorkspaceRecoveryRequiredError)
          return jsonResult({ success: false, errorCode: 'WORKSPACE_RECOVERY_REQUIRED',
            errorMessage: error.message, workspaceRecovery: error.recovery }, true, true);
        if (error instanceof CodeQueryError)
          return jsonResult({ success: false, errorCode: error.errorCode, errorMessage: error.message }, true, true);
        return { content: [{ type: 'text' as const, text: `Tool Execution Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      } finally {
        if (acquired) this.router.endRequest();
      }
    });
  }

  async start(): Promise<void> {
    await this.router.initialize();
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
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
