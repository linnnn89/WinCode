import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isWorkspacePathInside } from './WorkspaceContracts.js';
import { assertLinkFreePath } from './FileSystemBoundary.js';
import { checkOperation, rethrowOperationError, type OperationContext } from './OperationContext.js';

const execFileAsync = promisify(execFile);

export async function resolveTrustedGitRoot(root: string, trustedRoots: readonly string[] | undefined,
  operation?: OperationContext): Promise<string | undefined> {
  checkOperation(operation);
  if (!trustedRoots?.length) return;
  try {
    const physical = await fs.realpath(root);
    checkOperation(operation);
    if (!trustedRoots.includes(physical)) return;
    // A Windows short spelling can identify the granted directory. Links remain outside the grant.
    if (path.resolve(root) !== physical) await assertLinkFreePath(root, operation);
    return physical;
  } catch (error) { rethrowOperationError(error, operation); }
}

/** Expose only the host and repository path of a recognized Git network address. */
export function publicGitRemote(output: string): string | undefined {
  const value = output.trim();
  if (!value || /[\s\\]/u.test(value) || /[\x00-\x1f\x7f]/u.test(value)) return undefined;
  if (value.includes('://')) {
    try {
      const url = new URL(value);
      if (!url.hostname || !['http:', 'https:', 'ssh:', 'git:', 'git+ssh:', 'ssh+git:', 'ftp:', 'ftps:'].includes(url.protocol)) return undefined;
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return url.href;
    } catch { return undefined; }
  }
  // Git also accepts [user@]host:path. Leave ambiguous local and remote-helper syntax private.
  if (/^[A-Za-z]:/.test(value)) return undefined;
  const scp = /^(?:[^@:/?#]+@)?(\[[a-f\d:.]+\]|[a-z\d.-]+):([^@:#?]+)(?:[?#].*)?$/i.exec(value);
  return scp ? scp[1] + ':' + scp[2] : undefined;
}
const supportedVersions = new Set<string>(); // At most the fixed launch-time candidate list below.
// Capture the launch environment once, never search a queried repository's cwd.
const candidates = [
  ...[process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')]
    .filter((value): value is string => !!value).map(base => path.join(base, 'Git', 'cmd', 'git.exe')),
  ...(process.env.PATH ?? '').split(path.delimiter).filter(dir => path.isAbsolute(dir))
    .map(dir => path.join(dir, process.platform === 'win32' ? 'git.exe' : 'git')),
];

export async function resolveGitExecutable(root: string, operation?: OperationContext): Promise<string> {
  checkOperation(operation);
  const realRoot = await fs.realpath(root);
  for (const candidate of candidates) {
    checkOperation(operation);
    if (isWorkspacePathInside(root, candidate, true)) continue;
    try {
      const real = await fs.realpath(candidate);
      if (isWorkspacePathInside(realRoot, real, true)) continue;
      if ((await fs.stat(real)).isFile()) return real;
    } catch { /* Try another launch-time installation candidate. */ }
  }
  throw Object.assign(new Error('No trusted Git executable is available outside the workspace.'), { code: 'GIT_UNAVAILABLE' });
}

export async function runGit(root: string, trustedRoots: readonly string[] | undefined, args: string[], timeout: number, operation?: OperationContext): Promise<{ stdout: string }> {
  const physical = await resolveTrustedGitRoot(root, trustedRoots, operation);
  if (!physical)
    throw Object.assign(new Error('Native Git was not authorized for this workspace.'), { code: 'GIT_NOT_TRUSTED' });
  const executable = await resolveGitExecutable(physical, operation);
  const remaining = () => {
    checkOperation(operation);
    return Math.max(1, Math.min(timeout, (operation?.deadline ?? Infinity) - Date.now()));
  };
  if (!supportedVersions.has(executable)) {
    const version = await execFileAsync(executable, ['--version'], {
      cwd: path.dirname(executable), windowsHide: true, shell: false, timeout: remaining(), signal: operation?.signal, maxBuffer: 4096, encoding: 'utf8',
    });
    const match = /^git version (\d+)\.(\d+)/.exec(version.stdout);
    // Older Git can interpret the boolean "false" as an executable fsmonitor hook path.
    if (!match || Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 36))
      throw Object.assign(new Error('Git 2.36 or later is required for safe read-only probes.'), { code: 'GIT_UNAVAILABLE' });
    supportedVersions.add(executable);
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+))$/i.test(key)));
  const result = await execFileAsync(executable, ['--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], {
    cwd: physical, windowsHide: true, shell: false, timeout: remaining(), signal: operation?.signal, maxBuffer: 1024 * 1024, encoding: 'utf8',
    env: { ...env, LC_ALL: 'C', LANG: 'C', GIT_TERMINAL_PROMPT: '0', GIT_CEILING_DIRECTORIES: path.dirname(physical) },
  });
  checkOperation(operation);
  return result;
}
