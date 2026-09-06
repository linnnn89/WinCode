#!/usr/bin/env node

import { getDefaultConfig } from './Core/Config.js';
import { ToolRouter } from './Core/ToolRouter.js';
import { WinCodeMcpServer } from './Gateway/McpServer.js';

async function main() {
  // Parse optional workspace path from args
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

  const shutdown = async () => {
    console.error('[WinCode Gateway] Shutting down...');
    await server.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await server.start();
  } catch (err) {
    console.error('[WinCode Gateway] Fatal error starting server:', err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[WinCode Gateway] Unhandled rejection:', err);
  process.exit(1);
});
