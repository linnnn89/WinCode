import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { parseTextDeclarations, TextLexicalError } from '../../src/Core/TextDeclarations.ts';
import { getDefaultConfig } from '../../src/Core/Config.ts';
import { ToolRouter } from '../../src/Core/ToolRouter.ts';
import { WinCodeMcpServer } from '../../src/Gateway/McpServer.ts';

const samples = [];
for (const size of [128, 2048, 16384, 65536]) {
  const source = 'class Fixture {\n public int ' + ' '.repeat(size) + 'Field;\n}';
  const started = performance.now();
  const symbols = parseTextDeclarations(source, 'Fixture.cs', '.cs');
  samples.push({ size, elapsedMs: performance.now() - started });
  assert.equal(symbols.filter(symbol => symbol.name === 'Fixture').length, 1);
  assert.equal(symbols.filter(symbol => symbol.kind === 'method').length, 0);
}
const methods = parseTextDeclarations('public static async Task<List<int>> Fetch (int x) {}', 'Fixture.cs', '.cs');
assert.equal(methods[0]?.name, 'Fetch');
assert.throws(() => parseTextDeclarations('public int ' + 'x'.repeat(17000) + ';', 'Fixture.cs', '.cs'), TextLexicalError);

// The parent imposes an OS child deadline: a blocked event loop cannot pass via its own timer.
const root = path.resolve(process.argv[2]);
await fs.writeFile(path.join(root, 'Fixture.cs'), 'class Fixture {\n public int ' + ' '.repeat(2048) + 'Field;\n}');
const config = getDefaultConfig(root);
config.adapters.flaui.enabled = false;
config.adapters.repomix.useCli = false;
config.timeouts.fileScanMs = 250;
const router = new ToolRouter(config), server = new WinCodeMcpServer(router);
const client = new Client({ name: 'declaration-budget-probe', version: '1' });
const [a, b] = InMemoryTransport.createLinkedPair();
try {
  await Promise.all([client.connect(a), server.server.connect(b)]);
  const started = performance.now();
  const heartbeat = new Promise(resolve => setTimeout(() => resolve(performance.now() - started), 20));
  const result = await client.callTool({ name: 'wincode_find_code_symbol', arguments: { query: 'Fixture' } });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.match(JSON.stringify(result), /Fixture/);
  const heartbeatMs = await heartbeat;
  assert(heartbeatMs < 1000, 'heartbeat was blocked by declaration parsing');
  console.log(JSON.stringify({ samples, heartbeatMs, gatewayElapsedMs: performance.now() - started }));
} finally { await client.close(); await server.stop(); }
