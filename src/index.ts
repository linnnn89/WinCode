#!/usr/bin/env node

import { getDefaultConfig, WINCODE_VERSION } from './Core/Config.js';
import { ToolRouter } from './Core/ToolRouter.js';
import { WinCodeMcpServer } from './Gateway/McpServer.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveTrayEndpoint, TrayClient } from './Gateway/TrayClient.js';

async function main() {
  let workspaceRoot = process.cwd();
  let workspaceRootSource: 'argument' | 'cwd' = 'cwd';
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--workspace' || args[i] === '-w') {
      const target = args[++i];
      if (!target || !path.isAbsolute(target)) throw new Error('--workspace requires an absolute directory path.');
      workspaceRoot = target;
      workspaceRootSource = 'argument';
    }
  }

  const config = getDefaultConfig(workspaceRoot);
  config.workspaceRootSource = workspaceRootSource;
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
  let shutdownPromise: Promise<void> | undefined;
  let tray: TrayClient | undefined;
  const shutdown = (signal: string, exitCode = 0): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    tray?.dispose();
    shutdownPromise = (async () => {
      console.error(`[WinCode Gateway] ${signal}: shutting down...`);
      const force = setTimeout(() => {
        console.error('[WinCode Gateway] Shutdown timed out; exiting.');
        process.exit(1);
      }, config.timeouts.shutdownMs);
      force.unref();
      try {
        await server.stop();
        process.exit(exitCode);
      } catch (err) {
        console.error('[WinCode Gateway] Error during shutdown:', err);
        process.exit(1);
      }
    })();
    return shutdownPromise;
  };

  server.onDisconnect = () => { void shutdown('transport closed'); };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.stdin.once('end', () => { void shutdown('stdin EOF'); });
  process.stdin.once('close', () => { void shutdown('stdin closed'); });
  process.stdin.once('error', () => { void shutdown('stdin error'); });
  process.stdout.once('error', () => { void shutdown('stdout error'); });
  // The client may close its diagnostic pipe too; logging must not recursively crash shutdown.
  process.stderr.on('error', () => {});
  process.on('uncaughtException', (err) => {
    console.error('[WinCode Gateway] Uncaught exception:', err);
    void shutdown('uncaughtException', 1);
  });
  process.on('unhandledRejection', (err) => {
    console.error('[WinCode Gateway] Unhandled rejection:', err);
    void shutdown('unhandledRejection', 1);
  });

  try {
    await server.start();
    if (args.includes('--tray') && !shuttingDown) {
      // 可选界面不可延迟 MCP 就绪或导致 Gateway 退出；解析过程受同一 shutdown signal 约束。
      void resolveTrayEndpoint(router.shutdownSignal).then(pipe => {
        if (shuttingDown) return;
        tray = new TrayClient(pipe, router, () => { void shutdown('settings requested stop'); });
        tray.start();
      }).catch(error => { if (!shuttingDown) console.error(`[WinCode Tray] ${error.message}; MCP continues without Tray integration.`); });
    }
    console.error(`[WinCode Gateway] v${WINCODE_VERSION} ready.`);
  } catch (err) {
    if (shuttingDown) { await shutdownPromise; return; }
    console.error('[WinCode Gateway] Fatal error starting server:', err);
    await shutdown('startup failed', 1);
  }
}

main().catch((err) => {
  console.error('[WinCode Gateway] Unhandled rejection during bootstrap:', err);
  process.exit(1);
});
