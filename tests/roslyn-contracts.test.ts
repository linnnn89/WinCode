import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RoslynHostClient } from '../src/Adapters/RoslynHostClient.js';
import { RoslynAdapter } from '../src/Adapters/RoslynAdapter.js';
import { getDefaultConfig } from '../src/Core/Config.js';
import { ResourceManager } from '../src/Core/ResourceManager.js';
import { CodeQueryError } from '../src/Core/CodeQueries.js';
import { ToolRouter, WorkspaceRecoveryRequiredError } from '../src/Core/ToolRouter.js';

/** 只产生自有 Node 协议夹具；finally 先清理进程，再删除已验证的临时根。 */
async function processFixture(source: string, run: (client: RoslynHostClient, resources: ResourceManager) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-roslyn-rpc-'));
  const resources = new ResourceManager();
  let client: RoslynHostClient | undefined;
  try {
    const file = path.join(root, 'host.cjs');
    await fs.writeFile(file, source);
    client = new RoslynHostClient(process.execPath, [file], root, resources);
    await run(client, resources);
  } finally {
    await client?.close(true).catch(() => {});
    await resources.dispose();
    assert.equal(resources.childProcessCount(), 0);
    assert.ok(path.relative(os.tmpdir(), root).startsWith('wincode-roslyn-rpc-'));
    await fs.rm(root, { recursive: true, force: true });
  }
}

it('rejects missing project-evaluation permission and unbounded options before any process is registered', async () => {
  const config = getDefaultConfig(process.cwd());
  const resources = new ResourceManager();
  config.adapters.roslyn = { enabled: true, allowProjectEvaluation: false, project: 'App.csproj', configuration: 'Debug',
    targetFramework: 'net10.0', dotnetPath: process.execPath, hostPath: path.resolve('host.dll') };
  assert.throws(() => new RoslynAdapter(config, resources, () => []), (error: unknown) => error instanceof CodeQueryError && error.errorCode === 'PROJECT_EVALUATION_NOT_ALLOWED');
  config.adapters.roslyn.allowProjectEvaluation = true;
  config.adapters.roslyn.loadTimeoutMs = Infinity;
  assert.throws(() => new RoslynAdapter(config, resources, () => []), /Invalid Roslyn time budget/);
  config.adapters.roslyn.loadTimeoutMs = 1000;
  config.adapters.roslyn.project = '../outside.csproj';
  assert.throws(() => new RoslynAdapter(config, resources, () => []), /escapes/);
  assert.deepEqual(resources.list(), []);
  await resources.dispose();
});

for (const [label, output] of [
  ['invalid JSON', 'not-json\n'],
  ['unsolicited id', JSON.stringify({ id: 'unrequested', success: true }) + '\n'],
  ['oversized frame', 'x'.repeat(1048577)],
] as const) {
  it(`closes an owned Host after ${label}, without accepting a ready snapshot`, async () => processFixture(
    `process.stdout.write(${JSON.stringify(output)}); setInterval(() => {}, 1000);`, async (client) => {
      await assert.rejects(client.waitReady(5000), (error: unknown) => error instanceof CodeQueryError && error.errorCode === 'HOST_PROTOCOL_ERROR');
      assert.equal(client.active, false);
      assert.ok(client.child.exitCode !== null || client.child.signalCode !== null);
    }));
}

it('timeout waits for cancellation grace then hard-reaps the unresponsive owned process', async () => processFixture(
  `console.log(JSON.stringify({ id:null, success:true })); process.stdin.resume(); setInterval(() => {}, 1000);`, async (client) => {
    await client.waitReady(5000);
    await assert.rejects(client.request({ operation: 'symbols' }, 20), (error: unknown) => error instanceof CodeQueryError && error.errorCode === 'HOST_TIMEOUT');
    assert.equal(client.active, false);
    assert.ok(client.child.exitCode !== null || client.child.signalCode !== null);
  }));

it('explicit shutdown failure remains a rejected cleanup result after process exit', async () => processFixture(
  `console.log(JSON.stringify({ id:null, success:true })); require('node:readline').createInterface({input:process.stdin}).on('line', line => { const r=JSON.parse(line); console.log(JSON.stringify({id:r.id,success:false,errorCode:'HOST_RESTART_REQUIRED'})); process.exit(1); });`, async (client) => {
    await client.waitReady(5000);
    const first = client.close();
    await assert.rejects(first);
    assert.equal(client.close(), first);
    await assert.rejects(client.close());
  }));

it('Roslyn cleanup failure enters sticky E1 recovery and never starts Serena or mutates another root', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-roslyn-recovery-'));
  const a = path.join(root, 'a'), b = path.join(root, 'b');
  await fs.mkdir(a); await fs.mkdir(b);
  const config = getDefaultConfig(a);
  config.adapters.flaui.enabled = false; config.adapters.repomix.useCli = false;
  config.adapters.roslyn = { enabled: true, allowProjectEvaluation: true, project: 'App.csproj', configuration: 'Debug',
    targetFramework: 'net10.0', dotnetPath: process.execPath, hostPath: path.join(root, 'host.dll') };
  const router = new ToolRouter(config);
  let closes = 0;
  router.serena.initialize = async () => { throw new Error('Serena must not initialize'); };
  router.serena.findSymbolsDetailed = async () => { throw new Error('Serena must not query'); };
  try {
    await router.initialize();
    (router.roslyn as any).client = { close: async () => { closes++; throw new Error('injected cleanup failure'); } };
    await assert.rejects(router.openWorkspace(b), WorkspaceRecoveryRequiredError);
    assert.equal(router.workspaceRecoveryState?.recoveryAction, 'restart_gateway');
    await assert.rejects(router.openWorkspace(a), WorkspaceRecoveryRequiredError);
    assert.equal(config.workspaceRoot, b);
    assert.equal(closes, 1);
    await assert.rejects(router.acquireRequestSlot(), WorkspaceRecoveryRequiredError);
    const health = await router.getRuntimeHealth();
    assert.equal(health.codeProvider, 'roslyn');
    assert.equal(health.roslyn?.cleanupFailed, true);
  } finally {
    await assert.rejects(router.dispose());
    assert.equal(router.resources.childProcessCount(), 0);
    assert.ok(path.relative(os.tmpdir(), root).startsWith('wincode-roslyn-recovery-'));
    await fs.rm(root, { recursive: true, force: true });
  }
});
