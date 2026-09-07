/** Opt-in real UI acceptance. Only attach to an explicitly supplied PID; never launch a target. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const options = JSON.parse(await fs.readFile(process.argv[2], 'utf8')) as {
  pid: number; workspace: string; candidateFiles: string[]; output: string; iterations?: number;
};
assert.ok(Number.isInteger(options.pid) && options.pid > 0);
assert.ok(path.isAbsolute(options.workspace) && path.isAbsolute(options.output));
const count = options.iterations ?? 1;
assert.ok(Number.isInteger(count) && count >= 1 && count <= 20);
await fs.mkdir(options.output, { recursive: true });
// Bootstrap outside the target project: gateway cache stays in WinCode.
const transport = new StdioClientTransport({ command: process.execPath,
  args: [path.resolve('dist/index.js'), '--workspace', process.cwd()], cwd: process.cwd(), stderr: 'pipe' });
const client = new Client({ name: 'ui-runtime-acceptance', version: '1' });
const samples: unknown[] = [];
let gatewayPid: number | null = null;
let failure: string | null = null;
const alive = (pid: number | null) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 30_000 });
  assert.equal(response.isError ?? false, false, JSON.stringify(response.content).slice(0, 500));
  const data = JSON.parse((response.content as Array<{ text: string }>)[0].text);
  return { response, data };
};
try {
  await client.connect(transport);
  gatewayPid = transport.pid;
  await call('workspace_open', { path: options.workspace });
  for (let index = 0; index < count; index++) {
    const started = Date.now();
    if (index > 0 && index % 5 === 0) {
      await call('workspace_open', { path: options.output });
      await call('workspace_open', { path: options.workspace });
    }
    let cancelled = false;
    if (index % 5 === 4) {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 20);
      try {
        await client.callTool({ name: 'wincode_ui_inspect', arguments: { pid: options.pid, capture: 'annotated' } },
          undefined, { signal: abort.signal, timeout: 30_000 });
      } catch (error) {
        if (!abort.signal.aborted) throw error;
        cancelled = true;
      } finally { clearTimeout(timer); }
      // A succeeding request below proves that cancellation did not leave the helper lock wedged.
    }
    const { response, data } = await call('wincode_ui_review', {
      pid: options.pid, capture: index === 0 || index === count - 1 ? 'annotated' : 'none',
      maxDepth: 12, maxNodes: 500, candidateFiles: options.candidateFiles,
    });
    const pending = data.tree ? [data.tree] : [];
    let nodes = 0, withId = 0;
    while (pending.length) {
      const node = pending.pop(); nodes++; if (node.automationId) withId++;
      pending.push(...node.children);
    }
    assert.ok(nodes > 0);
    const text = (response.content as Array<{ text: string }>)[0].text;
    assert.ok(Buffer.byteLength(text, 'utf8') <= 128 * 1024);
    const statuses: Record<string, number> = {};
    for (const entry of data.sourceEvidence?.nodes ?? []) {
      const key = entry.reason ?? entry.status;
      statuses[key] = (statuses[key] ?? 0) + 1;
    }
    if (index === 0 || index === count - 1) {
      await fs.writeFile(path.join(options.output, `snapshot-${index}.json`), JSON.stringify(data, null, 2));
      const image = (response.content as Array<{ type: string; data?: string }>).find(c => c.type === 'image');
      if (image?.data) await fs.writeFile(path.join(options.output, `snapshot-${index}.png`), Buffer.from(image.data, 'base64'));
    }
    const health = (await call('wincode_hello_world')).data.health;
    assert.equal(health.managedChildProcesses, 0);
    assert.ok(alive(options.pid), 'Target must survive inspection');
    samples.push({ index, elapsedMs: Date.now() - started, cancelled, nodes, withId,
      statuses, coverage: data.sourceEvidence?.coverage, fileScanComplete: data.sourceEvidence?.fileScanComplete,
      truncated: data.truncated, sourceTruncated: data.sourceEvidence?.truncated,
      memory: health.nodeMemory, cache: health.cache, processes: health.managedChildProcesses,
      flaui: health.flaui, watch: health.workspaceWatch });
  }
} catch (error) { failure = String(error); throw error; }
finally {
  await client.close(); await transport.close();
  const report = { at: new Date().toISOString(), options, samples, failure,
    gatewayExited: !alive(gatewayPid), targetAlive: alive(options.pid) };
  await fs.writeFile(path.join(options.output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  assert.ok(report.gatewayExited, 'Acceptance gateway must exit after transport close');
  assert.ok(report.targetAlive, 'Inspection must not terminate the target application');
}
