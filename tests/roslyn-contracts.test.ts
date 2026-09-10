import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RoslynHostClient } from '../src/Adapters/RoslynHostClient.js';
import { RoslynAdapter } from '../src/Adapters/RoslynAdapter.js';
import { WINCODE_VERSION, getDefaultConfig } from '../src/Core/Config.js';
import { ResourceManager } from '../src/Core/ResourceManager.js';
import { CodeQueryError } from '../src/Core/CodeQueries.js';
import { ToolRouter, WorkspaceRecoveryRequiredError } from '../src/Core/ToolRouter.js';
import { ImpactAnalyzer } from '../src/CompositeTools/ImpactAnalyzer.js';
import { RefactorAssistant } from '../src/CompositeTools/RefactorAssistant.js';
import type { CodeReferenceQuery, SymbolReference } from '../src/Core/CodeQueries.js';

it('same-root confirmations preserve warm identity, reload state and perform a required restart only once', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-warm-中文 空格-'));
  const config = getDefaultConfig(root);
  config.adapters.flaui.enabled = false; config.adapters.repomix.useCli = false;
  config.adapters.roslyn = { enabled: true, allowProjectEvaluation: true, project: 'App.csproj', configuration: 'Debug',
    targetFramework: 'net10.0', dotnetPath: process.execPath, hostPath: path.join(root, 'host.dll') };
  const router = new ToolRouter(config);
  try {
    await router.initialize();
    const adapter = router.roslyn!, state = adapter as any;
    let closes = 0;
    const host = { active: true, close: async () => { closes++; } };
    state.client = host; state.snapshot = 'a'.repeat(32);
    const before = await router.getRuntimeHealth();
    const reset = t.mock.method(adapter, 'resetConnection', adapter.resetConnection.bind(adapter));
    const aliases = [root, path.join(root, '.'), root + path.sep];
    if (process.platform === 'win32') aliases.push(root.toUpperCase().replaceAll('\\', '/'));
    for (let index = 0; index < 10; index++) await router.openWorkspace(aliases[index % aliases.length]);
    assert.equal(reset.mock.callCount(), 0);
    assert.equal(state.client, host);
    assert.equal(adapter.getKnownHealth().snapshotId, before.roslyn?.snapshotId);
    assert.equal(router.session.current?.id, before.session?.id);
    assert.deepEqual((await router.getRuntimeHealth()).workspaceWatch, before.workspaceWatch);
    assert.equal(config.workspaceRoot, root);
    state.reloadRequired = true;
    await fs.writeFile(path.join(root, 'Changed.cs'), 'class Changed {}');
    await router.openWorkspace(root);
    assert.equal(adapter.getKnownHealth().reloadRequired, true, 'confirmation must not consume required input reload');
    assert.equal(state.client, host);
    assert.equal(closes, 0);
    state.restartRequired = true;
    await Promise.all(Array.from({ length: 10 }, () => router.openWorkspace(root)));
    assert.equal(reset.mock.callCount(), 1, 'queued confirmations must recheck state after the first recovery');
    assert.equal(closes, 1);
    assert.equal(adapter.getKnownHealth().restartRequired, false);
    assert.equal(adapter.getKnownHealth().snapshotId, null);
    // A failed cleanup remains terminal even if another path set only the typed cleanup state.
    state.client = { active: true, close: async () => { throw new Error('fixture cleanup failed'); } };
    state.restartRequired = true;
    await assert.rejects(router.openWorkspace(root), WorkspaceRecoveryRequiredError);
    const resetCount = reset.mock.callCount();
    await assert.rejects(router.openWorkspace(root), WorkspaceRecoveryRequiredError);
    assert.equal(reset.mock.callCount(), resetCount);
    assert.equal(router.workspaceRecoveryState?.recoveryAction, 'restart_gateway');
  } finally {
    if (router.workspaceRecoveryState?.recoveryAction === 'restart_gateway') await assert.rejects(router.dispose());
    else await router.dispose();
    assert.ok(path.relative(os.tmpdir(), root).startsWith('wincode-warm-'));
    await fs.rm(root, { recursive: true, force: true });
  }
});

