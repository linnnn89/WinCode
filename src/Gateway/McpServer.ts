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
import { AbortError } from '../Core/ResourceManager.js';
import { UI_INSPECT_DEFAULTS, validateUiQuery, UiQuery, validateWindowQuery, UiListWindowsRequest } from '../Core/UiContracts.js';
import { validateCandidateFiles } from '../Core/UiSourceMapper.js';
import { validateTextQueries } from '../Core/UiTextSearch.js';
import { UiReviewResult } from '../CompositeTools/UiReview.js';
import { validateContextOptions } from '../Core/Context.js';
import { contextResponse } from './ContextResponse.js';

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
    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name, arguments: args = {} } = request.params;
      const signal = extra?.signal;

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

      if (signal?.aborted) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: 'failed',
                  reason: 'cancelled',
                  provider: 'wincode',
                  recoverable: true,
                  message: 'Tool call was cancelled.',
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
      let acquired = false;
      try {
        if (!isSwitchOp) {
          await this.router.acquireRequestSlot(signal);
          acquired = true;
        }
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
                        flaui: {
                          available: health.flaui.available,
                          source: health.flaui.source,
                          details: health.flaui.details,
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
                        'wincode_ui_inspect',
                        'wincode_ui_list_windows',
                        'wincode_ui_review',
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
            validateContextOptions(args);
            const context = await this.router.context.prepareContext(args);

            return contextResponse(context, args.responseFormat);
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

          case 'wincode_ui_list_windows': {
            try {
              if (Object.keys(args).some(key => !['pid', 'processName', 'titleContains', 'maxWindows'].includes(key)))
                throw new Error('Unknown window query argument.');
              validateWindowQuery(args as UiListWindowsRequest);
            } catch (error) {
              return { content: [{ type: 'text', text: JSON.stringify({ success: false,
                errorCode: 'INVALID_ARGUMENT', errorMessage: (error as Error).message }) }], isError: true };
            }
            const result = await this.router.listUiWindows(args as UiListWindowsRequest, signal);
            const text = JSON.stringify(result);
            if (Buffer.byteLength(text, 'utf8') > UI_INSPECT_DEFAULTS.MAX_TEXT_JSON_BYTES)
              return { content: [{ type: 'text', text: JSON.stringify({ success: false,
                errorCode: 'PAYLOAD_TOO_LARGE', errorMessage: 'Window list exceeds text budget.', auditNotice: result.auditNotice }) }], isError: true };
            return { content: [{ type: 'text', text }], isError: !result.success };
          }

          case 'wincode_ui_review':
          case 'wincode_ui_inspect': {
            try { validateUiQuery(args.query, args.readStates); }
            catch (error) { return {content: [{type: 'text', text: JSON.stringify({success:false, errorCode:'INVALID_ARGUMENT', errorMessage:(error as Error).message})}], isError:true}; }
            if ((args.backgroundOnly !== undefined && typeof args.backgroundOnly !== 'boolean') ||
                (args.backgroundOnly === true && (!args.pid || !args.hwnd))) {
              return { content: [{ type: 'text', text: JSON.stringify({ success: false,
                errorCode: 'INVALID_ARGUMENT', errorMessage: 'backgroundOnly requires explicit pid and hwnd.' }) }], isError: true };
            }
            if (name === 'wincode_ui_review') {
              try { validateCandidateFiles(args.candidateFiles); validateTextQueries(args.textQueries); }
              catch (error) {
                return { content: [{ type: 'text', text: JSON.stringify({ success: false,
                  errorCode: 'INVALID_ARGUMENT', errorMessage: (error as Error).message }) }], isError: true };
              }
            }
            let pid: number | undefined;
            if (args.pid !== undefined && args.pid !== null) {
              const parsed = Number(args.pid);
              if (!Number.isInteger(parsed) || parsed <= 0) {
                return {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify(
                        {
                          schemaVersion: '1.0',
                          protocolVersion: '1.0',
                          success: false,
                          errorCode: 'INVALID_ARGUMENT',
                          errorMessage: `Invalid "pid": must be a positive integer, received ${args.pid}`,
                        },
                        null,
                        2
                      ),
                    },
                  ],
                  isError: true,
                };
              }
              pid = parsed;
            }

            let hwnd: string | undefined;
            if (args.hwnd !== undefined && args.hwnd !== null) {
              const str = String(args.hwnd).trim();
              if (!str) {
                return {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify(
                        {
                          schemaVersion: '1.0',
                          protocolVersion: '1.0',
                          success: false,
                          errorCode: 'INVALID_ARGUMENT',
                          errorMessage: 'Invalid "hwnd": must be a non-empty string.',
                        },
                        null,
                        2
                      ),
                    },
                  ],
                  isError: true,
                };
              }
              hwnd = str;
            }

            if (!pid && !hwnd) {
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify(
                      {
                        schemaVersion: '1.0',
                        protocolVersion: '1.0',
                        success: false,
                        errorCode: 'INVALID_ARGUMENT',
                        errorMessage: 'Either "pid" or "hwnd" must be provided for UI inspection.',
                      },
                      null,
                      2
                    ),
                  },
                ],
                isError: true,
              };
            }

            let capture: 'none' | 'original' | 'annotated' | undefined;
            if (args.capture !== undefined && args.capture !== null) {
              const captureStr = String(args.capture);
              if (!['none', 'original', 'annotated'].includes(captureStr)) {
                return {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify(
                        {
                          schemaVersion: '1.0',
                          protocolVersion: '1.0',
                          success: false,
                          errorCode: 'INVALID_ARGUMENT',
                          errorMessage: `Invalid "capture": must be one of "none", "original", "annotated", received "${args.capture}".`,
                        },
                        null,
                        2
                      ),
                    },
                  ],
                  isError: true,
                };
              }
              capture = captureStr as 'none' | 'original' | 'annotated';
            }

            let maxDepth: number | undefined;
            if (args.maxDepth !== undefined && args.maxDepth !== null) {
              const parsed = Number(args.maxDepth);
              if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
                return {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify(
                        {
                          schemaVersion: '1.0',
                          protocolVersion: '1.0',
                          success: false,
                          errorCode: 'INVALID_ARGUMENT',
                          errorMessage: `Invalid "maxDepth": must be an integer between 1 and 50, received ${args.maxDepth}.`,
                        },
                        null,
                        2
                      ),
                    },
                  ],
                  isError: true,
                };
              }
              maxDepth = parsed;
            }

            let maxNodes: number | undefined;
            if (args.maxNodes !== undefined && args.maxNodes !== null) {
              const parsed = Number(args.maxNodes);
              if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5000) {
                return {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify(
                        {
                          schemaVersion: '1.0',
                          protocolVersion: '1.0',
                          success: false,
                          errorCode: 'INVALID_ARGUMENT',
                          errorMessage: `Invalid "maxNodes": must be an integer between 1 and 5000, received ${args.maxNodes}.`,
                        },
                        null,
                        2
                      ),
                    },
                  ],
                  isError: true,
                };
              }
              maxNodes = parsed;
            }

            const inspect = name === 'wincode_ui_review'
              ? (input: Parameters<ToolRouter['inspectUi']>[0], abort?: AbortSignal) =>
                this.router.reviewUi(input, args.candidateFiles as string[], abort, args.textQueries as string[] | undefined)
              : this.router.inspectUi.bind(this.router);
            const result: UiReviewResult = await inspect(
              {
                pid,
                hwnd,
                capture,
                query: args.query as UiQuery | undefined,
                readStates: args.readStates as boolean | undefined,
                backgroundOnly: args.backgroundOnly as boolean | undefined,
                maxDepth,
                maxNodes,
              },
              signal
            );

            // Extract image data for MCP image block; omit base64 payload from text JSON
            const imageBase64 = result.annotatedPngBase64 || result.screenshotPngBase64;
            const {
              annotatedPngBase64: _omittedAnnotated,
              screenshotPngBase64: _omittedScreenshot,
              ...cleanResult
            } = result;

            const textPayload = {
              ...cleanResult,
              hasScreenshot: Boolean(imageBase64),
            };
            let text = JSON.stringify(textPayload);
            // Optional keyword hits spend only spare budget; keep existing ID evidence and UI first.
            while (Buffer.byteLength(text, 'utf8') > UI_INSPECT_DEFAULTS.MAX_TEXT_JSON_BYTES &&
              textPayload.sourceEvidence?.textSearch?.matches.length) {
              textPayload.sourceEvidence.textSearch.matches.pop();
              textPayload.sourceEvidence.textSearch.truncated = true;
              text = JSON.stringify(textPayload);
            }
            if (Buffer.byteLength(text, 'utf8') > UI_INSPECT_DEFAULTS.MAX_TEXT_JSON_BYTES && textPayload.sourceEvidence?.textSearch) {
              delete textPayload.sourceEvidence.textSearch;
              textPayload.sourceEvidence.truncated = true;
              text = JSON.stringify(textPayload);
            }
            // Spend only the unused text budget on source candidates. Never trim the UI tree
            // here: the existing screenshot badges must continue to reference its retained nodes.
            while (Buffer.byteLength(text, 'utf8') > UI_INSPECT_DEFAULTS.MAX_TEXT_JSON_BYTES &&
              textPayload.sourceEvidence?.nodes.length) {
              textPayload.sourceEvidence.nodes.pop();
              textPayload.sourceEvidence.truncated = true;
              textPayload.sourceEvidence.coverage.returnedNodes = textPayload.sourceEvidence.nodes.length;
              text = JSON.stringify(textPayload);
            }
            if (Buffer.byteLength(text, 'utf8') > UI_INSPECT_DEFAULTS.MAX_TEXT_JSON_BYTES && textPayload.sourceEvidence) {
              delete textPayload.sourceEvidence;
              textPayload.sourceEvidenceOmitted = 'Source evidence exceeds remaining text budget.';
              text = JSON.stringify(textPayload);
            }
            if (Buffer.byteLength(text, 'utf8') > UI_INSPECT_DEFAULTS.MAX_TEXT_JSON_BYTES && textPayload.sourceEvidenceOmitted) {
              // A baseline snapshot can occupy the entire budget: even the omission notice is optional.
              delete textPayload.sourceEvidenceOmitted;
              text = JSON.stringify(textPayload);
            }
            if (Buffer.byteLength(text, 'utf8') > UI_INSPECT_DEFAULTS.MAX_TEXT_JSON_BYTES) {
              // A malformed/custom helper must not bypass the final MCP budget.
              return {
                content: [{ type: 'text' as const, text: JSON.stringify({
                  success: false, errorCode: 'PAYLOAD_TOO_LARGE',
                  errorMessage: 'UI text response exceeds 128 KiB.',
                  auditNotice: result.auditNotice,
                  imageOmitted: true, hasScreenshot: false,
                }) }],
                isError: true,
              };
            }

            const content: Array<
              | { type: 'text'; text: string }
              | { type: 'image'; data: string; mimeType: string }
            > = [
              {
                type: 'text',
                text,
              },
            ];

            if (imageBase64) {
              content.push({
                type: 'image',
                data: imageBase64,
                mimeType: 'image/png',
              });
            }

            return {
              content,
              isError: !result.success,
            };
          }

          default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
      } catch (err: any) {
        if (err instanceof AbortError || err?.name === 'AbortError' || signal?.aborted) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    schemaVersion: '1.0',
                    protocolVersion: '1.0',
                    success: false,
                    errorCode: 'CANCELLED',
                    errorMessage: 'Tool call was cancelled.',
                  },
                  null,
                  2
                ),
              },
            ],
            isError: true,
          };
        }
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
        if (acquired) {
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
