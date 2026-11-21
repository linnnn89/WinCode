import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isWorkspacePathInside } from './WorkspaceContracts.js';
import { checkOperation, type OperationContext } from './OperationContext.js';

const execFileAsync = promisify(execFile);
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

export async function runGit(root: string, args: string[], timeout: number, operation?: OperationContext): Promise<{ stdout: string }> {
  const executable = await resolveGitExecutable(root, operation);
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
    cwd: root, windowsHide: true, shell: false, timeout: remaining(), signal: operation?.signal, maxBuffer: 1024 * 1024, encoding: 'utf8',
    env: { ...env, LC_ALL: 'C', LANG: 'C', GIT_TERMINAL_PROMPT: '0' },
  });
  checkOperation(operation);
  return result;
}
