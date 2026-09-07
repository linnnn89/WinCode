import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { loadBuildIdentity, RUNTIME_IDENTITY } from '../src/Core/RuntimeIdentity.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildTools = await import(pathToFileURL(path.join(repository, 'scripts', 'build.mjs')).href);
const version = '1.2.3';

async function fixture(run: (root: string, moduleUrl: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-build-identity-'));
  try {
    await fs.mkdir(path.join(root, 'src', 'Core'), { recursive: true });
    await fs.mkdir(path.join(root, 'dist', 'Core'), { recursive: true });
    await fs.mkdir(path.join(root, 'scripts'));
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', version }));
    await fs.writeFile(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}');
    await fs.writeFile(path.join(root, 'tsconfig.json'), '{}');
    await fs.writeFile(path.join(root, 'scripts', 'build.mjs'), '// isolated build input');
    const source = await fs.readFile(path.join(repository, 'src', 'Core', 'RuntimeIdentity.ts'), 'utf8');
    await fs.writeFile(path.join(root, 'src', 'Core', 'RuntimeIdentity.ts'), source);
    await fs.writeFile(path.join(root, 'src', 'Core', 'Config.ts'), `export const WINCODE_VERSION = '${version}';`);
    await fs.writeFile(path.join(root, 'dist', 'Core', 'Config.js'), `export const WINCODE_VERSION = '${version}';`);
    await fs.writeFile(path.join(root, 'dist', 'Core', 'RuntimeIdentity.js'), ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, esModuleInterop: true },
    }).outputText);
    await writeManifest(root);
    await run(root, pathToFileURL(path.join(root, 'dist', 'Core', 'RuntimeIdentity.js')).href);
  } finally {
    assert.equal(path.dirname(root), os.tmpdir());
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function writeManifest(root: string) {
  const inputs = await buildTools.collectBuildInputs(root);
  const manifest = await buildTools.createBuildManifest(root, inputs, version, 'a'.repeat(40));
  await fs.writeFile(path.join(root, 'dist', 'build-manifest.json'), JSON.stringify(manifest));
  return manifest;
}

it('build identity reflects source contents even at the same version and Git revision', async () => fixture(async (root, moduleUrl) => {
  const before = loadBuildIdentity(moduleUrl, version);
  assert.equal(before.status, 'verified');
  assert.equal(before.version, version);
  const repeated = await writeManifest(root);
  assert.equal(repeated.buildId, before.buildId, 'timestamps alone do not change the content identity');
  await fs.appendFile(path.join(root, 'src', 'Core', 'Config.ts'), '\n// uncommitted implementation change');
  const changed = await writeManifest(root);
  assert.equal(changed.version, before.version);
  assert.equal(changed.revision, before.revision);
  assert.notEqual(changed.sourceHash, before.sourceHash);
  assert.notEqual(changed.buildId, before.buildId);
  assert.equal(loadBuildIdentity(moduleUrl, version).buildId, changed.buildId);
}));

it('running module identity is frozen while later disk manifests cannot relabel it', async () => fixture(async (root, moduleUrl) => {
  const firstModule = await import(moduleUrl);
  const snapshot = firstModule.RUNTIME_IDENTITY;
  assert.equal(snapshot.build.status, 'verified');
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.build), true);
  await fs.appendFile(path.join(root, 'src', 'Core', 'Config.ts'), '\n// next build');
  await writeManifest(root);
  assert.notEqual(loadBuildIdentity(moduleUrl, version).buildId, snapshot.build.buildId);
  assert.strictEqual((await import(moduleUrl)).RUNTIME_IDENTITY, snapshot);
  assert.equal((await import(moduleUrl)).RUNTIME_IDENTITY.build.buildId, snapshot.build.buildId);
}));

it('changed or missing compiled artifacts invalidate a manifest left by an earlier build', async () => fixture(async (root, moduleUrl) => {
  const artifact = path.join(root, 'dist', 'Core', 'Config.js');
  await fs.appendFile(artifact, '\n// direct tsc output changed');
  assert.equal(loadBuildIdentity(moduleUrl, version).reason, 'artifact-mismatch');
  await fs.rm(artifact);
  assert.equal(loadBuildIdentity(moduleUrl, version).reason, 'artifact-mismatch');
}));

it('development mode, missing manifests, malformed manifests and version mismatch stay unknown', async () => fixture(async (root, moduleUrl) => {
  const sourceUrl = pathToFileURL(path.join(root, 'src', 'Core', 'RuntimeIdentity.ts')).href;
  assert.equal(loadBuildIdentity(sourceUrl, version).reason, 'development-source');
  assert.equal(loadBuildIdentity(moduleUrl, '9.9.9').reason, 'version-mismatch');
  assert.equal(RUNTIME_IDENTITY.build.reason, 'development-source');
  const manifestPath = path.join(root, 'dist', 'build-manifest.json');
  await fs.writeFile(manifestPath, '{invalid');
  assert.equal(loadBuildIdentity(moduleUrl, version).reason, 'manifest-invalid');
  await fs.rm(manifestPath);
  const missing = loadBuildIdentity(moduleUrl, version);
  assert.equal(missing.reason, 'manifest-missing');
  assert.equal(missing.buildId, null);
}));

it('invalid manifest paths and forged identity hashes are rejected before they identify a build', async () => fixture(async (root, moduleUrl) => {
  const manifestPath = path.join(root, 'dist', 'build-manifest.json');
  const original = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  for (const invalid of [
    { ...original, artifacts: [{ path: '../outside.js', sha256: 'a'.repeat(64) }] },
    { ...original, artifacts: [{ path: '/absolute.js', sha256: 'a'.repeat(64) }] },
    { ...original, artifacts: [] },
    { ...original, buildId: 'b'.repeat(64) },
    { ...original, artifactHash: 'c'.repeat(64) },
  ]) {
    await fs.writeFile(manifestPath, JSON.stringify(invalid));
    assert.equal(loadBuildIdentity(moduleUrl, version).reason, 'manifest-invalid');
  }
}));

it('manifest creation refuses source changes between the precompile and postcompile snapshots', async () => fixture(async (root) => {
  const before = await buildTools.collectBuildInputs(root);
  await fs.appendFile(path.join(root, 'src', 'Core', 'Config.ts'), '\n// edited during compilation');
  await assert.rejects(buildTools.createBuildManifest(root, before, version), /changed during compilation/);
}));
