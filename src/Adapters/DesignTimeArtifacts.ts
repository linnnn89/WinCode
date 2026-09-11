import fs from 'node:fs/promises';
import path from 'node:path';

/** Only call after the owned Host/process-tree shutdown has completed. Never accepts an external PID. */
export async function cleanupDesignTimeArtifacts(root: string, instance: string): Promise<void> {
  if (!/^[a-f0-9]{32}$/.test(instance) || !path.isAbsolute(root)) throw new Error('Invalid build output owner.');
  root = path.resolve(root);
  const storage = path.join(root, '.cache', 'wincode-build', instance);
  const checked = async (target: string): Promise<boolean> => {
    const relative = path.relative(root, target);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error('Build output cleanup escaped the workspace.');
    for (let current = target; ; current = path.dirname(current)) {
      const stat = await fs.lstat(current).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (stat?.isSymbolicLink()) throw new Error('Build output cleanup refuses linked paths.');
      if (current === root) break;
    }
    return fs.access(target).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
  };
  if (!await checked(storage)) return;
  const file = path.join(storage, 'owner.json');
  if (!await checked(file)) throw new Error('Build output ownership manifest is missing.');
  if ((await fs.stat(file)).size > 512 * 1024) throw new Error('Build output ownership manifest exceeds budget.');
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  if (manifest.version !== 1 || manifest.instance !== instance || !Array.isArray(manifest.paths) || manifest.paths.length > 128)
    throw new Error('Invalid build output ownership manifest.');
  const directories: string[] = [];
  for (const relative of manifest.paths) {
    if (typeof relative !== 'string' || path.isAbsolute(relative)) throw new Error('Invalid private output path.');
    const directory = path.resolve(root, relative);
    if (!directory.toLowerCase().endsWith(`${path.sep}.cache${path.sep}wincode-msbuild${path.sep}${instance}`))
      throw new Error('Private output identity does not match its owner.');
    if (await checked(directory)) directories.push(directory);
  }
  // Validate the entire bounded tree before deleting anything; reparse paths are never traversed.
  const pending = [...directories, storage]; let entries = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (++entries > 16384) throw new Error('Private cleanup entry budget exceeded.');
      if (entry.isSymbolicLink()) throw new Error('Private cleanup refuses linked entries.');
      if (entry.isDirectory()) pending.push(path.join(directory, entry.name));
    }
  }
  for (const directory of [...directories, storage]) {
    if (await checked(directory)) await fs.rm(directory, { recursive: true, maxRetries: 4, retryDelay: 50 });
  }
}
