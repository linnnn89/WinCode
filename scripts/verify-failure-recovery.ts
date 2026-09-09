import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ToolRouter } from '../src/Core/ToolRouter.js';
import { getDefaultConfig } from '../src/Core/Config.js';

// Bounded diagnostic: disabled external adapters, generated files only.
// This records failure semantics without enshrining faulty behavior as a passing regression.
const reportRoot = path.resolve('test-tmp/failure-recovery');
await fs.mkdir(reportRoot, { recursive: true });
const runRoot = await fs.mkdtemp(path.join(reportRoot, 'run-'));
const observations: Record<string, unknown>[] = [];
const failures: string[] = [];

async function fixture(name: string, work: (router: ToolRouter, a: string, b: string) => Promise<void>) {
  const directory = path.join(runRoot, name);
  const a = path.join(directory, 'a');
  const b = path.join(directory, 'b');
  await fs.mkdir(a, { recursive: true });
  await fs.mkdir(b, { recursive: true });
  await fs.writeFile(path.join(a, 'OnlyA.cs'), 'class OnlyA {}');
  await fs.writeFile(path.join(b, 'OnlyB.cs'), 'class OnlyB {}');
  const config = getDefaultConfig(a);
  config.adapters.serena.enabled = false;
  config.adapters.flaui.enabled = false;
  config.adapters.repomix.useCli = false;
  const router = new ToolRouter(config);
  try {
    await router.initialize();
    await work(router, a, b);
  } finally {
    await router.dispose();
    assert.equal(router.inFlightRequests, 0);
    assert.equal((await router.getRuntimeHealth()).workspaceWatch.active, false);
  }
}

const stages = ['root-before', 'root-after', 'namespace', 'session', 'watch',
  'repomix-dispose', 'serena-reset', 'repomix-initialize', 'serena-initialize', 'composites', 'cancel-after-root'];

for (const stage of stages) {
  await fixture(stage, async (router, a, b) => {
    const controller = new AbortController();
    const targets: Record<string, [any, string]> = {
      'root-before': [router.workspace, 'openWorkspace'],
      'root-after': [router.workspace, 'openWorkspace'],
      'cancel-after-root': [router.workspace, 'openWorkspace'],
      namespace: [router.cache, 'setNamespace'], session: [router.session, 'open'],
      watch: [router as any, 'bindWatch'],
      'repomix-dispose': [router.repomix, 'dispose'],
      'serena-reset': [router.serena, 'resetConnection'],
      'repomix-initialize': [router.repomix, 'initialize'],
      'serena-initialize': [router.serena, 'initialize'],
      composites: [router as any, 'bindCompositeTools'],
    };
    const [target, method] = targets[stage];
    const original = target[method];
    target[method] = stage.endsWith('after-root') || stage === 'root-after'
      ? async function (this: any, ...args: unknown[]) {
        const result = await original.apply(this, args);
        if (stage === 'cancel-after-root') { controller.abort(); return result; }
        throw new Error(`injected:${stage}`);
      }
      : function () { throw new Error(`injected:${stage}`); };
    let switchOutcome = 'resolved';
    try { await router.openWorkspace(b, {}, controller.signal); }
    catch (error) { switchOutcome = String(error); }
    finally { target[method] = original; }

    const health = await router.getRuntimeHealth();
    let accepted = false;
    try { await router.acquireRequestSlot(); accepted = true; }
    catch { /* A fail-closed recovery state would reject the request. */ }
    finally { if (accepted) router.endRequest(); }
    const rootsAgree = router.config.workspaceRoot === health.session?.workspaceRoot
      && router.config.workspaceRoot === health.workspaceWatch.root;
    observations.push({ stage, switchOutcome, requestAccepted: accepted,
      root: router.config.workspaceRoot, sessionRoot: health.session?.workspaceRoot,
      watchRoot: health.workspaceWatch.root, cacheNamespace: router.cache.currentNamespace,
      rootsAgree, switching: router.isSwitchingWorkspace });
    if (switchOutcome !== 'resolved' && router.config.workspaceRoot !== a && accepted)
      failures.push(`${stage}: switch failed after root changed but next request was admitted`);
    if (accepted && !rootsAgree) failures.push(`${stage}: admitted request with inconsistent roots`);
    if (controller.signal.aborted && switchOutcome === 'resolved')
      failures.push(`${stage}: cancellation after root change was not observed`);
    // A subsequent normal switch must at least release admission and clean up.
    await router.openWorkspace(a);
    assert.equal(router.config.workspaceRoot, a);
    assert.equal(router.isSwitchingWorkspace, false);
  });
}

for (const stage of ['rename', 'metadata']) {
  await fixture(`trash-${stage}`, async (router, a) => {
    const source = path.join(a, 'OnlyA.cs');
    const original = stage === 'rename' ? fs.rename : fs.writeFile;
    const method = stage === 'rename' ? 'rename' : 'writeFile';
    (fs as any)[method] = async (...args: any[]) => {
      if (stage === 'rename' || String(args[0]).endsWith('.meta.json')) throw new Error(`injected:${stage}`);
      return (original as any)(...args);
    };
    let result;
    try { result = await router.moveToTrash('OnlyA.cs'); }
    finally { (fs as any)[method] = original; }
    const exists = async (file: string) => fs.stat(file).then(() => true, () => false);
    const sourceExists = await exists(source);
    const destinationExists = await exists(result.trashPath);
    assert.equal(sourceExists || destinationExists, true, 'generated content must remain locatable');
    const content = await fs.readFile(sourceExists ? source : result.trashPath, 'utf8');
    assert.equal(content, 'class OnlyA {}');
    const retry = await router.moveToTrash('OnlyA.cs');
    observations.push({ stage: `trash-${stage}`, result, sourceExists, destinationExists, retry });
    if (!sourceExists && destinationExists && result.outcome !== 'partial')
      failures.push('trash-metadata: failed response does not explicitly distinguish completed move from failed metadata');
  });
}

const report = { node: process.version, generatedAt: new Date().toISOString(),
  externalAdapters: 'disabled; local fallback only', observations, failures,
  scope: 'Injected local failure semantics; does not validate real upstream binding or endurance.' };
const reportFile = path.join(runRoot, 'report.json');
await fs.writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ reportFile, cases: observations.length, findings: failures.length, failures }, null, 2));
if (failures.length) process.exitCode = 1;
