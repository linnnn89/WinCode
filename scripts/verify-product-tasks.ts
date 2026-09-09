import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { EvidenceOverlap } from './benchmark-agent-efficiency.js';

// Opt-in, read-only acceptance against an already running dedicated TavernDesk profile.
// These scripted tasks establish source candidates, not runtime binding or whole-method correctness.
const [target, pidText, hwnd] = process.argv.slice(2);
assert.ok(target && /^[1-9]\d*$/.test(pidText ?? '') && /^0x[\da-f]+$/i.test(hwnd ?? ''),
  'Usage: npm run test:product -- <TavernDesk repository> <dedicated-test PID> <HWND>');
const workspace = await fs.realpath(target);
const pid = Number(pidText);
assert.ok(Number.isSafeInteger(pid));
const receipt = JSON.parse(await fs.readFile(path.join(workspace, 'work/TAVERN-TEST/profile/startup-result.json'), 'utf8'));
assert.equal(receipt.processId, pid, 'PID must match the fixed test profile receipt');
assert.equal(path.resolve(receipt.testRoot), path.join(workspace, 'work/TAVERN-TEST/profile'));
assert.equal(receipt.status, 'window-shown');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-product-'));
const client = new Client({ name: 'product-task-acceptance', version: '1' });
let transport: StdioClientTransport | undefined;
const report: any = { formatVersion: 1, startedAt: new Date().toISOString(), workspace, pid, hwnd,
  connection: 'fresh production stdio', upstreams: false, codexConnectionVerified: false,
  taskScope: 'unknown file → unique live navigation control → literal command assignment → method declaration candidate',
  limitations: ['Six scripted navigation tasks, one operator and one fixed test application; not blind agent trials.',
    'Native rg candidate discovery is counted; oracle reads and connection setup are separate.',
    'No native-only comparison, model-token estimate, universal speedup or full-method coverage claim.',
    'No clicks, provider calls, source edits or screenshots; runtime binding/build-source identity remain unverified.'],
  setup: [], tasks: [], success: false };
