import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/client';
import { getDefaultConfig } from '../src/Core/Config.js';
import { ToolRouter } from '../src/Core/ToolRouter.js';
import { WinCodeMcpServer } from '../src/Gateway/McpServer.js';

type Args = Record<string, unknown>;
type Policy = 'candidate-first' | 'precise-first';
type Evidence = { file: string; startLine: number; endLine?: number; snippet: string; truncated?: boolean; line?: number; symbol?: string };
type Response = { evidence?: Evidence[]; fileIssues?: { path: string; reason: string }[]; queryComplete?: boolean; evidenceInsufficient?: boolean };
export type BenchmarkHooks = { callTool?: (client: Client, args: Args) => Promise<any> };

/** Validate locations and displayed bodies against current isolated fixture contents. */
export function validateEvidence(data: any, sources: Map<string, string>, args: Args): string | null {
  if (!data || !Array.isArray(data.evidence) || !Array.isArray(data.fileIssues) ||
    typeof data.queryComplete !== 'boolean' || typeof data.evidenceInsufficient !== 'boolean') return 'invalid-schema';
  const scope = args.scopeFiles as string[] | undefined;
  const ranges = args.lineRanges as {file: string; startLine: number; endLine: number}[] | undefined;
  if (args.symbol && data.queryComplete !== false) return 'invalid-scoped-query-status';
  for (const item of data.evidence) {
    if (!item || !sources.has(item.file) || (scope && !scope.includes(item.file))) return 'wrong-evidence-file';
    const lines = sources.get(item.file)!.split(/\r?\n/);
    if (typeof item.truncated !== 'boolean') return 'invalid-truncation-status';
    if (!Number.isInteger(item.startLine) || !Number.isInteger(item.endLine) || item.startLine < 1 ||
      item.endLine < item.startLine || item.endLine > lines.length || typeof item.snippet !== 'string' ||
      item.snippet.split('\n').length !== item.endLine - item.startLine + 1) return 'invalid-range';
    const requested = ranges?.find(range => range.file === item.file);
    if (ranges && (!requested || item.startLine < requested.startLine || item.endLine > requested.endLine)) return 'outside-requested-range';
    const current = lines.slice(item.startLine - 1, item.endLine).join('\n');
    if (item.snippet !== current && !(item.truncated === true && item.snippet.length > 0 && current.startsWith(item.snippet))) return 'stale-or-wrong-body';
    if (item.line !== undefined && (!Number.isInteger(item.line) || item.line < item.startLine || item.line > item.endLine ||
      typeof item.symbol !== 'string' || !lines[item.line - 1].includes(item.symbol))) return 'invalid-symbol-location';
  }
  const requestedFiles = scope || ranges?.map(range => range.file) || args.candidateFiles as string[] | undefined;
  for (const issue of data.fileIssues) {
    if (!issue || typeof issue.reason !== 'string' || !sources.has(issue.path) ||
      (requestedFiles && !requestedFiles.includes(issue.path))) return 'wrong-issue-file';
  }
  if (data.evidenceInsufficient !== (data.evidence.length === 0)) return 'inconsistent-evidence-status';
  return null;
}

/** Count unchanged displayed lines across calls, not inferred disk reads or model tokens. */
export class EvidenceOverlap {
  private seen = new Set<string>();
  lines = 0;
  repeatedLines = 0;
  add(evidence: Evidence[]): void {
    const current = new Set<string>();
    for (const item of evidence) {
      item.snippet.split('\n').forEach((line, index) => {
        if (!line.length) return;
        const key = JSON.stringify([item.file, item.startLine + index, createHash('sha256').update(line).digest('hex')]);
        this.lines++;
        if (this.seen.has(key)) this.repeatedLines++;
        current.add(key);
      });
    }
    for (const key of current) this.seen.add(key);
  }
}

const scoped = (file: string, symbol: string): Args => ({ task: symbol, scopeFiles: [file], symbol });
const ranged = (startLine: number, endLine = startLine): Args => ({
  task: '核对指定逻辑', lineRanges: [{ file: 'Service.ts', startLine, endLine }],
});
const hasText = (data: Response, file: string, text: string) =>
  Boolean(data.evidence?.some(item => item.file === file && item.snippet.includes(text)));
const hasIssue = (data: Response, file: string, reason: string) => data.evidence?.length === 0 &&
  Boolean(data.fileIssues?.some(item => item.path === file && item.reason.startsWith(reason)));

