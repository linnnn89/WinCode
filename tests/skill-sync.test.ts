import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const { syncSkill, managedFiles } = await import(new URL('../scripts/sync-skill.mjs', import.meta.url).href);

it('skill check is read-only; explicit sync backs up old docs and preserves local extras', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-skill-sync-'));
  const target = path.join(root, 'wincode');
  try {
    const missing = await syncSkill(target);
    assert.equal(missing.matched, false);
    await assert.rejects(fs.access(target));
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'SKILL.md'), 'local old instructions');
    await fs.writeFile(path.join(target, 'personal-note.md'), 'keep me');
    const before = await fs.readdir(root);
    assert.equal((await syncSkill(target)).matched, false);
    assert.deepEqual(await fs.readdir(root), before);
    const result = await syncSkill(target, { apply: true });
    assert.equal(result.matched, true);
    assert.equal(await fs.readFile(path.join(result.backupDirectory!, 'SKILL.md.bak'), 'utf8'), 'local old instructions');
    await assert.rejects(fs.access(path.join(result.backupDirectory!, 'SKILL.md')));
    assert.equal(await fs.readFile(path.join(target, 'personal-note.md'), 'utf8'), 'keep me');
    for (const file of managedFiles)
      assert.deepEqual(await fs.readFile(path.join(target, file)), await fs.readFile(path.join('skills/wincode', file)));
    assert.equal((await syncSkill(target)).matched, true);
    assert.equal((await syncSkill(target, { apply: true })).backupDirectory, undefined);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('skill sync refuses relative paths and linked destinations before changing either tree', async () => {
  await assert.rejects(syncSkill('relative'), /absolute/);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-skill-link-'));
  try {
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside);
    const target = path.join(root, 'wincode');
    await fs.symlink(outside, target, 'junction');
    await assert.rejects(syncSkill(target, { apply: true }), /Linked skill/);
    assert.deepEqual(await fs.readdir(outside), []);
    await fs.unlink(target);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
