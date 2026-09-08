import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { killProcessTree } from '../src/Core/ResourceManager.js';
import type { UiReviewResult } from '../src/CompositeTools/UiReview.js';

const runFile = promisify(execFile);
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureFiles = ['wpf-ui-review.csproj', 'packages.lock.json', 'App.xaml', 'App.xaml.cs', 'AssemblyInfo.cs', 'MainWindow.xaml', 'MainWindow.xaml.cs'];
const defect = 'return false; // R6_SOURCE_DEFECT';
const repair = 'return true; // R6_SOURCE_FIXED';

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Owned WPF process did not close after termination.')), 5000);
    child.once('close', () => { clearTimeout(timer); resolve(); });
  });
  await Promise.all([killProcessTree(child), closed]);
}

async function launch(exe: string, cwd: string): Promise<{ child: ChildProcess; pid: number; hwnd: string }> {
  const child = spawn(exe, ['--background-fixture', '--code-navigation-fixture', '--auto-close=90000'], {
    cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  try {
    return await new Promise((resolve, reject) => {
      let output = '';
      let errors = '';
      const timer = setTimeout(() => reject(new Error('Source repair fixture READY timeout: ' + errors)), 15000);
      const finishError = (error: Error) => { clearTimeout(timer); reject(error); };
      child.once('error', finishError);
      child.once('exit', code => finishError(new Error('Source repair fixture exited: ' + code + ' ' + errors)));
      child.stderr!.on('data', chunk => { errors = (errors + chunk).slice(-4000); });
      child.stdout!.on('data', chunk => {
        output = (output + chunk).slice(-8000);
        const ready = /READY\s+(\d+)\s+(0x[0-9a-fA-F]+)/.exec(output);
        if (!ready) return;
        clearTimeout(timer);
        const pid = Number(ready[1]);
        if (pid !== child.pid) { reject(new Error('Fixture READY PID differs from owned process.')); return; }
        resolve({ child, pid, hwnd: ready[2] });
      });
    });
  } catch (error) {
    await stop(child);
    throw error;
  }
}

it('real isolated WPF source repair closes runtime → XAML → C# → precise body → rebuilt runtime', {
  skip: process.platform !== 'win32', timeout: 180000,
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-ui-code-runtime-'));
  const relativeToRepo = path.relative(repo, root);
  assert.ok(path.isAbsolute(relativeToRepo) || relativeToRepo === '..' || relativeToRepo.startsWith('..' + path.sep),
    'fixture source must be outside the repository');
  const sourceRoot = path.join(root, 'source');
  const output = path.join(root, 'publish');
  const project = path.join(sourceRoot, 'wpf-ui-review.csproj');
  const codePath = path.join(sourceRoot, 'MainWindow.xaml.cs');
  const exe = path.join(output, 'wpf-ui-review.exe');
  const client = new Client({ name: 'ui-code-runtime-acceptance', version: '1' });
  let transport: StdioClientTransport | undefined;
  let running: Awaited<ReturnType<typeof launch>> | undefined;
  const originalFiles = new Map<string, string>();
  const dotnetEnvironment = { ...process.env, DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' };
  const compile = async () => {
    await runFile('dotnet', ['publish', project, '--no-restore', '-c', 'Release', '-o', output, '-p:NuGetAudit=false'], {
      cwd: root, env: dotnetEnvironment, windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024,
    });
  };
  const call = async <T = any>(name: string, args: Record<string, unknown>): Promise<T> => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const block = (result.content as { type: string; text?: string }[]).find(item => item.type === 'text');
    assert.ok(block?.text, name + ' must return JSON text');
    return JSON.parse(block.text) as T;
  };
  try {
    await fs.mkdir(sourceRoot);
    await fs.copyFile(path.join(repo, 'global.json'), path.join(root, 'global.json'));
    await fs.mkdir(path.join(root, 'offline-feed'));
    for (const file of fixtureFiles) {
      const content = await fs.readFile(path.join(repo, 'tests/fixtures/wpf-ui-review', file));
      originalFiles.set(file, sha256(content));
      await fs.writeFile(path.join(sourceRoot, file), content);
    }
    const beforeSource = await fs.readFile(codePath, 'utf8');
    assert.equal(beforeSource.split(defect).length, 2, 'only one known source defect may be repaired');
    const nugetConfig = path.join(root, 'NuGet.Config');
    await fs.writeFile(nugetConfig, '<configuration><packageSources><clear/><add key="offline" value="offline-feed"/></packageSources></configuration>');
    // All package sources are replaced by an empty local feed. Existing SDK packs/cache only.
    await runFile('dotnet', ['restore', project, '--locked-mode', '--configfile', nugetConfig, '-p:NuGetAudit=false'], {
      cwd: root, env: dotnetEnvironment, windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024,
    });
    await compile();
    const beforeAssembly = sha256(await fs.readFile(path.join(output, 'wpf-ui-review.dll')));

    const distUrl = (file: string) => JSON.stringify(pathToFileURL(path.join(repo, 'dist', file)).href);
    const bootstrap = path.join(root, 'probe.mjs');
    await fs.writeFile(bootstrap, `
import { getDefaultConfig } from ${distUrl('Core/Config.js')};
import { ToolRouter } from ${distUrl('Core/ToolRouter.js')};
import { WinCodeMcpServer } from ${distUrl('Gateway/McpServer.js')};
const config = getDefaultConfig(${JSON.stringify(sourceRoot)});
config.cacheDir = ${JSON.stringify(path.join(root, 'cache'))};
config.adapters.serena.enabled = false;
config.adapters.repomix.useCli = false;
const server = new WinCodeMcpServer(new ToolRouter(config));
process.stdin.on('end', () => { void server.stop(); });
process.on('SIGTERM', () => { void server.stop(); });
await server.start();
`);
    transport = new StdioClientTransport({ command: process.execPath, args: [bootstrap], cwd: root, stderr: 'pipe' });
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    const schema = tools.find(tool => tool.name === 'wincode_ui_review')?.inputSchema;
    assert.ok(schema?.properties?.candidateCodeFiles, 'build the R6 gateway before running the real fixture');
    const hello = await call('wincode_hello_world', {});
    assert.equal(hello.runtime.build.status, 'verified');

    const inspect = async (): Promise<UiReviewResult> => {
      assert.ok(running);
      const result = await call<UiReviewResult>('wincode_ui_review', {
        pid: running.pid, hwnd: running.hwnd, backgroundOnly: true, capture: 'none',
        query: { automationId: 'btnCodeNavigation', maxSearchNodes: 500, maxMatches: 2 },
        maxDepth: 2, maxNodes: 10,
        candidateFiles: ['MainWindow.xaml'], candidateCodeFiles: ['MainWindow.xaml.cs'],
      });
      assert.equal(result.success, true);
      assert.equal(result.tree?.automationId, 'btnCodeNavigation');
      assert.equal(result.queryResult?.status, 'unique');
      assert.equal(result.queryResult?.searchComplete, true);
      return result;
    };
    running = await launch(exe, sourceRoot);
    const beforePid = running.pid;
    const disabled = await inspect();
    assert.equal(disabled.tree!.isEnabled, false);
    const xaml = disabled.sourceEvidence!.nodes.find(node => node.nodeId === disabled.tree!.id)!;
    assert.equal(xaml.candidateCount, 1);
    assert.equal(xaml.candidates[0].declarations.Command, '{Binding ReviewActionCommand}');
    assert.equal(disabled.codeEvidence!.runtimeSourceVerified, false, 'mapper still reports candidates, not established binding causality');
    const clue = disabled.codeEvidence!.clues.find(item => item.identifier === 'ReviewActionCommand')!;
    assert.equal(clue.status, 'candidate');
    const assignment = clue.candidates.find(item => item.kind === 'assignment')!;
    assert.equal(assignment.relatedSymbol, 'CanExecuteReviewAction');
    assert.equal(assignment.fileSha256, sha256(beforeSource));
    const assignmentBody = await call('wincode_prepare_context', { ...assignment.nextRequest, maxTokens: 4000 });
    assert.equal(assignmentBody.coverage.allRequestedCovered, true);
    const assignmentText = assignmentBody.evidence.map((item: any) => item.snippet).join('\n');
    const predicateName = /\bnew SourceRepairCommand\((\w+)\)/.exec(assignmentText)?.[1];
    assert.equal(predicateName, 'CanExecuteReviewAction', 'read the actual constructor argument before following the candidate');
    const predicateRequest = { task: 'Read the predicate named by the retrieved command assignment.',
      scopeFiles: ['MainWindow.xaml.cs'], symbol: predicateName, maxTokens: 4000 };
    const precise = await call('wincode_prepare_context', predicateRequest);
    const body = precise.evidence.find((item: any) => item.file === 'MainWindow.xaml.cs' && item.snippet.includes(defect));
    assert.ok(body, 'the scoped follow-up must return the actual false predicate body, not only its declaration');
    assert.match(body.snippet, /private bool CanExecuteReviewAction\(\)/);
    assert.equal(body.snippet, beforeSource.split(/\r?\n/).slice(body.startLine - 1, body.endLine).join('\n'));

    await stop(running.child);
    assert.throws(() => process.kill(beforePid, 0), 'old build must exit before source repair/rebuild');
    running = undefined;
    const repairedSource = beforeSource.replace(defect, repair);
    await fs.writeFile(codePath, repairedSource);
    assert.notEqual(sha256(repairedSource), sha256(beforeSource));
    await compile();
    const afterAssembly = sha256(await fs.readFile(path.join(output, 'wpf-ui-review.dll')));
    assert.notEqual(afterAssembly, beforeAssembly, 'a newly compiled assembly must contain the source repair');
    running = await launch(exe, sourceRoot);
    const enabled = await inspect();
    assert.equal(enabled.tree!.isEnabled, true, 'same fixture arguments must become enabled after rebuilding the changed source');
    const repairedClue = enabled.codeEvidence!.clues.find(item => item.identifier === 'ReviewActionCommand')!;
    const repairedAssignment = repairedClue.candidates.find(item => item.kind === 'assignment')!;
    assert.equal(repairedAssignment.fileSha256, sha256(repairedSource));
    const repairedBody = await call('wincode_prepare_context', predicateRequest);
    assert.ok(repairedBody.evidence.some((item: any) => item.snippet.includes(repair)));
    assert.ok(!repairedBody.evidence.some((item: any) => item.snippet.includes(defect)), 'precise retrieval must not reuse the stale predicate');
    t.diagnostic(JSON.stringify({ transport: 'stdio', source: 'external isolated fixture copy',
      before: { enabled: false, pid: beforePid, sourceSha256: sha256(beforeSource), assemblySha256: beforeAssembly },
      after: { enabled: true, pid: running.pid, sourceSha256: sha256(repairedSource), assemblySha256: afterAssembly },
      nextRequest: assignment.nextRequest, predicateRequest, sourcePredicateRead: true, sameLaunchArguments: true,
      mapperRuntimeSourceVerified: enabled.codeEvidence!.runtimeSourceVerified,
    }));
  } finally {
    try { if (running) await stop(running.child); }
    finally {
      try { await client.close(); }
      finally {
        try { await transport?.close(); }
        finally {
          for (const [file, hash] of originalFiles) assert.equal(sha256(await fs.readFile(path.join(repo, 'tests/fixtures/wpf-ui-review', file))), hash,
            'runtime repair must not modify the repository fixture: ' + file);
          assert.equal(path.dirname(root), os.tmpdir());
          assert.ok(path.basename(root).startsWith('wincode-ui-code-runtime-'));
          await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        }
      }
    }
  }
});
