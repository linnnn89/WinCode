import fs from 'node:fs/promises';
import path from 'node:path';
import { isWorkspacePathInside, validateWorkspaceDirectoryOptions, type ProjectIdentity, type WorkspaceMetadata, type WorkspaceTreeItem, type WorkspaceDirectoryOptions, type WorkspaceDirectoryResult } from './WorkspaceContracts.js';
const isInsideOrEqual = (parent: string, target: string) => isWorkspacePathInside(parent, target, true);

export const DEFAULT_IGNORES: ReadonlySet<string> = new Set([
    'node_modules',
    '.git',
    '.vs',
    'bin',
    'obj',
    'dist',
    'build',
    'trash',
    '.cache',
    '.deps',
    '.packages',
    'TestResults',
  ]);

/** 只读判断生成目录和本地 SDK，绝不启动其中的程序。 */
export async function directoryOmission(dir: string): Promise<string | null> {
  if (DEFAULT_IGNORES.has(path.basename(dir))) return 'default-ignore';
  if (path.basename(dir).toLowerCase() !== '.dotnet') return null;
  // The name alone is insufficient: preserve ordinary source folders named .dotnet.
  // Inspect marker metadata only; never execute the local SDK or follow marker links.
  const markers = await Promise.all(['dotnet.exe', 'dotnet', 'sdk', 'host'].map(name =>
    fs.lstat(path.join(dir, name)).catch(() => null)));
  const [exe, unix, sdk, host] = markers;
  return (exe?.isFile() || unix?.isFile()) && sdk?.isDirectory() && host?.isDirectory()
    ? 'local-dotnet-sdk' : null;
}

/** 浏览专用过滤，不扩大到语义扫描或缓存指纹。 */
export async function previewOmission(dir: string): Promise<string | null> {
  const existing = await directoryOmission(dir);
  if (existing) return existing;
  const name = path.basename(dir).toLowerCase();
  return /^(?:\.publish(?:[-.].*)?|publish|artifacts|work)$/.test(name)
    ? 'generated-or-work-directory' : null;
}

/** 生成既有深度范围的目录树。 */
export async function getDirectoryTree(root: string, maxDepth = 3): Promise<WorkspaceTreeItem> {
  const scan = async (dirPath: string, currentDepth: number): Promise<WorkspaceTreeItem> => {
    const name = path.basename(dirPath);
    const relativePath = path.relative(root, dirPath) || '.';
    const item: WorkspaceTreeItem = {
      name,
      path: dirPath,
      relativePath,
      type: 'directory',
      children: [],
    };

    if (currentDepth >= maxDepth) {
      return item;
    }

    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (!entry.isDirectory() && DEFAULT_IGNORES.has(entry.name)) continue;

        if (entry.isDirectory()) {
          const reason = await directoryOmission(fullPath);
          if (reason) {
            (item.omittedDirectories ??= []).push({ path: path.relative(root, fullPath).replace(/\\/g, '/'), reason });
            continue;
          }
          item.children?.push(await scan(fullPath, currentDepth + 1));
        } else if (entry.isFile()) {
          const stat = await fs.stat(fullPath).catch(() => null);
          item.children?.push({
            name: entry.name,
            path: fullPath,
            relativePath: path.relative(root, fullPath),
            type: 'file',
            size: stat?.size,
          });
        }
      }
    } catch {
      // Skip inaccessible dirs
    }

    return item;
  };

  return scan(root, 0);
}

/** 验证路径后有界浏览目录，保留遗漏与截断证据。 */
export async function listDirectory(root: string, options: WorkspaceDirectoryOptions = {}): Promise<WorkspaceDirectoryResult> {
  const { full, maxDepth, maxEntries, maxOutputChars } = validateWorkspaceDirectoryOptions(options, root);
  const realRoot = await fs.realpath(root);
  const realTarget = await fs.realpath(full);
  if (!isInsideOrEqual(realRoot, realTarget)) throw new Error('Directory path resolves outside the workspace.');
  if (!(await fs.stat(realTarget)).isDirectory()) throw new Error('Directory path is not a directory.');
  const relative = (value: string) => path.relative(root, value).replace(/\\/g, '/') || '.';
  const result: WorkspaceDirectoryResult = {
    workspace: root, path: relative(full), entries: [], omissions: [], omittedCount: 0,
    visitedEntries: 0, returnedEntries: 0, scanComplete: true, truncated: false,
    limits: { maxDepth, maxEntries, maxOutputChars, includeIgnored: options.includeIgnored ?? false }, outputOmissions: [],
  };
  const omit = (rel: string, reason: string, incomplete = true) => {
    result.omittedCount++;
    if (result.omissions.length < 24) result.omissions.push({ path: rel, reason });
    if (incomplete) { result.scanComplete = false; result.truncated = true; }
  };
  // An explicit path is a browsing request, including a source subtree inside work/.
  // includeIgnored controls filtering of child directories, not access to that path.
  const queue = [{ full, depth: 0 }];
  while (queue.length && result.visitedEntries < maxEntries) {
    const current = queue.shift()!;
    try {
      const real = await fs.realpath(current.full);
      if (!isInsideOrEqual(realRoot, real)) { omit(relative(current.full), 'external-link'); continue; }
      const directory = await fs.opendir(real);
      try { while (result.visitedEntries < maxEntries) {
        const entry = await directory.read();
        if (!entry) break;
        result.visitedEntries++;
        const entryFull = path.join(current.full, entry.name);
        const rel = relative(entryFull);
        if (entry.isSymbolicLink()) { omit(rel, 'link-not-followed'); continue; }
        if (!entry.isDirectory() && !entry.isFile()) { omit(rel, 'unsupported-entry'); continue; }
        if (entry.isDirectory() && !result.limits.includeIgnored) {
          const reason = await previewOmission(entryFull);
          if (reason) { omit(rel, reason, false); continue; }
        }
        result.entries.push({ path: rel, type: entry.isDirectory() ? 'directory' : 'file' });
        if (entry.isDirectory()) {
          if (current.depth + 1 >= maxDepth) omit(rel, 'depth-limit');
          else queue.push({ full: entryFull, depth: current.depth + 1 });
        }
      } } finally { await directory.close(); }
      if (result.visitedEntries >= maxEntries) omit(relative(current.full), 'entry-budget');
    } catch {
      if (current.depth === 0) throw new Error('Requested directory could not be read.');
      omit(relative(current.full), 'directory-unreadable');
    }
  }
  if (queue.length) omit(result.path, 'entry-budget');
  return fitDirectory(result);
}

/** 在序列化预算内裁剪可选条目，保留工作区身份。 */
function fitDirectory(result: WorkspaceDirectoryResult): WorkspaceDirectoryResult {
  const fits = () => JSON.stringify(result).length <= result.limits.maxOutputChars;
  result.returnedEntries = result.entries.length;
  if (result.omittedCount > result.omissions.length) result.outputOmissions.push('omission-details-limit');
  if (!fits()) {
    result.truncated = true;
    result.outputOmissions.push('response-budget');
    while (!fits() && result.omissions.length) result.omissions.pop();
    while (!fits() && result.entries.length) {
      result.entries.pop();
      result.returnedEntries = result.entries.length;
    }
  }
  if (!fits()) throw new Error('maxOutputChars cannot contain the workspace and directory identity.');
  return result;
}
