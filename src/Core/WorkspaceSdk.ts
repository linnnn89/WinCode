import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { parse, type ParseError } from 'jsonc-parser';
import { checkOperation, type OperationContext } from './OperationContext.js';

const execFileAsync = promisify(execFile);
const maxPolicyBytes = 65536;

export class SdkPolicyError extends Error {}

/** The muxer searches from the selected directory up to the filesystem root for global.json. */
async function readSdkPolicy(root: string, operation?: OperationContext): Promise<string> {
  for (let dir = root; ; dir = path.dirname(dir)) {
    checkOperation(operation);
    const file = path.join(dir, 'global.json');
    const stat = await fs.stat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat) {
      if (!stat.isFile() || stat.size > maxPolicyBytes) throw new SdkPolicyError('The workspace global.json could not be read within the SDK probe limit.');
      const handle = await fs.open(file, 'r');
      try {
        const bytes = Buffer.alloc(stat.size + 1);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        if (bytesRead !== stat.size) throw new SdkPolicyError('The workspace global.json changed during the SDK probe.');
        const errors: ParseError[] = [];
        const policy = parse(bytes.toString('utf8', 0, bytesRead).replace(/^\uFEFF/, ''), errors, { allowTrailingComma: true });
        if (errors.length || !policy || typeof policy !== 'object' || Array.isArray(policy))
          throw new SdkPolicyError('The workspace global.json could not be parsed for SDK selection.');
        const sdk = policy.sdk;
        if (sdk?.paths !== undefined && (!Array.isArray(sdk.paths) || sdk.paths.some((p: unknown) => p !== '$host$')))
          throw new SdkPolicyError('SDK availability is unverified because global.json specifies custom SDK search paths.');
        // Forward selection settings only. The native host implements version and roll-forward matching.
        return JSON.stringify({ sdk: sdk && { version: sdk.version, rollForward: sdk.rollForward, allowPrerelease: sdk.allowPrerelease, paths: sdk.paths } });
      } finally { await handle.close(); }
    }
    if (path.dirname(dir) === dir) return '{}';
  }
}

export async function probeWorkspaceSdk(root: string, executable: string, timeout: number, operation?: OperationContext): Promise<string> {
  const policy = await readSdkPolicy(root, operation);
  checkOperation(operation);
  // A private cwd keeps workspace executables and SDK search roots out of this read-only probe.
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'wincode-sdk-'));
  const file = path.join(cwd, 'global.json');
  try {
    await fs.writeFile(file, policy);
    checkOperation(operation);
    const { stdout } = await execFileAsync(executable, ['--version'], {
      cwd, windowsHide: true, signal: operation?.signal,
      timeout: Math.max(1, Math.min(timeout, (operation?.deadline ?? Infinity) - Date.now())),
    });
    return stdout.trim();
  } finally {
    await fs.rm(file, { force: true });
    await fs.rmdir(cwd);
  }
}

/** hostfxr reports LibHostSdkFindFailure or SdkResolveFailure, truncated to eight bits on Unix. */
export function isSdkResolutionFailure(code: string | number | undefined): boolean {
  if (typeof code !== 'number') return false;
  return process.platform === 'win32'
    ? (code >>> 0) === 0x80008091 || (code >>> 0) === 0x8000809b
    : code === 145 || code === 155;
}
