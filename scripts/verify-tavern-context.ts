import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createHash } from 'node:crypto';

// Opt-in read-only source acceptance. Never opens or changes the application's database.
const target = process.argv[2];
if (!target || target.startsWith('--')) throw new Error('Usage: npm run test:tavern-context -- <TavernDesk repository> [--baseline] [--ui-pid=<PID> --ui-hwnd=<HWND>]');
const baseline = process.argv.includes('--baseline');
const uiPid = process.argv.find(arg => arg.startsWith('--ui-pid='))?.slice(9);
const uiHwnd = process.argv.find(arg => arg.startsWith('--ui-hwnd='))?.slice(10);
assert.equal(Boolean(uiPid), Boolean(uiHwnd), 'UI acceptance requires both PID and HWND of an existing dedicated test process');
if (uiPid) assert.ok(/^[1-9]\d*$/.test(uiPid) && Number.isSafeInteger(Number(uiPid)) && /^0x[\da-f]+$/i.test(uiHwnd!), 'invalid PID/HWND');
const workspace = await fs.realpath(target);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = 'src/TavernDesk.App/ViewModels/MainWindowViewModel.cs';
const source = await fs.readFile(path.join(workspace, file), 'utf8');
const lines = source.split(/\r?\n/);
const symbol = 'ShowCharactersAsync';
const start = lines.findIndex(line => /^\s*private async Task ShowCharactersAsync\(\)/.test(line));
assert.ok(start >= 0, 'current source must contain the navigation method');
const next = lines.findIndex((line, index) => index > start && /^    private /.test(line));
assert.ok(next > start);
let end = next;
while (!lines[end - 1].trim()) end--;
assert.equal(lines[end - 1].trim(), '}');
const requested = { file, startLine: start + 1, endLine: end };
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-tavern-probe-'));
const client = new Client({ name: 'tavern-context-acceptance', version: '1' });
let transport: StdioClientTransport | undefined;
const report: any = { baseline, workspace, file, sourceHash: createHash('sha256').update(source).digest('hex'), requested,
  connection: 'new isolated stdio process with compiled production handlers', codexConnectionVerified: false,
  upstreams: false, gui: false, measurements: [] };
