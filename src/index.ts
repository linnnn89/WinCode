#!/usr/bin/env node

import { getDefaultConfig, WINCODE_VERSION } from './Core/Config.js';
import { ToolRouter } from './Core/ToolRouter.js';
import { WinCodeMcpServer } from './Gateway/McpServer.js';

async function main() {
  let workspaceRoot = process.cwd();
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--workspace' || args[i] === '-w') {
      if (args[i + 1]) {
        workspaceRoot = args[i + 1];
        i++;
      }
    }
  }

  const config = getDefaultConfig(workspaceRoot);
  const router = new ToolRouter(config);
  const server = new WinCodeMcpServer(router);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[WinCode Gateway] ${signal}: shutting down...`);
    const force = setTimeout(() => {
      console.error('[WinCode Gateway] Shutdown timed out; exiting.');
      process.exit(1);
    }, config.timeouts.shutdownMs);
    force.unref();
    try {
      await server.stop();
      process.exit(0);
    } catch (err) {
      console.error('[WinCode Gateway] Error during shutdown:', err);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('uncaughtException', (err) => {
    console.error('[WinCode Gateway] Uncaught exception (gateway stays up unless shutdown fails):', err);
  });
  process.on('unhandledRejection', (err) => {
    console.error('[WinCode Gateway] Unhandled rejection (gateway stays up):', err);
  });

  try {
    await server.start();
    console.error(`[WinCode Gateway] v${WINCODE_VERSION} ready.`);
  } catch (err) {
    console.error('[WinCode Gateway] Fatal error starting server:', err);
    await server.stop().catch(() => {});
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[WinCode Gateway] Unhandled rejection during bootstrap:', err);
  process.exit(1);
});
