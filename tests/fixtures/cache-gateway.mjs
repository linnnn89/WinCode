/** Real production Gateway with small fixture budgets; no extra MCP tools or alternate cache implementation. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { getDefaultConfig } from '../../dist/Core/Config.js';
import { ToolRouter } from '../../dist/Core/ToolRouter.js';
import { WinCodeMcpServer } from '../../dist/Gateway/McpServer.js';

const [workspace, sharedCache, receipt] = process.argv.slice(2);
if (![workspace, sharedCache, receipt].every(value => value && path.isAbsolute(value))) throw new Error('Absolute fixture paths required.');
const config = getDefaultConfig(workspace);
config.cacheDir = sharedCache;
config.adapters.flaui.enabled = false;
config.adapters.repomix.useCli = false;
Object.assign(config.cacheLimits, { maxEntryBytes: 8192, maxDiskEntries: 4, maxDiskBytes: 256 * 1024 });
const router = new ToolRouter(config), server = new WinCodeMcpServer(router);
let stopping;
const stop = () => stopping ??= (async () => {
  try {
    await server.stop();
    await fs.writeFile(receipt, JSON.stringify({ success: true, pid: process.pid,
      inFlightRequests: router.inFlightRequests, resourcesDisposed: router.resources.isDisposed }));
    process.exit(0);
  } catch (error) {
    await fs.writeFile(receipt, JSON.stringify({ success: false, error: String(error) }));
    process.exit(1);
  }
})();
server.onDisconnect = stop;
for (const event of ['end', 'close', 'error']) process.stdin.once(event, stop);
process.stdout.once('error', stop);
process.stderr.on('error', () => {});
process.once('SIGTERM', stop); process.once('SIGINT', stop);
await server.start();