/** 用固定语义身份提供真实聚合器的输入；工作区故意不同于进程启动目录。 */
function impactFixture(references: SymbolReference[]) {
  const config = getDefaultConfig(path.resolve('test-tmp/impact-identity-fixture'));
  const symbol = { name: 'Service', kind: 'class' as const, file: 'src/A/Service.cs', line: 1,
    location: { snapshotId: 'a'.repeat(32), project: 'A.csproj', file: 'src/A/Service.cs', position: 13 } };
  const queries: CodeReferenceQuery = {
    findSymbols: async () => [symbol], findReferences: async () => references,
    findSymbolsDetailed: async () => ({ query: 'Service', totalFound: 1, symbols: [symbol], source: 'roslyn',
      analysisCompleteness: 'incomplete', limitations: ['Generators are excluded.'], queryComplete: false,
      truncated: false, uniqueTypeMatch: true, typeMatchCount: 1 }),
    findReferencesDetailed: async () => ({ symbolName: 'Service', totalReferences: references.length, references,
      source: 'roslyn', analysisCompleteness: 'incomplete', limitations: ['Generators are excluded.'], queryComplete: false, truncated: false }),
  };
  return { config, queries, analyzer: new ImpactAnalyzer(queries, config) };
}

it('impact groups full file identities and keeps same-name and suffix callers outside the target', async () => {
  const files = ['src/B/Service.cs', 'src/B/Handler.cs', 'src/C/Handler.cs', 'src/C/NewService.cs', 'src/A/Service.cs'];
  const { analyzer } = impactFixture(files.map(file => ({ file, symbolName: 'Service', line: 2, preview: 'Service.Run();' })));
  const report = await analyzer.analyzeImpact('Service');
  assert.equal(report.referencesCount, 5);
  assert.deepEqual(report.affectedFiles, files);
  assert.deepEqual(report.affectedComponents.map(item => item.file), files.slice(0, 4));
  assert.deepEqual(report.affectedComponents.map(item => item.references), [1, 1, 1, 1]);
  assert.equal(report.riskLevel, 'UNKNOWN');
});

it('impact resolves relative and absolute hints against its workspace, preserving separator aliases', async () => {
  const { analyzer, config } = impactFixture([{ file: 'Caller.cs', symbolName: 'Service', line: 1, preview: '' }]);
  const targets = ['src/A/Service.cs', 'src\\A\\Service.cs', path.join(config.workspaceRoot, 'src/A/Service.cs')];
  if (process.platform === 'win32') targets.push(path.join(config.workspaceRoot, 'SRC/A/SERVICE.CS').toUpperCase());
  for (const target of targets) {
    const report = await analyzer.analyzeImpact(target);
    assert.equal(report.uniqueResolution, true, target);
    assert.equal(report.referencesCount, 1, target);
  }
  assert.equal((await analyzer.analyzeImpact('other/src/A/Service.cs')).uniqueResolution, false);
});

it('impact collapses path aliases but preserves linked-source project components', async () => {
  const { config } = impactFixture([]);
  const references = [
    { file: 'src/A/Service.cs', project: 'A.csproj' },
    { file: 'src/A/Service.cs', project: 'B.csproj' },
    { file: path.join(config.workspaceRoot, 'src/A/Service.cs'), project: 'B.csproj' },
    { file: 'src/A/Service.cs', project: 'C.csproj' },
  ].map(item => ({ ...item, symbolName: 'Service', line: 2, preview: '' }));
  const populated = impactFixture(references);
  const report = await populated.analyzer.analyzeImpact('Service');
  assert.equal(report.affectedFiles.length, 1);
  assert.equal(report.downstreamImpacts[0].occurrences, 4);
  assert.deepEqual(report.affectedComponents.map(item => item.references), [2, 1]);
});

it('refactoring treats bounded Roslyn evidence as semantic coverage, not text fallback or interruption', async () => {
  const { analyzer, queries } = impactFixture([{ file: 'Caller.cs', symbolName: 'Service', line: 1, preview: '' }]);
  const assistant = new RefactorAssistant(null as any, analyzer);
  const plan = await assistant.planRefactoring('Service', 'Simplify the implementation');
  assert.equal(plan.evidence.source, 'roslyn');
  assert.equal(plan.evidence.queryComplete, false);
  assert.ok(plan.evidence.limitations.includes('Generators are excluded.'));
  assert.ok(plan.recommendedSteps.some(step => /coverage limitations/.test(step)));
  assert.ok(plan.recommendedSteps.every(step => !/interrupted|textual matches|degraded retrieval/.test(step)));
});

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
  config.adapters.roslyn.project = 'App.csproj';
  for (const additionalInputs of [null, 'file.yaml', [null], [''], ['../outside.yaml'], ['*.yaml'],
    ['same.yaml', './same.yaml'], Array.from({ length: 33 }, (_, index) => `${index}.yaml`), ['a'.repeat(4097)]]) {
    config.adapters.roslyn.additionalInputs = additionalInputs as any;
    assert.throws(() => new RoslynAdapter(config, resources, () => []), (error: unknown) => error instanceof CodeQueryError);
  }
  assert.deepEqual(resources.list(), []);
  await resources.dispose();
});

