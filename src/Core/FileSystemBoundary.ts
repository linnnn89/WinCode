import fs from 'node:fs/promises';
import path from 'node:path';
import { isWorkspacePathInside } from './WorkspaceContracts.js';

/** Reject existing links in a writable path, including ancestors and Windows junctions.
 * Recheck immediately before mutations; this is not an atomic OS-handle sandbox. */
export async function assertLinkFreePath(target: string): Promise<void> {
  const resolved = path.resolve(target);
  let current = path.parse(resolved).root;
  for (const part of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`Unsafe filesystem path: link or junction at ${current}`);
      if (current !== resolved && !stat.isDirectory()) throw new Error(`Unsafe filesystem path: ancestor is not a directory at ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

/** Check both spelling and physical destination before accessing a workspace file. */
export async function resolveWorkspaceFile(root: string, relative: string): Promise<string> {
  const full = path.resolve(root, relative.replace(/\\/g, '/'));
  if (!isWorkspacePathInside(root, full)) throw new Error('File is outside the workspace.');
  const realRoot = await fs.realpath(root);
  const real = await fs.realpath(full);
  if (!isWorkspacePathInside(realRoot, real)) throw new Error('File resolves outside the workspace.');
  return real;
}