type Case = { id: string; knowledge: string; task: string; file?: string; exact: Args; accepts: (data: Response) => boolean };
const cases: Case[] = [
  { id: 'known-symbol', knowledge: 'file-and-symbol', task: 'SaveTarget', file: 'Service.ts', exact: scoped('Service.ts', 'SaveTarget'),
    accepts: (data: Response) => hasText(data, 'Service.ts', 'TARGET_V1') },
  { id: 'known-range', knowledge: 'file-and-range', task: '核对退款计算', file: 'Service.ts', exact: ranged(85),
    accepts: (data: Response) => hasText(data, 'Service.ts', 'REFUND_RULE') },
  { id: 'ambiguous-symbol', knowledge: 'file-and-symbol', task: 'Overloaded', file: 'Overload.ts', exact: scoped('Overload.ts', 'Overloaded'),
    accepts: (data: Response) => hasIssue(data, 'Overload.ts', 'ambiguous-symbol') && data.queryComplete === false },
  { id: 'missing-symbol', knowledge: 'file-and-symbol', task: 'MissingTarget', file: 'Service.ts', exact: scoped('Service.ts', 'MissingTarget'),
    accepts: (data: Response) => hasIssue(data, 'Service.ts', 'symbol-not-found') && data.queryComplete === false },
  { id: 'repeat-unchanged', knowledge: 'file-and-range', task: 'SaveTarget', file: 'Service.ts', exact: ranged(49, 51),
    accepts: (data: Response) => hasText(data, 'Service.ts', 'TARGET_V1') },
  { id: 'read-after-edit', knowledge: 'file-and-range', task: 'SaveTarget', file: 'Service.ts', exact: ranged(49, 51),
    accepts: (data: Response) => hasText(data, 'Service.ts', 'TARGET_V1') },
  ...(['unknown-file', 'known-file', 'known-symbol', 'known-range'] as const).map(level => ({
    id: `csharp-${level}`, knowledge: level, task: level === 'known-file' ? '核对文件' : 'MemoryService',
    file: level === 'unknown-file' ? undefined : 'dotnet/MemoryService.cs',
    exact: level === 'unknown-file' ? { task: 'MemoryService' } : level === 'known-file' ?
      { task: '核对文件', scopeFiles: ['dotnet/MemoryService.cs'] } : level === 'known-symbol' ?
      scoped('dotnet/MemoryService.cs', 'MemoryService') :
      { task: 'MemoryService', lineRanges: [{ file: 'dotnet/MemoryService.cs', startLine: 3, endLine: 6 }] },
    accepts: (data: Response) => hasText(data, 'dotnet/MemoryService.cs', 'public class MemoryService'),
  })),
];

async function createFixture(root: string) {
  await fs.writeFile(path.join(root, 'package.json'), '{"name":"agent-efficiency-fixture"}');
  await fs.writeFile(path.join(root, 'Service.ts'), Array.from({ length: 110 }, (_, i) =>
    i === 49 ? 'export function SaveTarget() { return "TARGET_V1"; }' :
      i === 84 ? 'const refund = "REFUND_RULE";' : `// context line ${i + 1}`).join('\n'));
  await fs.writeFile(path.join(root, 'Overload.ts'), 'export function Overloaded(value: string): string;\nexport function Overloaded(value: number): number;');
  await fs.mkdir(path.join(root, 'dotnet'));
  for (const file of ['Core/MemoryService.cs', 'Infra/SaveManager.cs']) {
    const source = fileURLToPath(new URL(`../tests/fixtures/dotnet-mini/src/${file}`, import.meta.url));
    await fs.copyFile(source, path.join(root, 'dotnet', path.basename(file)));
  }
  await fs.mkdir(path.join(root, 'src'));
  await Promise.all(Array.from({ length: 40 }, (_, i) => fs.writeFile(path.join(root, 'src', `Noise${i}.ts`),
    `export function Noise${i}() {}\n` + Array.from({ length: 200 }, (_, j) => `// unrelated ${i}:${j}`).join('\n'))));
}

