import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { ToolRouter } from '../Core/ToolRouter.js';
import { WINCODE_TOOLS } from './Protocol.js';
import { WINCODE_VERSION } from '../Core/Config.js';

export class WinCodeMcpServer {
  private server: Server;
  private router: ToolRouter;
  private stopPromise: Promise<void> | null = null;

  constructor(router: ToolRouter) {
    this.router = router;
    this.server = new Server(
      {
        name: 'wincode-agent-gateway',
        version: WINCODE_VERSION,
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.registerHandlers();
  }

  private registerHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return { tools: WINCODE_TOOLS };
    });

    // Call tool
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args = {} } = request.params;

      if (this.router.isShuttingDown) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: 'failed',
                  reason: 'cancelled',
                  provider: 'wincode',
                  recoverable: false,
                  message: 'WinCode is shutting down; tool call rejected.',
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }

      const isSwitchOp = name === 'workspace_open' || name === 'wincode_workspace_open';
      if (!isSwitchOp) {
        await this.router.acquireRequestSlot();
      }
      try {
        switch (name) {
          case 'workspace_open':
          case 'wincode_workspace_open': {
            const targetPath = String(args.path || '');
            if (!targetPath) {
              throw new Error('Parameter "path" is required for workspace_open.');
            }
            const result = await this.router.openWorkspace(targetPath);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          case 'wincode_hello_world': {
            const greeting = args.greeting ? String(args.greeting) : 'Hello from WinCode MCP Gateway!';
            const health = await this.router.getRuntimeHealth();
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      status: health.status,
                      message: greeting,
                      gateway: 'WinCode Agent Gateway',
                      version: WINCODE_VERSION,
                      platform: process.platform,
                      workspace: this.router.config.workspaceRoot,
                      timestamp: new Date().toISOString(),
                      health,
                      adapters: {
                        serena: {
                          available: true,
                          source: health.serena.handshakeOk ? 'installed' : 'fallback',
                          details: `commandFound=${health.serena.commandFound}; handshakeOk=${health.serena.handshakeOk}; projectActive=${health.serena.projectActive === null ? 'unprobed' : health.serena.projectActive}; semanticQueryUsable=${health.serena.semanticQueryUsable}; mode=${health.serena.mode}`,
                          upstream: {
                            commandFound: health.serena.commandFound,
                            handshakeOk: health.serena.handshakeOk,
                            projectActive: health.serena.projectActive,
                            semanticQueryUsable: health.serena.semanticQueryUsable,
                            mode: health.serena.mode,
                          },
                        },
                        repomix: {
                          available: health.repomix.available,
                          source: health.repomix.source,
                          details: health.repomix.details,
                        },
                      },
                      capabilities: [
                        'wincode_hello_world',
                        'wincode_analyze_workspace',
                        'wincode_prepare_context',
                        'wincode_find_code_symbol',
                        'wincode_find_references',
                        'wincode_analyze_change_impact',
                        'wincode_diagnose_project',
                        'wincode_plan_refactoring',
                        'wincode_safe_move_to_trash',
                      ],
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }

          case 'wincode_analyze_workspace': {
            const maxDepth = typeof args.maxDepth === 'number' ? args.maxDepth : 2;
            const report = await this.router.architecture.analyze(maxDepth);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(report, null, 2),
                },
              ],
            };
          }

          case 'wincode_prepare_context': {
            const task = String(args.task || 'Analyze workspace architecture and structure');
            const candidateFiles = Array.isArray(args.candidateFiles)
              ? (args.candidateFiles as string[])
              : undefined;
            const focusAreas = Array.isArray(args.focusAreas)
              ? (args.focusAreas as string[])
              : undefined;
            const compress = typeof args.compress === 'boolean' ? args.compress : undefined;
            const outputFormat = args.outputFormat === 'xml' ? 'xml' : 'markdown';
            const includeFullText = typeof args.includeFullText === 'boolean' ? args.includeFullText : false;
            const maxTokens = typeof args.maxTokens === 'number' ? args.maxTokens : undefined;

            const context = await this.router.context.prepareContext({
              task,
              candidateFiles,
              focusAreas,
              compress,
              outputFormat,
              includeFullText,
              maxTokens,
            });

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      task: context.task,
                      project: context.project,
                      metrics: context.metrics,
                      guidance: context.guidance,
                      executiveSummary: context.executiveSummary,
                      evidence: context.evidence,
                      relatedFiles: context.relatedFiles,
                      omittedFiles: context.omittedFiles,
                      evidenceInsufficient: context.evidenceInsufficient,
                      limitations: context.limitations,
                    },
                    null,
                    2
                  ),
                },
                {
                  type: 'text',
                  text: context.formattedContent,
                },
              ],
            };
          }

          case 'wincode_find_code_symbol': {
            const query = String(args.query || '');
            const kind = args.kind ? String(args.kind) : undefined;
            const result = await this.router.serena.findSymbolsDetailed(query, kind);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          case 'wincode_find_references': {
            const symbolName = String(args.symbolName || '');
            const relativePath = args.relativePath ? String(args.relativePath) : undefined;
            const result = await this.router.serena.findReferencesDetailed(symbolName, relativePath);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          case 'analyze_change_impact':
          case 'wincode_analyze_change_impact': {
            const target = String(args.target || '');
            if (!target) {
              throw new Error('Parameter "target" is required for analyze_change_impact.');
            }
            const impact = await this.router.impact.analyzeImpact(target);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(impact, null, 2),
                },
                {
                  type: 'text',
                  text: impact.formattedReport,
                },
              ],
            };
          }

          case 'wincode_diagnose_project': {
            const diagnostics = await this.router.diagnostics.runDiagnostics();
            const runtime = await this.router.getRuntimeHealth();
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ ...diagnostics, runtime }, null, 2),
                },
              ],
            };
          }

          case 'wincode_plan_refactoring': {
            const target = String(args.target || '');
            const goal = String(args.goal || '');
            const plan = await this.router.refactor.planRefactoring(target, goal);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(plan, null, 2),
                },
              ],
            };
          }

          case 'wincode_safe_move_to_trash': {
            const filePath = String(args.filePath || '');
            const reason = args.reason ? String(args.reason) : undefined;
            const result = await this.router.workspace.moveToTrash(filePath, reason);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2),
                },
              ],
              isError: !result.success,
            };
          }

          default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
      } catch (err: any) {
        return {
          content: [
            {
              type: 'text',
              text: `Tool Execution Error: ${err?.message || String(err)}`,
            },
          ],
          isError: true,
        };
      } finally {
        if (!isSwitchOp) {
          this.router.endRequest();
        }
      }
    });
  }

  async start(): Promise<void> {
    await this.router.initialize();
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error(`[WinCode Gateway] MCP Server ${WINCODE_VERSION} running on stdio transport.`);
  }

  /**
   * Idempotent graceful shutdown. Concurrent stop() callers share one promise.
   * In-flight tool calls are given a short drain window, then adapters and
   * child processes are disposed. server.close() errors are swallowed.
   */
  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopOnce();
    try {
      await this.stopPromise;
    } finally {
      this.stopPromise = Promise.resolve();
    }
  }

  private async stopOnce(): Promise<void> {
    try {
      await this.router.dispose();
    } catch (err) {
      console.error('[WinCode Gateway] Error disposing router:', err);
    }
    try {
      await this.server.close();
    } catch {
      // transport may already be gone (stdin closed by host)
    }
  }
}
