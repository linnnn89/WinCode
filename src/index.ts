#!/usr/bin/env node

import { getDefaultConfig, WINCODE_VERSION } from './Core/Config.js';
import { ToolRouter } from './Core/ToolRouter.js';
import { WinCodeMcpServer } from './Gateway/McpServer.js';
import fs from 'node:fs/promises';
import path from 'node:path';

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
  // 此文件是用户显式选择的启动配置，不从目标仓库自动发现或接受 MCP 参数指定执行程序。
  const roslynIndex = args.indexOf('--roslyn-config');
  if (roslynIndex >= 0) {
    const file = args[roslynIndex + 1];
    if (!file || !path.isAbsolute(file)) throw new Error('--roslyn-config requires an absolute JSON file path.');
    const handle = await fs.open(file, 'r');
    try {
      const buffer = Buffer.alloc(16385);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 16384) throw new Error('Roslyn configuration exceeds 16 KiB.');
      const options = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
      if (options?.enabled !== true) throw new Error('Explicit Roslyn configuration must set enabled=true.');
      config.adapters.roslyn = options;
    } finally { await handle.close(); }
  }
  if (args.includes('--development')) config.adapters.flaui.hostMode = 'development';
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
