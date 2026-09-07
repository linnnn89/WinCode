#!/usr/bin/env node
/**
 * Tiny stdio MCP stand-in for Serena handshake tests.
 * Speaks newline-delimited JSON-RPC like @modelcontextprotocol/sdk.
 * Does not implement real C# semantics.
 */
const hang = process.env.MOCK_SERENA_HANG === '1' || process.argv.includes('--hang');
const hangInit = process.env.MOCK_SERENA_HANG_INIT === '1' || process.argv.includes('--hang-init');
const crashOnCall = process.env.MOCK_SERENA_CRASH === '1' || process.argv.includes('--crash');

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

const tools = [
  {
    name: 'find_symbol',
    description: 'Mock Serena find_symbol',
    inputSchema: {
      type: 'object',
      properties: {
        name_path_pattern: { type: 'string' },
        name_path: { type: 'string' },
      },
    },
  },
  {
    name: 'find_referencing_symbols',
    description: 'Mock Serena find_referencing_symbols',
    inputSchema: {
      type: 'object',
      properties: {
        name_path: { type: 'string' },
        relative_path: { type: 'string' },
      },
    },
  },
];

const mockSymbol = [
  {
    name_path: 'MockService',
    kind: 'Class',
    relative_path: 'src/MockService.cs',
    body_location: { start_line: 3, end_line: 12 },
  },
];

const mockRefs = {
  'src/Caller.cs': {
    Method: [
      {
        name_path: 'Caller/Run',
        body_location: { start_line: 8, end_line: 9 },
        content_around_reference: 'new MockService()',
      },
    ],
  },
};

process.stdin.setEncoding('utf8');
let buffer = '';

process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      continue;
    }
    handle(msg);
  }
});

function handle(msg) {
  if (!msg || typeof msg !== 'object') return;
  const method = msg.method;
  const id = msg.id;

  if (method === 'initialize') {
    if (hangInit) return;
    const protocolVersion = msg.params?.protocolVersion || '2024-11-05';
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'mock-serena', version: '0.0.1' },
      },
    });
    return;
  }

  if (typeof method === 'string' && method.startsWith('notifications/')) {
    return;
  }

  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }

  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools } });
    return;
  }

  if (method === 'tools/call') {
    if (hang) return;
    if (crashOnCall) {
      process.exit(2);
      return;
    }
    const toolName = msg.params?.name;
    const payload = toolName === 'find_referencing_symbols' ? mockRefs : mockSymbol;
    send({
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
      },
    });
    return;
  }

  if (typeof id !== 'undefined') {
    send({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }
}

process.stdin.on('end', () => process.exit(0));
