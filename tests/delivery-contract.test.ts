import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nativeFs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { getDefaultConfig } from '../src/Core/Config.js';
import { FlaUiAdapter } from '../src/Adapters/FlaUiAdapter.js';

const build = await import(pathToFileURL(path.resolve('scripts/build.mjs')).href);
const delivery = await import(pathToFileURL(path.resolve('scripts/delivery-manifest.mjs')).href);
const version = '1.2.3';
const identity = { version, configuration: 'Release', informationalVersion: version, framework: '.NET fixture' };
const toolchains = { node: 'fixture', dotnet: 'fixture', npm: null };

async function fixture(run: (root: string, manifest: any) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-delivery-'));
  async function write(file: string, content: string) {
    const target = path.join(root, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  try {
    for (const [file, content] of Object.entries({
      'package.json': JSON.stringify({ version }), 'package-lock.json': '{}', 'global.json': '{}', 'tsconfig.json': '{}',
      'scripts/build.mjs': '// fixture', 'src/Main.ts': 'export const fixture = true;', 'dist/Main.js': 'export const fixture = true;',
      'tools/WinCode.UIA.Host/WinCode.UIA.Host.csproj': '<Project />', 'tools/WinCode.UIA.Host/packages.lock.json': '{}',
      'skills/wincode/SKILL.md': 'fixture skill', 'skills/wincode/references/code.md': 'code',
      'skills/wincode/references/ui.md': 'ui', 'skills/wincode/references/diagnostics.md': 'diagnostics',
    })) await write(file, content);
    for (const name of ['WinCode.UIA.Host.exe', 'WinCode.UIA.Host.dll', 'WinCode.UIA.Host.deps.json', 'WinCode.UIA.Host.runtimeconfig.json', 'dependency.dll'])
      await write(`${delivery.hostDirectory}/${name}`, 'fixture bytes; never executed');
    const gateway = await build.createBuildManifest(root, await build.collectBuildInputs(root), version);
    await write('dist/build-manifest.json', JSON.stringify(gateway));
    const contents = await delivery.collectDelivery(root, identity, toolchains);
    await run(root, { formatVersion: 1, contentId: delivery.deliveryId(contents), delivery: contents, revision: null, createdAt: 'first' });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

it('delivery identity is stable across timestamps and verifies all component records', async () => fixture(async (root, manifest) => {
  const second = await delivery.collectDelivery(root, identity, toolchains);
  assert.equal(delivery.deliveryId(second), manifest.contentId);
  assert.equal((await delivery.verifyDelivery(root, { ...manifest, createdAt: 'later' })).matched, true);
  assert.deepEqual(Object.keys(manifest.delivery.components), ['gateway', 'host', 'skill', 'configuration']);
}));

for (const file of ['src/Main.ts', 'dist/Main.js', `${delivery.hostDirectory}/dependency.dll`, 'skills/wincode/references/code.md', 'global.json']) {
  it(`delivery rejects changed ${file}`, async () => fixture(async (root, manifest) => {
    await fs.appendFile(path.join(root, file), '\nchanged');
    await assert.rejects(delivery.verifyDelivery(root, manifest), /changed|identity|incomplete/i);
  }));
}

it('delivery rejects a missing Host sidecar and an added unrecorded DLL', async () => fixture(async (root, manifest) => {
  const extra = path.join(root, delivery.hostDirectory, 'extra.dll');
  await fs.writeFile(extra, 'extra');
  await assert.rejects(delivery.verifyDelivery(root, manifest), /changed|incomplete/);
  await fs.unlink(extra);
  await fs.unlink(path.join(root, delivery.hostDirectory, 'WinCode.UIA.Host.runtimeconfig.json'));
  await assert.rejects(delivery.verifyDelivery(root, manifest), /Missing Host sidecar/);
}));

it('delivery rejects version disagreement and development Host output', async () => fixture(async root => {
  await assert.rejects(delivery.collectDelivery(root, { ...identity, version: '0.0.1' }, toolchains), /versions must agree/);
  await assert.rejects(delivery.collectDelivery(root, { ...identity, configuration: 'Debug' }, toolchains), /versions must agree/);
}));

it('release Host resolution never silently falls back to Debug or dotnet run', t => {
  const config = getDefaultConfig(process.cwd());
  const adapter = new FlaUiAdapter(config);
  t.mock.method(nativeFs, 'existsSync', (file: nativeFs.PathLike) => !String(file).includes('/Release/') && !String(file).includes('\\Release\\'));
  assert.equal(adapter.resolveHostCommand(), null);
  config.adapters.flaui.hostMode = 'development';
  assert.match(adapter.resolveHostCommand()!.command, /Debug/);
  config.adapters.flaui.customHostPath = path.resolve('fixture-host.exe');
  assert.equal(adapter.resolveHostCommand()!.command, config.adapters.flaui.customHostPath);
});
