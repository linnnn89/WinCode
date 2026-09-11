import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runDotnet } from '../lib/dotnet.mjs';

export const hash = data => createHash('sha256').update(data).digest('hex');
export async function prototypeIdentity(repo) {
  const files = ['scripts/roslyn/design-time-prototypes.mjs', ...['PrototypeCoordination', 'BuildLayout', 'OwnedBuildOutputs']
    .map(name => `tests/fixtures/design-time-comparison/${name}.cs`)];
  return hash((await Promise.all(files.map(file => fs.readFile(path.join(repo, file))))).map(hash).join('\n'));
}
export async function sourceIdentity(repo) {
  const relative = (await fs.readdir(path.join(repo, 'tools/WinCode.Code.Host'))).filter(f => f.endsWith('.cs') || f.endsWith('.csproj'));
  const files = [...relative.map(f => `tools/WinCode.Code.Host/${f}`), 'tools/Shared/OwnerProcessGuard.cs', 'dist/build-manifest.json'];
  return Object.fromEntries(await Promise.all(files.map(async f => [f, hash(await fs.readFile(path.join(repo, f)))])));
}

/** Copy and instrument the current Host; production source, dist and native publish remain untouched. */
export async function buildPrototype(repo, root, sdk) {
  const directory = path.join(root, 'prototype'); await fs.mkdir(directory);
  for (const name of await fs.readdir(path.join(repo, 'tools/WinCode.Code.Host'))) {
    if (name.endsWith('.cs') || name.endsWith('.csproj') || name === 'packages.lock.json')
      await fs.copyFile(path.join(repo, 'tools/WinCode.Code.Host', name), path.join(directory, name));
  }
  await fs.copyFile(path.join(repo, 'tools/Shared/OwnerProcessGuard.cs'), path.join(directory, 'OwnerProcessGuard.cs'));
  await fs.copyFile(path.join(repo, 'tests/fixtures/design-time-comparison/PrototypeCoordination.cs'), path.join(directory, 'PrototypeCoordination.cs'));
  await fs.copyFile(path.join(repo, 'tests/fixtures/design-time-comparison/BuildLayout.cs'), path.join(directory, 'BuildLayout.cs'));
  await fs.copyFile(path.join(repo, 'tests/fixtures/design-time-comparison/OwnedBuildOutputs.cs'), path.join(directory, 'OwnedBuildOutputs.cs'));
  await fs.copyFile(path.join(repo, 'global.json'), path.join(root, 'global.json'));
  await fs.writeFile(path.join(root, 'NuGet.Config'), '<configuration><packageSources><clear /></packageSources></configuration>');
  const project = path.join(directory, 'WinCode.Code.Host.csproj');
  await fs.writeFile(project, (await fs.readFile(project, 'utf8')).replace(/\s*<Compile Include="\.\.\/Shared\/OwnerProcessGuard.cs"[^>]*\/>/, '')
    .replace('</Project>', '<ItemGroup><Reference Include="Microsoft.Build"><HintPath>$(MSBuildBinPath)/Microsoft.Build.dll</HintPath><Private>false</Private></Reference></ItemGroup></Project>'));
  const session = path.join(directory, 'WorkspaceSession.cs');
  let text = (await fs.readFile(session, 'utf8')).replaceAll('\r\n', '\n');
  const properties = 'MSBuildWorkspace.Create(new Dictionary<string, string> {\n                ["Configuration"] = configuration, ["TargetFramework"] = framework,\n                ["RunAnalyzers"] = "false", ["RunAnalyzersDuringBuild"] = "false"\n            })';
  assert.ok(text.includes(properties));
  text = text.replace(properties, 'MSBuildWorkspace.Create(PrototypeCoordination.Properties(configuration, framework))');
  const entry = 'public async Task<object> ReloadAsync(string? id, CancellationToken token)\n    {';
  assert.ok(text.includes(entry));
  text = text.replace(entry, entry + '\n        using var coordination = await PrototypeCoordination.EnterAsync(root, token);');
  text = text.replace('workspace = MSBuildWorkspace.Create(PrototypeCoordination.Properties(configuration, framework));',
    'if (PrototypeCoordination.Mode == "private2") BuildLayout.Prepare(root, projectPath, configuration, framework, PrototypeCoordination.Instance, token);\n            workspace = MSBuildWorkspace.Create(PrototypeCoordination.Properties(configuration, framework));');
  text = text.replace('projects = candidate.ProjectIds.Count, configuration, framework, loadMs = clock.ElapsedMilliseconds,',
    'projects = candidate.ProjectIds.Count, configuration, framework, loadMs = clock.ElapsedMilliseconds,\n                    prototype = new { mode = PrototypeCoordination.Mode, instance = PrototypeCoordination.Instance, waitMs = PrototypeCoordination.LastWaitMs, intermediate = PrototypeCoordination.LastIntermediate },');
  text = text.replace('finally { ReleaseWorkspace(); }', 'finally { ReleaseWorkspace(); OwnedBuildOutputs.Current?.Dispose(); }');
  await fs.writeFile(session, text);
  const inputs = path.join(directory, 'WorkspaceInputs.cs');
  await fs.writeFile(inputs, (await fs.readFile(inputs, 'utf8')).replace('else if (IsAutomaticInput(entry)) paths.Add(entry);',
    'else if (IsAutomaticInput(entry) && BuildLayout.IsCandidate(entry)) paths.Add(entry);'));
  const restore = runDotnet(sdk, ['restore', project, '--locked-mode', '--configfile', path.join(root, 'NuGet.Config'), '--nologo'], repo);
  const output = path.join(directory, 'publish');
  const build = runDotnet(sdk, ['publish', project, '-c', 'Release', '--no-restore', '-o', output, '--nologo'], repo);
  await fs.writeFile(path.join(root, 'prototype-build.log'), restore + '\n' + build);
  const host = path.join(output, 'WinCode.Code.Host.dll');
  return { host, assemblyHash: hash(await fs.readFile(host)), productionInputs: await sourceIdentity(repo),
    instrumentationHash: await prototypeIdentity(repo) };
}