async function runCase(testCase: Case, policy: Policy, repetition: number, hooks: BenchmarkHooks) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-benchmark-'));
  const config = getDefaultConfig(root);

  config.adapters.flaui.enabled = false;
  config.adapters.repomix.useCli = false;
  const router = new ToolRouter(config);
  const server = new WinCodeMcpServer(router);
  const client = new Client({ name: 'agent-efficiency-benchmark', version: '1' });
  const overlap = new EvidenceOverlap();
  let symbolQueries = 0;
  const originalFind = router.text.findSymbolsDetailed.bind(router.text);
  // Count invocations, including cache hits; keep production results and cache behavior intact.
  router.text.findSymbolsDetailed = async (...args) => { symbolQueries++; return originalFind(...args); };
  const calls: { args: Args; elapsedMs: number; returnedCharacters: number; status: string; accepted: boolean; error?: string }[] = [];
  const errors: { phase: string; message: string }[] = [];
  const actions: { action: string; revision: number; accepted?: boolean }[] = [];
  const sources = new Map<string, string>();
  let lastData: Response | undefined;
  let success = false;
  let revision = 0;
  try {
    await createFixture(root);
    const collect = async (dir: string, prefix = ''): Promise<void> => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const rel = prefix + entry.name;
        if (entry.isDirectory()) await collect(path.join(dir, entry.name), rel + '/');
        else sources.set(rel, await fs.readFile(path.join(dir, entry.name), 'utf8'));
      }
    };
    await collect(root);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), (server as any).server.connect(serverTransport)]);
    const call = async (args: Args, accepts = testCase.accepts): Promise<boolean> => {
      const request = { maxTokens: 2000, responseFormat: 'compact', ...args };
      const started = performance.now();
      const record = { args: request, elapsedMs: 0, returnedCharacters: 0, status: 'transport-error', accepted: false, error: undefined as string | undefined };
      calls.push(record);
      actions.push({ action: 'request', revision });
      try {
        const result = hooks.callTool ? await hooks.callTool(client, request) :
          await client.callTool({ name: 'wincode_prepare_context', arguments: request });
        record.elapsedMs = performance.now() - started;
        record.status = 'invalid-response';
        if (!Array.isArray(result?.content)) throw new Error('invalid-content');
        const texts = result.content.filter((item: any) => item.type === 'text').map((item: any) => item.text);
        if (texts.length !== 1 || typeof texts[0] !== 'string') throw new Error('invalid-text-blocks');
        record.returnedCharacters = texts[0].length;
        if (result.isError) { record.status = 'tool-error'; throw new Error(texts[0]); }
        const data = JSON.parse(texts[0]);
        const invalid = validateEvidence(data, sources, request);
        if (invalid) throw new Error(invalid);
        if (data.metrics?.totalCharacters !== texts[0].length || texts[0].length > 8000) throw new Error('invalid-output-accounting');
        overlap.add(data.evidence);
        lastData = data;
        record.accepted = accepts(data);
        record.status = record.accepted ? 'accepted' : 'insufficient';
        return record.accepted;
      } catch (error) {
        record.error = error instanceof Error ? error.message : String(error);
        errors.push({ phase: record.status, message: record.error });
        return false;
      } finally {
        if (!record.elapsedMs) record.elapsedMs = performance.now() - started;
      }
    };
    const firstArgs = policy === 'candidate-first' ?
      { task: testCase.task, ...(testCase.file ? { candidateFiles: [testCase.file] } : {}) } : testCase.exact;
    success = await call(firstArgs);
    // Only valid but insufficient evidence can trigger refinement; never hide a transport/validation failure.
    if (!success && calls.at(-1)?.status === 'insufficient') success = await call(testCase.exact);
    if (success && testCase.id === 'repeat-unchanged') {
      if (policy === 'precise-first') {
        // Closed fixture: all writes are controlled here. This is a trusted event, not a production freshness heuristic.
        success = Boolean(lastData && !validateEvidence(lastData, sources, testCase.exact) && testCase.accepts(lastData));
        actions.push({ action: 'reuse-after-known-no-change', revision, accepted: success });
      } else success = await call(firstArgs);
    }
    if (success && testCase.id === 'read-after-edit') {
      const updated = sources.get('Service.ts')!.replace('TARGET_V1', 'TARGET_V2');
      await fs.writeFile(path.join(root, 'Service.ts'), updated);
      sources.set('Service.ts', updated);
      revision++;
      actions.push({ action: 'controlled-file-edit', revision });
      success = await call(firstArgs, data => hasText(data, 'Service.ts', 'TARGET_V2') && !hasText(data, 'Service.ts', 'TARGET_V1'));
    }
  } catch (error) {
    errors.push({ phase: 'scenario', message: error instanceof Error ? error.message : String(error) });
  } finally {
    // Attempt every owner even if one close fails, preserving the original failure in the report.
    for (const [phase, cleanup] of [
      ['client-close', () => client.close()], ['server-stop', () => server.stop()],
      ['fixture-cleanup', async () => {
        const resolved = path.resolve(root);
        if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('wincode-benchmark-')) {
          throw new Error('Refusing to clean up an unexpected fixture directory.');
        }
        await fs.rm(resolved, { recursive: true, force: true });
      }],
    ] as const) {
      try { await cleanup(); } catch (error) {
        errors.push({ phase, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return {
    case: testCase.id, knowledge: testCase.knowledge, policy, repetition, success: success && !errors.length,
    firstCallAccepted: calls[0]?.accepted ?? false, errors, actions,
    reusedEvidence: actions.filter(action => action.action === 'reuse-after-known-no-change').length,
    mcpCalls: calls.length, symbolQueryInvocations: symbolQueries,
    elapsedMs: calls.reduce((n, item) => n + item.elapsedMs, 0),
    returnedCharacters: calls.reduce((n, item) => n + item.returnedCharacters, 0),
    evidenceLines: overlap.lines, repeatedEvidenceLines: overlap.repeatedLines, calls,
  };
}

export async function runBenchmark(repetitions: number, hooks: BenchmarkHooks = {}) {
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 5) throw new Error('repetitions must be an integer from 1 to 5');
  const results: Awaited<ReturnType<typeof runCase>>[] = [];
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    for (const testCase of cases) {
      // Alternate execution order to reduce systematic warm-up/order bias.
      const policies: Policy[] = repetition % 2 ? ['candidate-first', 'precise-first'] : ['precise-first', 'candidate-first'];
      for (const policy of policies) {
        try { results.push(await runCase(testCase, policy, repetition, hooks)); }
        catch (error) { results.push({ case: testCase.id, knowledge: testCase.knowledge, policy, repetition,
          success: false, firstCallAccepted: false, errors: [{ phase: 'setup', message: String(error) }],
          actions: [], reusedEvidence: 0, mcpCalls: 0, symbolQueryInvocations: 0, elapsedMs: 0,
          returnedCharacters: 0, evidenceLines: 0, repeatedEvidenceLines: 0, calls: [] }); }
      }
    }
  }
  const summaries = (['candidate-first', 'precise-first'] as const).map(policy => {
    const rows = results.filter(result => result.policy === policy);
    const sum = (key: 'mcpCalls' | 'symbolQueryInvocations' | 'returnedCharacters' | 'evidenceLines' | 'repeatedEvidenceLines') =>
      rows.reduce((n, row) => n + row[key], 0);
    const times = rows.map(row => row.elapsedMs).sort((a, b) => a - b);
    return { policy, cases: rows.length, successfulCases: rows.filter(row => row.success).length,
      firstCallAccepted: rows.filter(row => row.firstCallAccepted).length,
      mcpCalls: sum('mcpCalls'), symbolQueryInvocations: sum('symbolQueryInvocations'),
      returnedCharacters: sum('returnedCharacters'), evidenceLines: sum('evidenceLines'),
      repeatedEvidenceLines: sum('repeatedEvidenceLines'),
      medianCaseMs: (times[Math.floor((times.length - 1) / 2)] + times[Math.floor(times.length / 2)]) / 2,
    };
  });
  let sourceCommit = 'unknown';
  let workspaceDirty: boolean | null = null;
  try {
    sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    workspaceDirty = Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim());
  } catch { /* standalone run */ }
  const harnessSha256 = createHash('sha256').update(await fs.readFile(fileURLToPath(import.meta.url))).digest('hex');
  return { schemaVersion: 2, createdAtUtc: new Date().toISOString(), sourceCommit, workspaceDirty, harnessSha256,
    environment: { node: process.version, platform: process.platform, arch: process.arch }, repetitions,
    methodology: {
      transport: 'in-memory MCP SDK; real handlers and local symbol fallback; no semantic upstream, GUI or model',
      fixture: '45 files: 43 synthetic TypeScript/metadata files and copies of two existing dotnet-mini C# fixtures',
      policies: 'Paired initial knowledge strata: unknown file, known file, symbol or range. Candidate-first refines valid insufficient evidence; precise-first routes by supplied knowledge and stops on trusted no-change events.',
      isolation: 'Fresh workspace and router per case/policy/repetition. Cache remains active within each sequence. No router initialization, watch or upstream handshake.',
      success: 'Current fixture file/range/body/status validation plus task evidence oracle. Invalid responses and errors fail the case; not coding-task or model completion.',
      timing: 'MCP call wall time only; excludes fixture setup, explicit edit, cleanup and model thinking. Median across heterogeneous cases is descriptive.',
      overlap: 'Unchanged nonempty displayed lines with matching file, line number and SHA-256 across calls within one case; not filesystem reads. Changed lines are new evidence.',
      limits: 'Scripted workflows, with trusted controlled-write events for reuse. This is not a production cache or an external-edit detection mechanism. No real-user frequency or benefit of a cache is established. Characters are UTF-16, not model tokens.',
    }, summaries, results };
}

export async function writeBenchmarkReport(report: Awaited<ReturnType<typeof runBenchmark>>, output: string) {
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  return report.results.some(result => !result.success) ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repetitions = Number(process.argv[2] ?? 1);
  const report = await runBenchmark(repetitions);
  const output = path.resolve('test-tmp', 'agent-efficiency', `${Date.now()}-${process.pid}`);
  const exitCode = await writeBenchmarkReport(report, output);
  console.log(JSON.stringify({ report: path.join(output, 'report.json'), summaries: report.summaries }, null, 2));
  process.exitCode = exitCode;
}
