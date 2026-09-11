import { it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { cleanupDesignTimeArtifacts } from '../src/Adapters/DesignTimeArtifacts.js';

const parent = path.resolve(import.meta.dirname, '../test-tmp');
const first = 'a'.repeat(32), second = 'b'.repeat(32);
async function fixture(t: TestContext) {
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'output-owner-'));
  t.after(async () => { assert.equal(path.dirname(directory), parent); await fs.rm(directory, { recursive: true, force: true }); });
  const root = path.join(directory, 'workspace'); await fs.mkdir(root);
  return { directory, root };
}
async function owner(root: string, id: string, paths = [`.cache/wincode-msbuild/${id}`]) {
  const storage = path.join(root, '.cache/wincode-build', id); await fs.mkdir(storage, { recursive: true });
  await fs.writeFile(path.join(storage, 'owner.json'), JSON.stringify({ version: 1, instance: id, paths }));
  return storage;
}
async function output(root: string, id: string) {
  const directory = path.join(root, '.cache/wincode-msbuild', id); await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, 'generated.cs'); await fs.writeFile(file, id); return file;
}
it('reclaims only the exited owner and preserves peer contents; repeat cleanup is harmless', async t => {
  const { root } = await fixture(t);
  await owner(root, first); await owner(root, second);
  const a = await output(root, first), b = await output(root, second);
  await cleanupDesignTimeArtifacts(root.replaceAll('\\', '/'), first);
  await assert.rejects(fs.stat(a), { code: 'ENOENT' }); assert.equal(await fs.readFile(b, 'utf8'), second);
  await cleanupDesignTimeArtifacts(root, first);
});
it('validates every ownership path before removing anything', async t => {
  const { root } = await fixture(t);
  await owner(root, first, [`.cache/wincode-msbuild/${first}`, `.cache/wincode-msbuild/${second}`]);
  const a = await output(root, first), b = await output(root, second);
  await assert.rejects(cleanupDesignTimeArtifacts(root, first), /identity/);
  assert.equal(await fs.readFile(a, 'utf8'), first); assert.equal(await fs.readFile(b, 'utf8'), second);
});
it('rejects a root escape even when the final namespace matches the UUID', async t => {
  const { root, directory } = await fixture(t);
  const external = path.join(directory, 'external'); await fs.mkdir(external);
  const sentinel = await output(external, first);
  await owner(root, first, [`../external/.cache/wincode-msbuild/${first}`]);
  await assert.rejects(cleanupDesignTimeArtifacts(root, first), /escaped/);
  assert.equal(await fs.readFile(sentinel, 'utf8'), first);
});
it('rejects junctions without following or deleting their target', async t => {
  const { root, directory } = await fixture(t);
  const external = path.join(directory, 'external'); await fs.mkdir(external);
  const sentinel = path.join(external, 'sentinel'); await fs.writeFile(sentinel, 'keep');
  await owner(root, first); await fs.mkdir(path.join(root, '.cache/wincode-msbuild'), { recursive: true });
  await fs.symlink(external, path.join(root, '.cache/wincode-msbuild', first), 'junction');
  await assert.rejects(cleanupDesignTimeArtifacts(root, first), /linked/);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'keep');
});
it('a corrupt manifest retains the output and reports failure', async t => {
  const { root } = await fixture(t); const storage = await owner(root, first);
  const file = await output(root, first); await fs.writeFile(path.join(storage, 'owner.json'), '{');
  await assert.rejects(cleanupDesignTimeArtifacts(root, first));
  assert.equal(await fs.readFile(file, 'utf8'), first);
});