export async function fixture(root, sdk, name, type = name) {
  const directory = path.join(root, name); await fs.mkdir(directory, { recursive: true });
  const write = async (file, text) => { await fs.mkdir(path.dirname(path.join(directory, file)), { recursive: true }); await fs.writeFile(path.join(directory, file), text); };
  const props = '<TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable><EnableNETAnalyzers>false</EnableNETAnalyzers>';
  const api = 'namespace Probe; public static class Api { public static void Save(int x) {} }';
  let project = 'App.csproj', framework = 'net10.0', projects = 1, references = 1;
  const use = 'namespace Probe; public class Use { public void Run() { Api.Save(1); } }';
  if (type === 'graph') {
    project = 'App/App.csproj'; projects = 2;
    await write('Lib/Lib.csproj', `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>${props}</PropertyGroup></Project>`);
    await write('Lib/Api.cs', api);
    await write(project, `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>${props}</PropertyGroup><ItemGroup><ProjectReference Include="../Lib/Lib.csproj" /></ItemGroup></Project>`);
    await write('App/Use.cs', use);
    await write('Peer/Peer.csproj', `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>${props}</PropertyGroup><ItemGroup><ProjectReference Include="../Lib/Lib.csproj" /></ItemGroup></Project>`);
    await write('Peer/Use.cs', use);
  } else if (type === 'wpf') {
    framework = 'net10.0-windows';
    await write(project, `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>${props.replace('net10.0','net10.0-windows')}<UseWPF>true</UseWPF></PropertyGroup></Project>`);
    await write('Api.cs', api);
    await write('MainWindow.xaml', '<Window x:Class="Probe.MainWindow" xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"><Button x:Name="SaveButton" Click="HandleSave">Save</Button></Window>');
    await write('MainWindow.xaml.cs', 'namespace Probe; public partial class MainWindow : System.Windows.Window { public MainWindow() { InitializeComponent(); } private void HandleSave(object sender, System.Windows.RoutedEventArgs e) { Api.Save(1); } }');
  } else {
    if (type === 'custom') await write('Directory.Build.props', '<Project><PropertyGroup><BaseIntermediateOutputPath>artifacts/obj/</BaseIntermediateOutputPath><IntermediateOutputPath>artifacts/int/$(Configuration)/$(TargetFramework)/</IntermediateOutputPath></PropertyGroup></Project>');
    await write(project, `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>${type === 'multi'
      ? props.replace('<TargetFramework>net10.0</TargetFramework>', '<TargetFrameworks>net10.0;net10.0-windows</TargetFrameworks>') : props}</PropertyGroup>${type === 'multi'
      ? '<PropertyGroup Condition="\'$(TargetFramework)\' == \'net10.0-windows\'"><DefineConstants>$(DefineConstants);SECOND_FRAMEWORK</DefineConstants></PropertyGroup>' : ''}</Project>`);
    await write('Api.cs', api); await write('Use.cs', type === 'multi'
      ? 'namespace Probe; public class Use { public void Run() { Api.Save(1);\n#if SECOND_FRAMEWORK\nApi.Save(2);\n#endif\n} }' : use);
  }
  const restore = runDotnet(sdk, ['restore', path.join(directory, project), '--configfile', path.join(root, 'NuGet.Config'), '--nologo'], root, 30000);
  if (type === 'graph') runDotnet(sdk, ['restore', path.join(directory, 'Peer/Peer.csproj'), '--configfile', path.join(root, 'NuGet.Config'), '--nologo'], root, 30000);
  await fs.writeFile(path.join(root, `${name}-restore.log`), restore);
  return { root: directory, project, framework, projects, references, type,
    projectDirectories: type === 'graph' ? ['App', 'Lib', 'Peer'].map(p => path.join(directory, p)) : [directory] };
}

