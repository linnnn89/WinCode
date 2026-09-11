import { Server, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { ToolRouter, WorkspaceRecoveryRequiredError } from '../Core/ToolRouter.js';
import { WINCODE_VERSION } from '../Core/Config.js';
import { AbortError, TimeoutError } from '../Core/ResourceManager.js';
import { ADMISSION_LIMITS, RequestLease, ServerBusyError } from '../Core/RequestAdmission.js';
import { checkOperation } from '../Core/OperationContext.js';
import { CodeQueryError } from '../Core/CodeQueries.js';
import { WorkspaceMismatchError } from '../Core/WorkspaceContracts.js';
import { connectionGuide } from './ConnectionGuide.js';
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
    this.server.setRequestHandler('tools/list', async (_request, ctx) => {
      let lease: RequestLease | undefined;
      try {
        const signal = ctx.mcpReq.signal ? AbortSignal.any([ctx.mcpReq.signal, this.router.shutdownSignal]) : this.router.shutdownSignal;
        lease = this.router.admission.acquire('status', signal, this.router.config.timeouts.commandProbeMs);
        return { tools: this.registry.list() };
      } catch (error) {
        if (error instanceof ServerBusyError) throw new ProtocolError(ProtocolErrorCode.InternalError, error.message,
          { errorCode: 'SERVER_BUSY', workStarted: false, retryable: true, admission: error.admission });
        throw error;
      } finally { lease?.release(); }
    });
    this.server.setRequestHandler('tools/call', async (request, ctx) => {
      const { name, arguments: input = {} } = request.params;
      let signal = ctx.mcpReq.signal ? AbortSignal.any([ctx.mcpReq.signal, this.router.shutdownSignal]) : this.router.shutdownSignal;
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
        const argumentBytes = Buffer.byteLength(JSON.stringify(input), 'utf8');
        if (argumentBytes > ADMISSION_LIMITS.argumentBytes) return toolErrorResult('INVALID_ARGUMENT',
          'Tool arguments exceed the UTF-8 serialization budget; reduce the input.', 'correct_arguments',
          { argumentBytes, maxArgumentBytes: ADMISSION_LIMITS.argumentBytes });
        args = this.registry.prepare(name, input, context);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return definition.invalidArguments?.(message) ?? toolErrorResult('INVALID_ARGUMENT', message, 'correct_arguments');
      }
      let acquired = false;
      let lease: RequestLease | undefined;
      let failure: unknown;
      try {
        if (definition.workspaceControl) this.router.assertWorkspace(args.path as string);
        const lane = definition.requestLane ?? 'business';
        lease = this.router.admission.acquire(lane, signal, lane === 'status'
          ? this.router.config.timeouts.commandProbeMs : this.router.requestBudget(definition.requestBudget, args));
        signal = lease.signal; context.signal = signal;
        if (lane !== 'status' && this.startPromise) await this.router.admission.waitFor(this.startPromise, lease);
        if (lane !== 'status' && !definition.workspaceControl) {
          await this.router.acquireRequestSlot(signal, definition.allowDuringWorkspaceRecovery);
          acquired = true;
        }
        checkOperation(lease.operation);
        lease.workStarted = true;
        const result = await definition.execute(args, context);
        checkOperation(lease.operation);
        return result;
      } catch (error) {
        failure = error;
        if (error instanceof ServerBusyError) return toolErrorResult('SERVER_BUSY', error.message, 'retry_later',
          { workStarted: false, retryable: true, lane: error.lane, admission: error.admission });
        if (error instanceof WorkspaceMismatchError)
          return toolErrorResult(error.errorCode, error.message, 'select_workspace_connection',
            { activeWorkspace: error.activeWorkspace, requestedWorkspace: error.requestedWorkspace,
              connectionGuide: connectionGuide(error.requestedWorkspace) });
        // 同根恢复失败必须携带真实恢复状态；取消不能掩盖已发生的部分状态变更。
        const recovery = error instanceof WorkspaceRecoveryRequiredError ? error.recovery : this.router.workspaceRecoveryState;
        const details = recovery ? { workspaceRecovery: recovery } : {};
        if (signal.reason instanceof TimeoutError || error instanceof TimeoutError)
          return toolErrorResult('REQUEST_TIMEOUT', 'Tool request deadline exceeded, including queue wait.',
            recovery?.recoveryAction ?? 'inspect_error', { ...details, workStarted: lease?.workStarted ?? false, retryable: false });
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
        lease?.release(failure);
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
