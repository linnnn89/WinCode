import { it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { TrayClient, resolveTrayEndpoint } from '../src/Gateway/TrayClient.js';
import { ToolRouter } from '../src/Core/ToolRouter.js';
import { getDefaultConfig } from '../src/Core/Config.js';

async function fixture() {
  const pipe = `WinCode.Tray.v1.S-1-5-21-0.s0.test-${randomUUID().replaceAll('-', '')}`;
  const address = `\\\\.\\pipe\\${pipe}`;
  const server = net.createServer(); server.listen(address); await once(server, 'listening');
  const router = new ToolRouter(getDefaultConfig(process.cwd()));
  let shutdown = 0, release = 0;
  let stopped!: () => void;
  const stoppedEvent = new Promise<void>(resolve => { stopped = resolve; });
  const original = router.releaseRoslynMemory.bind(router);
  router.releaseRoslynMemory = () => { release++; return original(); };
  const warnings: string[] = [];
  const client = new TrayClient(pipe, router, () => { shutdown++; stopped(); }, message => warnings.push(message));
  const connected = once(server, 'connection'); client.start();
  const [socket] = await connected as [net.Socket];
  let input = '', lines: any[] = [], waiters: Array<(value: any) => void> = [];
  socket.on('data', chunk => { input += chunk; let next; while ((next = input.indexOf('\n')) >= 0) {
    const value = JSON.parse(input.slice(0, next)); input = input.slice(next + 1);
    const waiter = waiters.shift(); if (waiter) waiter(value); else lines.push(value);
  } });
  const read = () => lines.length ? Promise.resolve(lines.shift()) : new Promise<any>(resolve => waiters.push(resolve));
  const registration = await read();
  const request = (operation: string, id = randomUUID()) => ({ v: 1, type: 'request', id, instanceId: registration.instanceId, operation });
  return { server, socket, client, router, registration, request, read, stoppedEvent, warnings,
    counts: () => ({ shutdown, release }),
    close: async () => { client.dispose(); socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); await router.dispose(); } };
}

it('Tray endpoint resolves the published current-user helper without starting a Tray', { timeout: 8000 }, async () => {
  assert.match(await resolveTrayEndpoint(new AbortController().signal), /^WinCode\.Tray\.v1\.S-1-/);
});

it('registration acknowledgement is passive and refusal reports its reason without stopping MCP', { timeout: 8000 }, async () => {
  const f = await fixture();
  try {
    f.socket.write(JSON.stringify({ v: 1, type: 'register-accepted', instanceId: f.registration.instanceId }) + '\n');
    f.socket.write(JSON.stringify(f.request('status')) + '\n');
    assert.equal((await f.read()).result.roslynLoaded, false);
    const closed = once(f.socket, 'close');
    f.socket.write(JSON.stringify({ v: 1, type: 'register-rejected', instanceId: f.registration.instanceId, message: '产品版本不符' }) + '\n');
    await closed;
    assert.ok(f.warnings.some(message => message.includes('产品版本不符')));
    assert.deepEqual(f.counts(), { release: 0, shutdown: 0 });
    assert.equal(f.router.isShuttingDown, false);
  } finally { await f.close(); }
});

it('Tray registration and status never warm Roslyn; shutdown occurs after acknowledgement', { timeout: 8000 }, async () => {
  const f = await fixture();
  try {
    assert.equal(f.registration.pid, process.pid);
    assert.equal(f.registration.status.automaticRelease, false);
    assert.equal(f.registration.status.roslynLoaded, false);
    f.socket.write(JSON.stringify(f.request('status')) + '\n');
    assert.equal((await f.read()).result.automaticRelease, false);
    f.socket.write(JSON.stringify(f.request('shutdown')) + '\n');
    assert.equal((await f.read()).result.status, 'accepted');
    await f.stoppedEvent;
    assert.equal(f.counts().shutdown, 1);
  } finally { await f.close(); }
});

it('control refuses a busy instance without queuing a later release', { timeout: 8000 }, async () => {
  const f = await fixture();
  try {
    f.router.beginRequest();
    f.socket.write(JSON.stringify(f.request('releaseRoslyn')) + '\n');
    assert.equal((await f.read()).result.status, 'busy');
    f.router.endRequest(); assert.equal(f.counts().release, 1);
  } finally { await f.close(); }
});

it('replayed command IDs are disconnected without executing the operation twice', { timeout: 8000 }, async () => {
  const f = await fixture();
  try {
    const frame = JSON.stringify(f.request('releaseRoslyn')) + '\n';
    f.socket.write(frame); assert.equal((await f.read()).result.status, 'not-configured');
    const closed = once(f.socket, 'close'); f.socket.write(frame); await closed;
    assert.equal(f.counts().release, 1);
    assert.equal(f.router.isShuttingDown, false);
  } finally { await f.close(); }
});

for (const kind of ['wrong-instance', 'oversize', 'invalid-utf8', 'invalid-then-valid']) it(`Tray rejects ${kind} without changing the Gateway`, { timeout: 8000 }, async () => {
  const f = await fixture();
  try {
    const closed = once(f.socket, 'close');
    if (kind === 'oversize') f.socket.write(Buffer.alloc(65537, 32));
    else if (kind === 'invalid-utf8') f.socket.write(Buffer.from([0xff, 10]));
    else if (kind === 'invalid-then-valid') f.socket.write(JSON.stringify({ ...f.request('shutdown'), instanceId: 'wrong' }) + '\n' + JSON.stringify(f.request('shutdown')) + '\n');
    else f.socket.write(JSON.stringify({ ...f.request('shutdown'), instanceId: randomUUID() }) + '\n');
    await closed; assert.deepEqual(f.counts(), { release: 0, shutdown: 0 });
    assert.equal(f.router.isShuttingDown, false);
  } finally { await f.close(); }
});

it('Tray reconnect registers fresh passive state without replaying a completed release', { timeout: 8000 }, async () => {
  const f = await fixture();
  let second: net.Socket | undefined;
  try {
    f.socket.write(JSON.stringify(f.request('releaseRoslyn')) + '\n'); await f.read();
    const connection = once(f.server, 'connection'); f.socket.destroy();
    [second] = await connection as [net.Socket];
    const [bytes] = await once(second, 'data');
    assert.equal(JSON.parse(bytes.toString()).type, 'register');
    assert.equal(f.counts().release, 1);
  } finally { second?.destroy(); await f.close(); }
});