/** Real MSBuild Exec descendant, enabled only in the selected prototype child environment. */
export async function installBlocker(project) {
  const directory = path.join(project.root, '.cache/n4-blockers'); await fs.mkdir(directory, { recursive: true });
  const script = path.join(directory, 'block.mjs');
  await fs.writeFile(script, "import fs from 'node:fs'; import path from 'node:path'; const id=process.env.WINCODE_BUILD_INSTANCE ?? process.env.WINCODE_N4_INSTANCE; if(!/^[a-f0-9]{32}$/.test(id)) throw new Error('Missing Host identity'); const root=process.argv[2]; fs.writeFileSync(path.join(root,id+'.json'),JSON.stringify({pid:process.pid,parent:process.ppid})); const timer=setInterval(()=>{if(fs.existsSync(path.join(root,id+'.release'))){clearInterval(timer);process.exit(0)}},20);\n");
  const escape = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  const target = `<Target Name="WinCodeComparisonBlock" BeforeTargets="GenerateMSBuildEditorConfigFileCore" Condition="('$(DesignTimeBuild)' == 'true' and '$(WINCODE_N4_BLOCK)' == '1') or '$(WINCODE_N4_EXTERNAL_HOLD)' == '1'"><Exec Command="${escape(`"${process.execPath}" "${script}" "${directory}"`)}" /></Target>`;
  const file = path.join(project.root, project.project);
  await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('</Project>', target + '</Project>'));
  return { directory, marker: id => path.join(directory, id + '.json'), release: id => fs.writeFile(path.join(directory, id + '.release'), '') };
}

/** Inspect and remove only the current test Host's private directories after its actual process cleanup. */
export async function privateOutputs(project, identity, remove = false) {
  assert.match(identity, /^[a-f0-9]{32}$/);
  const records = []; let bytes = 0;
  for (const projectDirectory of project.projectDirectories) {
    const parent = path.resolve(projectDirectory, '.cache/wincode-msbuild');
    const directory = path.resolve(parent, identity);
    assert.equal(path.dirname(directory), parent);
    const stat = await fs.lstat(directory).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (!stat) continue;
    assert.equal((await fs.realpath(directory)).toLowerCase(), directory.toLowerCase(), 'private cleanup must not follow links');
    async function walk(dir) {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        assert.equal(entry.isSymbolicLink(), false); assert.ok(records.length < 1000);
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(file);
        else { const data = await fs.readFile(file); bytes += data.length; assert.ok(bytes <= 64 * 1024 * 1024);
          records.push({ path: path.relative(project.root, file), bytes: data.length, sha256: hash(data) }); }
      }
    }
    await walk(directory);
    if (remove) await fs.rm(directory, { recursive: true });
  }
  return { bytes, files: records.length, records, removed: remove };
}
