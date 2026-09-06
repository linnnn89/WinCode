import { spawn } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert';

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
}

async function runMcpClientVerification() {
  console.log('=== [Phase 1: Real Stdio MCP Client Handshake Test] ===\n');

  const serverPath = path.resolve('dist/index.js');
  console.log(`1. Launching WinCode MCP Server process: node ${serverPath}...`);

  const proc = spawn('node', [serverPath, '--workspace', process.cwd()], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let procExited = false;
  proc.on('exit', (code) => {
    procExited = true;
    if (code !== 0 && code !== null) {
      console.error(`[Process exited with code ${code}]`);
    }
  });

  proc.stderr.on('data', (d) => {
    // Log debug stderr
    const text = d.toString().trim();
    if (text) {
      console.log(`   [Server stderr]: ${text}`);
    }
  });

  let buffer = '';
  const pendingRequests = new Map<number | string, (res: JsonRpcMessage) => void>();

  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg: JsonRpcMessage = JSON.parse(trimmed);
        if (msg.id !== undefined && pendingRequests.has(msg.id)) {
          const resolve = pendingRequests.get(msg.id)!;
          pendingRequests.delete(msg.id);
          resolve(msg);
        }
      } catch (e) {
        console.warn('Failed to parse stdout line as JSON:', trimmed);
      }
    }
  });

  const sendRequest = (method: string, params?: any): Promise<JsonRpcMessage> => {
    const id = Math.floor(Math.random() * 1000000);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error(`Request ${method} (id=${id}) timed out after 10s`));
      }, 10000);

      pendingRequests.set(id, (res) => {
        clearTimeout(timeout);
        resolve(res);
      });

      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      proc.stdin.write(payload);
    });
  };

  const sendNotification = (method: string, params?: any): void => {
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
    proc.stdin.write(payload);
  };

  // Wait a brief moment for server to initialize
  await new Promise((r) => setTimeout(r, 800));

  console.log('\n2. Sending MCP "initialize" handshake...');
  const initRes = await sendRequest('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: { roots: { listChanged: true } },
    clientInfo: { name: 'Codex-TestClient', version: '1.0.0' },
  });

  console.log('   ✓ Received initialize response from server:');
  console.log(`     Protocol Version: ${initRes.result?.protocolVersion}`);
  console.log(`     Server Name: ${initRes.result?.serverInfo?.name}`);
  console.log(`     Server Version: ${initRes.result?.serverInfo?.version}`);
  assert.strictEqual(initRes.result?.serverInfo?.name, 'wincode-agent-gateway');

  // Send initialized notification
  sendNotification('notifications/initialized');

  console.log('\n3. Requesting "tools/list" from WinCode MCP...');
  const toolsRes = await sendRequest('tools/list', {});
  const tools: any[] = toolsRes.result?.tools || [];
  console.log(`   ✓ Server returned ${tools.length} available tools:`);
  for (const t of tools) {
    console.log(`     - [${t.name}]: ${t.description.slice(0, 70)}...`);
  }

  const hasHelloWorld = tools.some((t) => t.name === 'wincode_hello_world');
  const hasAnalyzeWorkspace = tools.some((t) => t.name === 'wincode_analyze_workspace');

  assert.ok(hasHelloWorld, 'Must expose "wincode_hello_world"');
  assert.ok(hasAnalyzeWorkspace, 'Must expose "wincode_analyze_workspace"');
  console.log('   ✓ Confirmed: Codex/Claude can see "wincode_hello_world" & "wincode_analyze_workspace"');

  console.log('\n4. Calling "wincode_hello_world()" via MCP...');
  const helloCallRes = await sendRequest('tools/call', {
    name: 'wincode_hello_world',
    arguments: { greeting: 'Codex connecting to WinCode MCP!' },
  });

  const helloContent = helloCallRes.result?.content?.[0]?.text;
  console.log('   ✓ Result from hello_world:');
  console.log('----------------------------------------------------');
  console.log(helloContent);
  console.log('----------------------------------------------------');
  assert.ok(helloContent.includes('online'), 'Response must confirm server status is online');

  console.log('\n5. Calling "wincode_analyze_workspace()" via MCP...');
  const analyzeCallRes = await sendRequest('tools/call', {
    name: 'wincode_analyze_workspace',
    arguments: {},
  });

  const analyzeContent = analyzeCallRes.result?.content?.[0]?.text;
  console.log('   ✓ Result from wincode_analyze_workspace:');
  console.log('----------------------------------------------------');
  console.log(analyzeContent.slice(0, 500) + '...\n');
  console.log('----------------------------------------------------');
  assert.ok(analyzeContent.includes('WinCode MCP'), 'Must analyze current workspace');

  console.log('\n6. Closing test client connection...');
  proc.stdin.end();
  await new Promise((r) => setTimeout(r, 500));
  if (!procExited) {
    proc.kill();
  }

  console.log('\n=== [PHASE 1 VERIFICATION PASSED PERFECTLY!] ===');
  console.log('Link verified: Codex -> MCP (stdio) -> WinCode -> hello_world() & analyze_workspace()');
}

runMcpClientVerification().catch((err) => {
  console.error('Phase 1 test failed:', err);
  process.exit(1);
});
