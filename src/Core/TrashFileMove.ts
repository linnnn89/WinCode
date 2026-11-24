import { execFile } from 'node:child_process';
import type { BigIntStats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkOperation, type OperationContext } from './OperationContext.js';

const helper = fileURLToPath(new URL('../../tools/WinCode.UIA.Host/bin/Release/net10.0-windows/win-x64/publish/WinCode.UIA.Host.exe', import.meta.url));

export class TrashMoveUnconfirmed extends Error {}

/** The caller keeps the original file open until the worker has finished. */
export async function moveValidatedFile(root: string, source: string, trash: string, leaf: string,
  identity: BigIntStats, operation?: OperationContext): Promise<void> {
  checkOperation(operation);
  const args = ['--move-to-trash', root, source, trash, leaf, String(identity.dev), String(identity.ino)];
  try {
    await new Promise<void>((resolve, reject) => {
      const child = execFile(helper, args, { cwd: path.dirname(helper), windowsHide: true, timeout: 10_000,
        maxBuffer: 4096, encoding: 'utf8', env: { ...process.env, WINCODE_OWNER_PID: String(process.pid) } },
      (error, stdout) => {
        if (error) reject(new Error(error.code === 'ENOENT' ? 'The published Windows file-move helper is unavailable.' :
          'Windows could not complete the verified file move: ' + (error.message.split('\n').slice(1).join(' ').trim() || error.code || 'worker failed')));
        else if (stdout.trim() !== 'MOVED') reject(new Error('Windows did not acknowledge the verified file move.'));
        else resolve();
      });
      child.stdin?.end();
    });
  } catch (failure) {
    // A worker may exit after the rename and before its acknowledgement reaches the gateway.
    let destination;
    try { destination = await fs.lstat(path.join(trash, leaf), { bigint: true }); }
    catch (lookup) {
      if ((lookup as NodeJS.ErrnoException).code === 'ENOENT') throw failure;
      throw new TrashMoveUnconfirmed('The destination could not be checked after the worker exited.');
    }
    if (!destination.isFile() || destination.dev !== identity.dev || destination.ino !== identity.ino) throw failure;
  }
}
