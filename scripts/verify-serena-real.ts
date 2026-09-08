import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SerenaAdapter } from '../src/Adapters/SerenaAdapter.js';
import { CacheManager } from '../src/Core/Cache.js';
import { getDefaultConfig } from '../src/Core/Config.js';
import { killProcessTree } from '../src/Core/ResourceManager.js';

// Explicit opt-in: use an already installed, isolated Serena command. Never install prerequisites here.
const [command, ...prefixArgs] = process.argv.slice(2);
if (!command || !path.isAbsolute(command)) throw new Error('Usage: test:serena-real -- <absolute command> [launcher arguments]. The command must accept Serena CLI arguments.');
await fs.access(command);
const root = path.resolve('test-tmp/serena-acceptance', `${Date.now()}-${process.pid}`);
await fs.mkdir(path.join(root, '.serena'), { recursive: true });
await fs.copyFile('global.json', path.join(root, 'global.json'));
await fs.writeFile(path.join(root, '.serena/project.yml'), 'project_name: wincode-real-acceptance\nlanguage_servers: [csharp]\nread_only: true\n');
await fs.writeFile(path.join(root, 'Fixture.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>');
const source = `namespace Fixture;
public class Service {
    public int Save(int value) { return value + 1; }
    public string Save(string value) { return value + "!"; }
    public int Unused() { return 42; }
}
public class Other {
    public int Save(int value) { return value - 1; }
}
public class Caller {
    public int Run() { return new Service().Save(7); }
    public string Text() { return new Service().Save("y"); }
}
`;
await fs.writeFile(path.join(root, 'Service.cs'), source);
const report: any = { startedAt: new Date().toISOString(), command, prefixArgs, fixture: root, stages: [], passed: false };
const adapters: SerenaAdapter[] = [];
async function create(active: boolean) {
  const config = getDefaultConfig(root);
  config.adapters.serena.customCommand = command;
  config.adapters.serena.customArgs = [...prefixArgs, 'start-mcp-server',
    ...(active ? ['--project', root] : []), '--enable-web-dashboard', 'false', '--open-web-dashboard', 'false',
    '--enable-gui-log-window', 'false', '--log-level', 'WARNING'];
  const cache = new CacheManager(path.join(root, active ? 'active-cache' : 'inactive-cache'));
  await cache.initialize();
  const adapter = new SerenaAdapter(config, cache);
  adapters.push(adapter);
  await adapter.initialize();
  return { adapter, config };
}
async function stage(name: string, run: () => Promise<unknown>) {
  const start = Date.now();
  try { const result = await run(); report.stages.push({ name, passed: true, ms: Date.now() - start, result }); }
  catch (error) { report.stages.push({ name, passed: false, ms: Date.now() - start, error: String(error) }); throw error; }
}
try {
  const { adapter, config } = await create(true);
  await stage('same-name and overload identities through WinCode adapter', async () => {
    const found = await adapter.findSymbolsDetailed('Save', undefined, 'Service.cs');
    assert.equal(found.source, 'serena-mcp'); assert.equal(found.queryComplete, true);
    assert.deepEqual(found.symbols.map(s => [s.namePath, s.line]), [
      ['Fixture/Service/Save[0]', 3], ['Fixture/Service/Save[1]', 4], ['Fixture/Other/Save', 8],
    ]);
    assert.equal(adapter.getUpstreamStatus().semanticQueryUsable, true);
    return { found, health: adapter.getUpstreamStatus() };
  });
  await stage('ambiguous name never selects an overload', async () => {
    const refs = await adapter.findReferencesDetailed('Save', 'Service.cs');
    assert.equal(refs.resolution, 'ambiguous'); assert.equal(refs.candidateCount, 3);
    assert.equal(refs.queryComplete, false); return refs;
  });
  await stage('explicit overload references retain containing-symbol coordinates', async () => {
    const results = [];
    for (const [name, preview, zeroReferenceLine] of [
      ['Fixture/Service/Save[0]', 'Save(7)', 10], ['Fixture/Service/Save[1]', 'Save("y")', 11],
    ] as const) {
      const refs = await adapter.findReferencesDetailed(name, 'Service.cs');
      assert.equal(refs.source, 'serena-mcp'); assert.equal(refs.queryComplete, true);
      assert.equal(refs.resolution, 'resolved'); assert.equal(refs.totalReferences, 1);
      assert.equal(refs.target?.namePath, name); assert.ok(refs.references[0].preview.includes(preview));
      const marked = refs.references[0].preview.split('\n').find(line => /^\s*>\s*\d+:/.test(line));
      assert.ok(marked?.includes(`>  ${zeroReferenceLine}:`) && marked.includes(preview), 'marked reference, not merely surrounding context, matches this overload');
      assert.equal(refs.references[0].lineKind, 'containing-symbol');
      assert.equal(refs.references[0].line, 10); results.push(refs);
    }
    return results;
  });
  await stage('real upstream body matches fixture source (direct upstream oracle)', async () => {
    // Test-only access to the actual connected upstream; do not add a public product API for this oracle.
    const result = await (adapter as any).serenaClient.callTool({ name: 'find_symbol', arguments: {
      name_path_pattern: '/Fixture/Service/Save[0]', relative_path: 'Service.cs', include_body: true,
    } });
    assert.notEqual(result.isError, true);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.length, 1); assert.equal(body[0].body, source.split('\n')[2].trim());
    return result;
  });
  await stage('valid empty symbols and references stay semantic', async () => {
    const empty = await adapter.findSymbolsDetailed('AbsentSymbol', undefined, 'Service.cs');
    const unused = await adapter.findReferencesDetailed('Fixture/Service/Unused', 'Service.cs');
    assert.equal(empty.source, 'serena-mcp'); assert.equal(empty.queryComplete, true); assert.equal(empty.totalFound, 0);
    assert.equal(unused.source, 'serena-mcp'); assert.equal(unused.queryComplete, true); assert.equal(unused.totalReferences, 0);
    return { empty, unused };
  });
  await stage('actual process interruption and unavailable restart degrade honestly', async () => {
    const pid = (adapter as any).serenaPid as number;
    assert.ok(pid > 0);
    // Only the test-owned Serena tree is terminated. Its restart command is made unavailable in this fixture.
    config.adapters.serena.customCommand = path.join(root, 'missing-serena.exe');
    await killProcessTree({ pid });
    for (let i = 0; i < 100 && adapter.getUpstreamStatus().handshakeOk; i++) await new Promise(r => setTimeout(r, 20));
    const fallback = await adapter.findSymbolsDetailed('Unused', undefined, 'Service.cs');
    assert.equal(fallback.source, 'serena-adapter-fallback');
    assert.equal(adapter.getUpstreamStatus().semanticQueryUsable, false);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    return { fallback, health: adapter.getUpstreamStatus(), pidExited: pid };
  });
  await stage('real unactivated project remains inactive', async () => {
    const { adapter: inactive } = await create(false);
    const found = await inactive.findSymbolsDetailed('Save', undefined, 'Service.cs');
    assert.equal(found.source, 'serena-adapter-fallback'); assert.equal(found.queryComplete, false);
    assert.equal(inactive.getUpstreamStatus().projectActive, false);
    return { found, health: inactive.getUpstreamStatus() };
  });
  assert.equal(await fs.readFile(path.join(root, 'Service.cs'), 'utf8'), source);
  report.passed = true;
} catch (error) { report.error = String(error); process.exitCode = 1; }
finally {
  const pids = adapters.map(a => (a as any).serenaPid as number | null).filter((p): p is number => Boolean(p));
  const cleanup = await Promise.allSettled(adapters.map(a => a.dispose()));
  report.cleanup = cleanup.map(r => r.status === 'fulfilled' ? { closed: true } : { closed: false, error: String(r.reason) });
  if (cleanup.some(r => r.status === 'rejected')) { report.passed = false; process.exitCode = 1; }
  report.pidExit = pids.map(pid => { try { process.kill(pid, 0); return { pid, exited: false }; } catch (e: any) { return {pid, exited: e.code === 'ESRCH'}; } });
  if (report.pidExit.some((p: any) => !p.exited)) { report.passed = false; process.exitCode = 1; }
  report.completedAt = new Date().toISOString();
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, stages: report.stages.map((s: any) => ({ name: s.name, passed: s.passed })), report: path.join(root, 'report.json') }));
}
