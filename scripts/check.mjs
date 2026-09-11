import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDotnet } from './lib/dotnet.mjs';
import { runCheckStage, testReporters } from './lib/check-stage.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const desktop = process.argv.includes('--desktop');
const inventoryOnly = process.argv.includes('--inventory');
if (process.argv.slice(2).some(arg => !['--desktop', '--inventory'].includes(arg))) throw new Error('Unknown check option.');

const groups = Object.fromEntries(['test', 'test:ui', 'test:ui-code'].map(name => [name,
  [...pkg.scripts[name].matchAll(/\btests\/[^\s]+\.test\.ts\b/g)].map(match => match[0])]));
const found = [];
async function discover(directory) {
  for (const entry of await fs.readdir(path.join(root, directory), { withFileTypes: true })) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory() && entry.name !== 'fixtures') await discover(relative);
    else if (entry.isFile() && entry.name.endsWith('.test.ts')) found.push(relative);
  }
}
await discover('tests');
const declared = Object.values(groups).flat();
if (new Set(declared).size !== declared.length || found.length !== declared.length || found.some(file => !declared.includes(file)))
  throw new Error('Test inventory differs from test/test:ui/test:ui-code. Declare every test exactly once.');
if (inventoryOnly) {
  console.log(JSON.stringify({ tests: declared.length, groups: Object.fromEntries(Object.entries(groups).map(([name, files]) => [name, files.length])) }));
} else {
  const toolchain = resolveDotnet(root);
  const directory = path.join(root, 'test-tmp/check', `${new Date().toISOString().replace(/[:.]/g, '-')}-${desktop ? 'desktop' : 'core'}`);
  await fs.mkdir(directory, { recursive: true });
  const report = { version: pkg.version, mode: desktop ? 'desktop' : 'core', startedAt: new Date().toISOString(),
    environment: { node: process.versions.node, platform: process.platform, arch: process.arch }, stages: [], success: false };
  async function run(name, command, args) {
    console.log(`[check] ${name}`);
    return runCheckStage({ report, directory, root, name, command: command === 'dotnet' ? toolchain.dotnet : command,
      args, env: toolchain.env });
  }
  const node = (name, args) => run(name, process.execPath, args);
  const tsc = path.join(root, 'node_modules/typescript/bin/tsc');
  const tsx = path.join(root, 'node_modules/tsx/dist/cli.mjs');
  const native = 'tools/WinCode.UIA.Host/WinCode.UIA.Host.csproj';
  const codeHost = 'tools/WinCode.Code.Host/WinCode.Code.Host.csproj';
  const tray = 'tools/WinCode.Tray/WinCode.Tray.csproj';
  const audit = 'tests/fixtures/ui-audit-check/ui-audit-check.csproj';
  const query = 'tests/fixtures/ui-query-check/ui-query-check.csproj';
  const ownerGuard = 'tests/fixtures/owner-guard-check/owner-guard-check.csproj';
  const wpf = 'tests/fixtures/wpf-ui-review/wpf-ui-review.csproj';
  const deterministic = ['-p:ContinuousIntegrationBuild=true', `-p:PathMap=${root}=/_/WinCode`];
  try {
    if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node 22 or newer is required; supported CI versions are 22 and 24.');
    if (desktop) {
      await node('verify-delivery', ['scripts/delivery-manifest.mjs', '--verify']);
      await run('restore-wpf', 'dotnet', ['restore', wpf, '--locked-mode']);
      await run('publish-wpf', 'dotnet', ['publish', wpf, '-c', 'Release', '-r', 'win-x64', '--no-self-contained', '--no-restore', ...deterministic]);
      await node('desktop-tests', [tsx, '--test', ...testReporters(directory, 'desktop-tests'), '--test-concurrency=1', ...groups['test:ui'], ...groups['test:ui-code']]);
      await node('desktop-owner-death', ['scripts/verify-owner-death.mjs', '--desktop']);
      await node('desktop-tray', ['scripts/verify-tray.mjs']);
      await node('desktop-tray-workflow', ['scripts/verify-tray-workflow.mjs']);
    } else {
      await node('typecheck', [tsc, '-p', 'tsconfig.test.json']);
      await node('build-gateway', ['scripts/build.mjs']);
      for (const [name, project] of [['host', native], ['code-host', codeHost], ['tray', tray], ['audit', audit], ['query', query], ['owner-guard', ownerGuard]])
        await run(`restore-${name}`, 'dotnet', ['restore', project, '--locked-mode']);
      await node('publish-host', ['scripts/publish-native.mjs', 'host']);
      await node('publish-code-host', ['scripts/publish-native.mjs', 'codeHost']);
      await node('publish-tray', ['scripts/publish-native.mjs', 'tray']);
      await run('build-audit', 'dotnet', ['build', audit, '-c', 'Debug', '--no-restore', ...deterministic]);
      await run('build-query', 'dotnet', ['build', query, '-c', 'Release', '--no-restore', ...deterministic]);
      await run('build-owner-guard', 'dotnet', ['build', ownerGuard, '-c', 'Release', '--no-restore', ...deterministic]);
      await node('regression', [tsx, '--test', ...testReporters(directory, 'regression'), ...groups.test]);
      const stdio = JSON.parse(await node('stdio', [tsx, 'scripts/test-mcp-client.ts']));
      report.runtime = { build: stdio.runtime?.build, schemaHash: stdio.schemaHash, toolCount: stdio.toolCount,
        resourceCleanup: stdio.resourceCleanup, codexConnectionVerified: false };
      await node('delivery-manifest', ['scripts/delivery-manifest.mjs']);
      report.delivery = JSON.parse(await node('verify-delivery', ['scripts/delivery-manifest.mjs', '--verify']));
    }
    report.success = true;
  } catch (error) {
    report.error = error.message;
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(`[check] ${report.success ? 'passed' : 'failed'}: ${path.join(directory, 'report.json')}`);
  }
}
