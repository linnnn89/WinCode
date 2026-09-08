import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const source = fileURLToPath(new URL('../skills/wincode/', import.meta.url));
export const managedFiles = ['SKILL.md', 'references/code.md', 'references/ui.md', 'references/diagnostics.md'];
const hash = value => createHash('sha256').update(value).digest('hex');

async function rejectLinks(target) {
  for (let current = target; ; current = path.dirname(current)) {
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) throw new Error(`Linked skill paths are unsupported: ${current}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (path.dirname(current) === current) break;
  }
}

/** Explicit local deployment of four managed documents; never touches MCP configuration. */
export async function syncSkill(target, { apply = false } = {}) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) throw new Error('Supply an absolute installed wincode skill directory.');
  target = path.resolve(target);
  await rejectLinks(target);
  const records = [];
  for (const file of managedFiles) {
    const full = path.join(target, file);
    await rejectLinks(full);
    const expected = await fs.readFile(path.join(source, file));
    let previous = null;
    try { previous = await fs.readFile(full); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    records.push({ file, full, expected, previous, changed: !previous || hash(previous) !== hash(expected) });
  }
  const changed = records.filter(record => record.changed);
  let backupDirectory;
  if (apply && changed.length) {
    backupDirectory = path.join(path.dirname(target), `.wincode-backup-${randomUUID()}`);
    await fs.mkdir(backupDirectory);
    // Finish every backup before overwriting any installed document. Extra files are untouched.
    for (const record of changed.filter(record => record.previous !== null)) {
      // Backups under a skill discovery root must not themselves expose a SKILL.md.
      const backup = path.join(backupDirectory, `${record.file}.bak`);
      await fs.mkdir(path.dirname(backup), { recursive: true });
      await fs.writeFile(backup, record.previous, { flag: 'wx' });
    }
    try {
      for (const record of changed) {
        await rejectLinks(record.full);
        let current = null;
        try { current = await fs.readFile(record.full); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (current === null ? record.previous !== null : record.previous === null || !current.equals(record.previous))
          throw new Error(`Installed document changed during sync: ${record.file}`);
        await fs.mkdir(path.dirname(record.full), { recursive: true });
        const temporary = `${record.full}.${randomUUID()}.tmp`;
        try {
          await fs.writeFile(temporary, record.expected, { flag: 'wx' });
          await fs.rename(temporary, record.full);
        } finally { await fs.rm(temporary, { force: true }); }
      }
      for (const record of records)
        if (hash(await fs.readFile(record.full)) !== hash(record.expected)) throw new Error(`Verification failed: ${record.file}`);
    } catch (error) { throw new Error(`${error.message}; original documents retained in ${backupDirectory}`); }
  }
  return { target, mode: apply ? 'apply' : 'check', matched: apply || changed.length === 0,
    changedFiles: changed.map(record => record.file), ...(backupDirectory ? { backupDirectory } : {}) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const positional = args.filter(arg => arg !== '--apply');
  if (positional.length !== 1 || args.length !== positional.length + Number(args.includes('--apply'))) {
    console.error('Usage: node scripts/sync-skill.mjs <absolute installed skill directory> [--apply]');
    process.exitCode = 1;
  } else {
    syncSkill(positional[0], { apply: args.includes('--apply') }).then(result => {
      console.log(JSON.stringify(result, null, 2));
      if (!result.matched) process.exitCode = 2;
    }).catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}
