import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertExited } from '../lib/owned-processes.mjs';

/** 仅对入口生成的隔离项目注入 MSBuild 故障，复用真实客户端及自有进程观察。 */
export async function verifyGatewayLifecycle({ root, a, host, appProject, client, call, markerReady, codeProcesses, report, references, integerTarget }) {
  // 获准的隔离 targets 只启动测试脚本；标记写入 .cache，避免用写入结果假装另一个业务输入。
  const blocker = path.join(root, 'blocker.mjs');
  await fs.writeFile(blocker, "import fs from 'node:fs'; fs.writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);\n");
  const marker = path.join(a, '.cache/block.started');
  const escape = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  const targetXml = `<Target Name="WinCodeAcceptanceBlock" BeforeTargets="CoreCompile" Condition="'$(DesignTimeBuild)' == 'true'"><Exec Command="${escape(`"${process.execPath}" "${blocker}" "${marker}"`)}" /></Target>`;
  for (const mode of ['cancel', 'crash', 'timeout']) {
    console.log(`[roslyn-gateway] active MSBuild ${mode}`);
    await call('workspace_open', { path: a });
    const beforeChange = await integerTarget();
    await fs.rm(marker, { force: true });
    await fs.writeFile(path.join(a, 'App/App.csproj'), appProject.replace('</Project>', targetXml + '</Project>'));
    const stale = await call('wincode_find_references', { symbolName: 'Save', symbolLocation: beforeChange.location }, true);
    assert.ok(['SNAPSHOT_STALE', 'INPUTS_CHANGED'].includes(stale.errorCode));
    const controller = new AbortController();
    const pending = client.callTool({ name: 'wincode_find_code_symbol', arguments: { query: 'Api' } }, { timeout: 30000, signal: controller.signal });
    const settled = pending.then(value => ({ value }), error => ({ error: String(error) }));
    await markerReady(marker);
    const processes = codeProcesses();
    assert.ok(processes.some(item => item.CommandLine?.includes('BuildHost')), 'actual BuildHost must be observed during design-time work');
    assert.ok(processes.some(item => item.CommandLine?.includes(blocker)), 'blocking target child must be observed');
    report.processes.push({ mode, processes });
    if (mode === 'cancel') controller.abort();
    if (mode === 'crash') {
      const hostProcess = processes.find(item => item.CommandLine?.includes(host));
      assert.ok(hostProcess);
      process.kill(hostProcess.ProcessId, 'SIGKILL');
    }
    const outcome = await settled;
    if (mode === 'cancel') assert.ok(outcome.error);
    else {
      assert.equal(outcome.value?.isError, true, JSON.stringify(outcome));
      assert.equal(JSON.parse(outcome.value.content[0].text).errorCode, mode === 'timeout' ? 'HOST_TIMEOUT' : 'HOST_CRASHED');
    }
    // Client cancellation ends its own wait first. Same-root confirmation is now read-only,
    // so observe actual Gateway completion instead of treating workspace_open as a drain barrier.
    await call('workspace_open', { path: a });
    const cleanupStarted = Date.now();
    let health = (await call('wincode_hello_world')).health;
    const initialInFlight = health.inFlightRequests;
    const initialAdmitted = health.admission.business.active;
    // Hello uses the status lane and is excluded from business in-flight accounting.
    while ((health.inFlightRequests > 0 || health.admission.business.active > 0) && Date.now() - cleanupStarted < 8000) {
      await new Promise(resolve => setTimeout(resolve, 25));
      health = (await call('wincode_hello_world')).health;
    }
    report.processes.at(-1).cleanupObservation = {
      initialInFlight, finalInFlight: health.inFlightRequests,
      initialAdmitted, finalAdmitted: health.admission.business.active,
      finalWaiting: health.admission.business.waiting, waitMs: Date.now() - cleanupStarted,
    };
    assert.equal(health.inFlightRequests, 0, 'cancelled business work must finish actual cleanup');
    assert.equal(health.admission.business.active, 0, 'business capacity must be released only after actual cleanup');
    assert.equal(health.admission.business.waiting, 0, 'no cancelled business request may remain queued');
    assertExited(processes);
    await fs.writeFile(path.join(a, 'App/App.csproj'), appProject);
    await references(await integerTarget(), 1, a);
    report.scenarios.push(`${mode} during real MSBuild work releases observed Host, BuildHost and target descendants; explicit recovery succeeds`);
  }
}