const originals = new Map<string, string>();
const overlap = new EvidenceOverlap();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
async function source(file: string) {
  const full = await fs.realpath(path.join(workspace, file));
  const relative = path.relative(workspace, full);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  assert.ok((await fs.stat(full)).size <= 256 * 1024);
  const text = await fs.readFile(full, 'utf8');
  if (originals.has(file)) assert.equal(hash(text), originals.get(file), 'source changed during acceptance');
  else originals.set(file, hash(text));
  return text;
}
async function call(name: string, args: Record<string, unknown>, metrics: any[]) {
  const start = performance.now();
  const metric: any = { tool: name, kind: 'mcp', characters: 0, elapsedMs: 0, success: false };
  metrics.push(metric);
  try {
    const result: any = await client.callTool({ name, arguments: args }, { timeout: 30000 });
    metric.characters = result.content?.reduce((n: number, block: any) => n + (block.text?.length ?? 0), 0) ?? 0;
    assert.notEqual(result.isError, true, JSON.stringify(result).slice(0, 2048));
    assert.equal(result.content?.[0]?.type, 'text');
    const data = JSON.parse(result.content[0].text);
    metric.success = true;
    return data;
  } catch (error) { metric.error = String(error).slice(0, 2048); throw error; }
  finally { metric.elapsedMs = Math.round(performance.now() - start); }
}
function search(needle: string, glob: string, before: number, metrics: any[]) {
  const start = performance.now();
  const result = spawnSync('rg', ['--no-heading', '--color', 'never', '-n', '-B', String(before), '-F', '--glob', glob, '--', needle, 'src'],
    { cwd: workspace, encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 65536 });
  metrics.push({ tool: 'rg', kind: 'native', characters: (result.stdout?.length ?? 0) + (result.stderr?.length ?? 0),
    elapsedMs: Math.round(performance.now() - start), success: !result.error && result.status === 0 });
  assert.ok(!result.error && result.status === 0, result.error?.message ?? result.stderr ?? 'No source candidate');
  return result.stdout;
}
async function validateEvidence(data: any) {
  assert.ok(data.evidence?.length > 0);
  for (const evidence of data.evidence) {
    const lines = (await source(evidence.file)).split(/\r?\n/);
    assert.ok(Number.isInteger(evidence.startLine) && Number.isInteger(evidence.endLine) && evidence.startLine > 0 && evidence.endLine <= lines.length);
    const expected = lines.slice(evidence.startLine - 1, evidence.endLine).join('\n');
    assert.ok(evidence.snippet === expected || (evidence.truncated === true && expected.startsWith(evidence.snippet)), 'returned body differs from source');
  }
  overlap.add(data.evidence);
}
try {
  const url = (file: string) => JSON.stringify(pathToFileURL(path.join(repo, 'dist', file)).href);
  const bootstrap = path.join(temporary, 'probe.mjs');
  await fs.writeFile(bootstrap, `
import { getDefaultConfig } from ${url('Core/Config.js')};
import { ToolRouter } from ${url('Core/ToolRouter.js')};
import { WinCodeMcpServer } from ${url('Gateway/McpServer.js')};
const config = getDefaultConfig(${JSON.stringify(temporary)});

config.adapters.repomix.useCli = false;
const server = new WinCodeMcpServer(new ToolRouter(config));
process.stdin.on('end', () => { void server.stop(); });
process.on('SIGTERM', () => { void server.stop(); });
await server.start();
`);
  transport = new StdioClientTransport({ command: process.execPath, args: [bootstrap], cwd: temporary, stderr: 'pipe' });
  await client.connect(transport);
  const hello = await call('wincode_hello_world', {}, report.setup);
  assert.equal(hello.runtime.build.status, 'verified');
  report.runtime = hello.runtime;
  report.schemaHash = hello.toolContract.schemaHash;
  await call('workspace_open', { path: workspace }, report.setup);
  for (const id of ['NavDashboard', 'NavChat', 'NavCampaigns', 'NavCharacters', 'NavWorldbooks', 'NavSettings']) {
    const task: any = { id, calls: [], success: false };
    report.tasks.push(task);
    try {
      const xamlSearch = search(id, '*.xaml', 1, task.calls);
      const xaml = [...new Set([...xamlSearch.matchAll(/^(.+\.xaml)[:-]\d+[:-]/gm)].map(match => match[1].replaceAll('\\', '/')))];
      const commands = [...new Set([...xamlSearch.matchAll(/Command="\{Binding (\w+)\}"/g)].map(match => match[1]))];
      assert.equal(xaml.length, 1, 'XAML discovery must be unambiguous');
      assert.equal(commands.length, 1, 'simple command binding must be unambiguous');
      const codeSearch = search(commands[0], '*.cs', 0, task.calls);
      const code = [...new Set([...codeSearch.matchAll(/^(.+\.cs):\d+:/gm)].map(match => match[1].replaceAll('\\', '/')))];
      assert.ok(code.length > 0 && code.length <= 8, 'candidate code files exceed the existing mapper contract');
      await source(xaml[0]);
      const ui = await call('wincode_ui_review', { pid, hwnd, backgroundOnly: true, capture: 'none', readStates: true, maxNodes: 100,
        query: { automationId: id, controlType: 'Button' }, candidateFiles: xaml, candidateCodeFiles: code }, task.calls);
      assert.equal(ui.success, true);
      assert.equal(ui.queryResult.status, 'unique');
      assert.equal(ui.queryResult.searchComplete, true);
      assert.equal(ui.tree.automationId, id);
      assert.equal(ui.codeEvidence.runtimeSourceVerified, false);
      const assignments = ui.codeEvidence.clues.filter((clue: any) => clue.identifier === commands[0])
        .flatMap((clue: any) => clue.candidates).filter((candidate: any) => candidate.kind === 'assignment' && candidate.relatedSymbol);
      assert.equal(assignments.length, 1, 'command assignment must be an unambiguous literal candidate');
      const assignment = assignments[0];
      assert.equal(hash(await source(assignment.file)), assignment.fileSha256);
      const evidence = await call('wincode_prepare_context', assignment.nextRequest, task.calls);
      await validateEvidence(evidence);
      assert.equal(evidence.coverage.allRequestedCovered, true);
      const body = await call('wincode_prepare_context', { task: 'Locate the method declaration named by this command assignment.',
        scopeFiles: [assignment.file], symbol: assignment.relatedSymbol }, task.calls);
      await validateEvidence(body);
      assert.ok(body.evidence.some((item: any) => new RegExp(`(?:private|public|protected|internal)\\s+[^\\n]*\\b${assignment.relatedSymbol}\\(`).test(item.snippet)));
      task.candidate = { xaml: xaml[0], command: commands[0], file: assignment.file, line: assignment.line, method: assignment.relatedSymbol };
      task.evidence = { assignmentCovered: true, methodDeclarationLocated: true, wholeMethodCoverage: 'unknown', runtimeSourceVerified: false,
        isEnabled: ui.tree.isEnabled, returnedRanges: body.evidence.map(({ file, startLine, endLine, truncated }: any) => ({ file, startLine, endLine, truncated })) };
      task.success = true;
    } catch (error) { task.error = String(error).slice(0, 2048); }
  }
  for (const file of originals.keys()) await source(file);
  report.sourceHashes = Object.fromEntries(originals);
  report.overlap = { displayedSourceLines: overlap.lines, repeatedSourceLines: overlap.repeatedLines };
  report.success = report.tasks.every((task: any) => task.success);
} catch (error) { report.error = String(error).slice(0, 2048); }
finally {
  try { try { await client.close(); } finally { await transport?.close(); } }
  catch (error) { report.success = false; report.cleanupError = String(error).slice(0, 2048); }
  try { assert.equal(path.dirname(temporary), os.tmpdir()); await fs.rm(temporary, { recursive: true, force: true }); }
  catch (error) { report.success = false; report.temporaryCleanupError = String(error).slice(0, 2048); }
  report.finishedAt = new Date().toISOString();
  const directory = path.join(repo, 'test-tmp/product-tasks', `${Date.now()}-${process.pid}`);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ report: path.join(directory, 'report.json'), success: report.success,
    tasks: report.tasks.map((task: any) => ({ id: task.id, success: task.success, calls: task.calls.length,
      characters: task.calls.reduce((sum: number, call: any) => sum + call.characters, 0), error: task.error })) }, null, 2));
  if (!report.success) process.exitCode = 1;
}
