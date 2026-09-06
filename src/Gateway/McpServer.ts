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

export class WinCodeMcpServer {
  private server: Server;
  private router: ToolRouter;

  constructor(router: ToolRouter) {
    this.router = router;
    this.server = new Server(
      {
        name: 'wincode-agent-gateway',
        version: '0.1.0',
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
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      status: 'online',
                      message: greeting,
                      gateway: 'WinCode Agent Gateway',
                      version: '0.1.0',
                      platform: process.platform,
                      workspace: this.router.config.workspaceRoot,
                      timestamp: new Date().toISOString(),
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
            const report = await this.router.architecture.analyze();
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
            const task = String(args.task || '');
            const candidateFiles = Array.isArray(args.candidateFiles)
              ? (args.candidateFiles as string[])
              : undefined;
            const context = await this.router.context.prepareContext(task, candidateFiles);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      summary: context.summary,
                      targetFiles: context.targetFiles,
                      keySymbols: context.keySymbols,
                      estimatedTokens: context.estimatedTokens,
                      contentSnippet: context.packedContent.slice(0, 2000) + (context.packedContent.length > 2000 ? '\n...[truncated in json preview]' : ''),
                    },
                    null,
                    2
                  ),
                },
                {
                  type: 'text',
                  text: context.packedContent,
                },
              ],
            };
          }

          case 'wincode_find_code_symbol': {
            const query = String(args.query || '');
            const kind = args.kind ? String(args.kind) : undefined;
            const symbols = await this.router.serena.findSymbols(query, kind);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(symbols, null, 2),
                },
              ],
            };
          }

          case 'wincode_find_references': {
            const symbolName = String(args.symbolName || '');
            const refs = await this.router.serena.findReferences(symbolName);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(refs, null, 2),
                },
              ],
            };
          }

          case 'wincode_analyze_change_impact': {
            const target = String(args.target || '');
            const impact = await this.router.impact.analyzeImpact(target);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(impact, null, 2),
                },
              ],
            };
          }

          case 'wincode_diagnose_project': {
            const diagnostics = await this.router.diagnostics.runDiagnostics();
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(diagnostics, null, 2),
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
      }
    });
  }

  async start(): Promise<void> {
    await this.router.initialize();
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('[WinCode Gateway] MCP Server running on stdio transport.');
  }

  async stop(): Promise<void> {
    await this.router.dispose();
    await this.server.close();
  }
}