try {
  const url = (name: string) => JSON.stringify(pathToFileURL(path.join(repo, 'dist', name)).href);
  const bootstrap = path.join(temporary, 'probe.mjs');
  await fs.writeFile(bootstrap, `
import { getDefaultConfig } from ${url('Core/Config.js')};
import { ToolRouter } from ${url('Core/ToolRouter.js')};
import { WinCodeMcpServer } from ${url('Gateway/McpServer.js')};
const config = getDefaultConfig(${JSON.stringify(workspace)});
config.cacheDir = ${JSON.stringify(path.join(temporary, 'cache'))};
config.trashDir = ${JSON.stringify(path.join(temporary, 'trash'))};

config.adapters.flaui.enabled = ${Boolean(uiPid)};
config.adapters.repomix.useCli = false;
const server = new WinCodeMcpServer(new ToolRouter(config));
process.stdin.on('end', () => { void server.stop(); });
process.on('SIGTERM', () => { void server.stop(); });
await server.start();
`);
  transport = new StdioClientTransport({ command: process.execPath, args: [bootstrap], cwd: repo, stderr: 'pipe' });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result: any = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return { data: JSON.parse(result.content[0].text), characters: result.content.reduce((sum: number, block: any) => sum + (block.text?.length || 0), 0) };
  };
  report.hello = (await call('wincode_hello_world', { toolName: 'wincode_prepare_context' })).data;
  assert.equal(report.hello.runtime.build.status, 'verified');
  assert.equal(report.hello.workspace, workspace);
  report.open = await call('workspace_open', { path: workspace });
  assert.ok(report.open.characters <= 8000);
  const scenarios = [
    { label: 'known-method', args: { scopeFiles: [file], symbol } },
    { label: 'known-lines', args: { lineRanges: [requested] } },
    { label: 'known-file', args: { scopeFiles: [file] } },
    { label: 'unknown-file', args: {} },
    { label: 'long-range', args: { lineRanges: [{ file, startLine: start + 1, endLine: Math.min(lines.length, start + 223) }] } },
    { label: '223-lines', args: { lineRanges: [{ file, startLine: 1, endLine: 223 }] } },
    { label: 'small-budget', args: { lineRanges: [requested], maxTokens: 512 } },
    { label: 'past-eof', args: { lineRanges: [{ file, startLine: lines.length, endLine: lines.length + 1 }] } },
  ];
  for (const scenario of scenarios) {
    const began = performance.now();
    const args = { task: symbol, maxTokens: 8000, ...scenario.args };
    const response = await call('wincode_prepare_context', args);
    const elapsedMs = performance.now() - began;
    const data = response.data;
    assert.ok(response.characters <= args.maxTokens * 4);
    // Verify every returned line against this read-only source snapshot; a half line is only a prefix.
    for (const evidence of data.evidence) {
      const actual = evidence.file === file ? lines : (await fs.readFile(path.join(workspace, evidence.file), 'utf8')).split(/\r?\n/);
      const expected = actual.slice(evidence.startLine - 1, evidence.endLine).join('\n');
      assert.ok(expected.startsWith(evidence.snippet), 'returned body must agree with its actual source range');
    }
    const targetLocated = data.evidence.some((item: any) => item.file === file && item.snippet.includes('private async Task ShowCharactersAsync()'));
    if (['known-method', 'known-lines'].includes(scenario.label)) assert.ok(targetLocated, scenario.label);
    if (!baseline && ['known-lines', 'long-range', '223-lines'].includes(scenario.label)) assert.equal(data.coverage.allRequestedCovered, true, scenario.label);
    if (!baseline && scenario.label === 'past-eof') {
      assert.equal(data.coverage.allRequestedCovered, false);
      assert.equal(data.evidence.length, 0);
    }
    report.measurements.push({ label: scenario.label, args, elapsedMs, characters: response.characters,
      targetLocated, queryComplete: data.queryComplete, truncated: data.truncated, coverage: data.coverage ?? null,
      returned: data.evidence.map((item: any) => ({ file: item.file, startLine: item.startLine, endLine: item.endLine,
        endLineComplete: item.endLineComplete, truncated: item.truncated })), fileIssues: data.fileIssues });
  }
  if (uiPid) {
    const response = await call('wincode_ui_review', {
      pid: Number(uiPid), hwnd: uiHwnd, backgroundOnly: true, capture: 'none', readStates: true, maxNodes: 100,
      query: { automationId: 'NavCharacters', controlType: 'Button' },
      candidateFiles: ['src/TavernDesk.App/MainWindow.xaml'], candidateCodeFiles: [file],
    });
    const ui = response.data;
    assert.equal(ui.success, true);
    assert.equal(ui.queryResult.status, 'unique');
    assert.equal(ui.queryResult.searchComplete, true);
    assert.equal(ui.tree.automationId, 'NavCharacters');
    assert.equal(ui.tree.isEnabled, true);
    assert.equal(ui.codeEvidence.runtimeSourceVerified, false);
    const clue = ui.codeEvidence.clues.find((item: any) => item.identifier === 'ShowCharactersCommand');
    assert.ok(clue);
    const assignment = clue.candidates.find((item: any) => item.kind === 'assignment' && item.relatedSymbol === symbol);
    assert.ok(assignment, 'command assignment must identify the method as a candidate clue');
    const nextResponse = await call('wincode_prepare_context', assignment.nextRequest);
    assert.ok(nextResponse.data.evidence.some((item: any) => item.file === file && item.snippet.includes('ShowCharactersCommand = new AsyncRelayCommand(ShowCharactersAsync)')));
    assert.equal(nextResponse.data.coverage.allRequestedCovered, true);
    // The assignment is now read; a separate scoped request checks its candidate method body.
    const body = await call('wincode_prepare_context', { task: 'Inspect the method named by the confirmed assignment.', scopeFiles: [file], symbol: assignment.relatedSymbol });
    assert.ok(body.data.evidence.some((item: any) => item.file === file && item.snippet.includes('private async Task ShowCharactersAsync()') && item.snippet.includes('await ')));
    report.gui = { pid: Number(uiPid), hwnd: uiHwnd, screenshotVerified: false, calls: 3,
      queryResult: ui.queryResult, isEnabled: ui.tree.isEnabled, codeEvidence: ui.codeEvidence,
      characters: [response.characters, nextResponse.characters, body.characters] };
  }
  assert.equal(await fs.readFile(path.join(workspace, file), 'utf8'), source, 'source changed during acceptance; rerun on a stable tree');
  assert.deepEqual((await call('wincode_hello_world', {})).data.runtime, report.hello.runtime);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = String(error); throw error;
} finally {
  try { await client.close(); } finally {
    try { await transport?.close(); } finally {
      assert.equal(path.dirname(temporary), os.tmpdir());
      await fs.rm(temporary, { recursive: true, force: true });
      const output = path.join(repo, 'test-tmp', 'r3');
      await fs.mkdir(output, { recursive: true });
      const reportPath = path.join(output, `${baseline ? 'baseline' : 'acceptance'}-${Date.now()}.json`);
      await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ status: report.status, reportPath,
        measurements: report.measurements.map(({ label, characters, targetLocated, coverage }: any) =>
          ({ label, characters, targetLocated, allRequestedCovered: coverage?.allRequestedCovered ?? null })) }, null, 2));
    }
  }
}