it('passive runtime health includes a Roslyn load failure without starting another provider', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-roslyn-health-'));
  const config = getDefaultConfig(root);
  config.adapters.flaui.enabled = false; config.adapters.repomix.useCli = false;
  config.adapters.roslyn = { enabled: true, allowProjectEvaluation: true, project: 'Missing.csproj',
    configuration: 'Debug', targetFramework: 'net10.0', dotnetPath: process.execPath, hostPath: path.join(root, 'missing.dll') };
  const router = new ToolRouter(config);
  router.text.initialize = async () => { throw new Error('Local text must not initialize'); };
  try {
    await router.initialize();
    assert.equal((await router.getRuntimeHealth()).lastAdapterError, null);
    await assert.rejects(router.roslyn!.findSymbolsDetailed('Service'),
      (error: unknown) => error instanceof CodeQueryError && error.errorCode === 'INPUT_UNAVAILABLE');
    const health = await router.getRuntimeHealth();
    assert.equal(health.lastAdapterError?.provider, 'roslyn');
    assert.equal(health.lastAdapterError?.reason, 'unavailable');
    assert.equal(health.roslyn?.health?.lastError?.at, health.lastAdapterError?.at);
    assert.equal(router.resources.childProcessCount(), 0);
  } finally {
    await router.dispose();
    assert.ok(path.relative(os.tmpdir(), root).startsWith('wincode-roslyn-health-'));
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('rejects a Host that fails to confirm the configured additional inputs and reaps it', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-roslyn-policy-'));
  const resources = new ResourceManager();
  try {
    const config = getDefaultConfig(root);
    const host = path.join(root, 'host.cjs');
    await fs.writeFile(path.join(root, 'App.csproj'), '<Project />');
    await fs.writeFile(path.join(root, 'schema.yaml'), 'mode: original');
    await fs.writeFile(host, `console.log(JSON.stringify({id:null,type:'ready',success:true,protocolVersion:2,snapshot:'${'a'.repeat(32)}',configuration:'Debug',framework:'net10.0',processTreeGuard:true,hostIdentity:{version:'${WINCODE_VERSION}',configuration:'Release',protocolVersion:2},inputPolicy:{version:2,additionalInputs:[]}})); process.stdin.resume(); setInterval(()=>{},1000);`);
    config.adapters.roslyn = { enabled: true, allowProjectEvaluation: true, project: 'App.csproj', configuration: 'Debug',
      targetFramework: 'net10.0', dotnetPath: process.execPath, hostPath: host, additionalInputs: ['schema.yaml'] };
    const adapter = new RoslynAdapter(config, resources, () => []);
    await assert.rejects(adapter.findSymbolsDetailed('Service'),
      (error: unknown) => error instanceof CodeQueryError && error.errorCode === 'HOST_PROTOCOL_ERROR');
    assert.equal(adapter.getKnownHealth().snapshotId, null);
    assert.equal(resources.childProcessCount(), 0);
  } finally {
    await resources.dispose();
    assert.ok(path.relative(os.tmpdir(), root).startsWith('wincode-roslyn-policy-'));
    await fs.rm(root, { recursive: true, force: true });
  }
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

it('Roslyn cleanup failure enters sticky E1 recovery and never starts Local text or mutates another root', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-roslyn-recovery-'));
  const a = path.join(root, 'a'), b = path.join(root, 'b');
  await fs.mkdir(a); await fs.mkdir(b);
  const config = getDefaultConfig(a);
  config.adapters.flaui.enabled = false; config.adapters.repomix.useCli = false;
  config.adapters.roslyn = { enabled: true, allowProjectEvaluation: true, project: 'App.csproj', configuration: 'Debug',
    targetFramework: 'net10.0', dotnetPath: process.execPath, hostPath: path.join(root, 'host.dll') };
  const router = new ToolRouter(config);
  let closes = 0;
  router.text.initialize = async () => { throw new Error('Local text must not initialize'); };
  router.text.findSymbolsDetailed = async () => { throw new Error('Local text must not query'); };
  try {
    await router.initialize();
    (router.roslyn as any).client = { close: async () => { closes++; throw new Error('injected cleanup failure'); } };
    await (router as any).watch.stop();
    await assert.rejects(router.openWorkspace(a), WorkspaceRecoveryRequiredError);
    assert.equal(router.workspaceRecoveryState?.recoveryAction, 'restart_gateway');
    await assert.rejects(router.openWorkspace(a), WorkspaceRecoveryRequiredError);
    await assert.rejects(router.openWorkspace(b), (error: any) => error.errorCode === 'WORKSPACE_MISMATCH');
    assert.equal(config.workspaceRoot, a);
    assert.equal(closes, 1);
    await assert.rejects(router.acquireRequestSlot(), WorkspaceRecoveryRequiredError);
    const health = await router.getRuntimeHealth();
    assert.equal(health.codeProvider, 'roslyn');
    assert.equal(health.roslyn?.cleanupFailed, true);
    assert.equal(health.lastAdapterError?.provider, 'roslyn');
    assert.equal(health.lastAdapterError?.recoverable, false);
  } finally {
    await assert.rejects(router.dispose());
    assert.equal(router.resources.childProcessCount(), 0);
    assert.ok(path.relative(os.tmpdir(), root).startsWith('wincode-roslyn-recovery-'));
    await fs.rm(root, { recursive: true, force: true });
  }
});

for (const identity of [undefined, { version: '0.0.0', configuration: 'Release', protocolVersion: 2 },
  { version: WINCODE_VERSION, configuration: 'Debug', protocolVersion: 2 }]) {
  it('rejects missing or mismatched Code Host build identity and reaps its process', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-host-version-'));
    const resources = new ResourceManager();
    try {
      const config = getDefaultConfig(root);
      const host = path.join(root, 'host.cjs');
      await fs.writeFile(path.join(root, 'App.csproj'), '<Project />');
      const ready = { id: null, type: 'ready', success: true, protocolVersion: 2, snapshot: 'a'.repeat(32),
        configuration: 'Debug', framework: 'net10.0', processTreeGuard: true, hostIdentity: identity,
        inputPolicy: { version: 2, additionalInputs: [] } };
      await fs.writeFile(host, 'console.log(' + JSON.stringify(JSON.stringify(ready)) + '); process.stdin.resume(); setInterval(()=>{},1000);');
      config.adapters.roslyn = { enabled: true, allowProjectEvaluation: true, project: 'App.csproj', configuration: 'Debug',
        targetFramework: 'net10.0', dotnetPath: process.execPath, hostPath: host };
      const adapter = new RoslynAdapter(config, resources, () => []);
      await assert.rejects(adapter.findSymbolsDetailed('Service'),
        (error: unknown) => error instanceof CodeQueryError && error.errorCode === 'HOST_VERSION_MISMATCH');
      assert.equal(adapter.getKnownHealth().snapshotId, null);
      assert.equal(resources.childProcessCount(), 0);
    } finally {
      await resources.dispose();
      assert.ok(path.relative(os.tmpdir(), root).startsWith('wincode-host-version-'));
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}

it('text mode rejects selected identities before any analysis or resource admission', async () => {
  const router = new ToolRouter(getDefaultConfig(process.cwd()));
  let calls = 0;
  router.text.findSymbolsDetailed = async () => { calls++; throw new Error('must not scan'); };
  const location = { snapshotId: 'a'.repeat(32), project: 'App.csproj', file: 'App.cs', position: 0 };
  for (const call of [() => router.analyzeChangeImpact('App', undefined, location),
    () => router.planRefactoring('App', 'Simplify', undefined, location)]) {
    assert.throws(call, (error: unknown) => error instanceof CodeQueryError && error.errorCode === 'UNSUPPORTED_SYMBOL_LOCATION');
  }
  assert.equal(calls, 0);
  assert.equal(router.resources.childProcessCount(), 0);
  await router.dispose();
});
