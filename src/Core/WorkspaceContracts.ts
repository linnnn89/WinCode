import path from 'node:path';

export interface WorkspaceBinding {
  readonly mode: 'fixed';
  readonly root: string;
  readonly source: 'argument' | 'cwd' | 'configuration';
}

export class WorkspaceMismatchError extends Error {
  readonly errorCode = 'WORKSPACE_MISMATCH';
  constructor(readonly activeWorkspace: string, readonly requestedWorkspace: string) {
    super(`This connection is fixed to "${activeWorkspace}". Select the connection configured for "${requestedWorkspace}"; workspace_open cannot switch projects.`);
    this.name = 'WorkspaceMismatchError';
  }
}

/** 工作区公开数据与路径校验契约；不执行文件移动或改变当前根。 */
export interface TrashMoveResult {
  success: boolean;
  trashPath: string;
  message: string;
  outcome: 'completed' | 'not_moved' | 'partial';
  failureStage?: 'validation' | 'prepare' | 'move' | 'metadata';
  errorCode?: 'TRASH_NOT_MOVED' | 'TRASH_METADATA_FAILED';
  originalPath?: string;
  metadataPath?: string;
}

export function invalidTrashResult(message: string): TrashMoveResult {
  return { success: false, trashPath: '', message, outcome: 'not_moved',
    failureStage: 'validation', errorCode: 'TRASH_NOT_MOVED' };
}

export interface ProjectIdentity {
  name: string;
  type: 'dotnet' | 'node' | 'python' | 'rust' | 'go' | 'general';
  language: string;
  primarySolution: string | null;
  frameworks: string[];
  isDotNet: boolean;
  solutionFiles: string[];
  projectFiles: string[];
  hasGit: boolean;
  packageManagers: string[];
  targetFramework?: string;
  scanComplete?: boolean;
  discovery?: WorkspaceMetadata['projectDiscovery'];
}

export interface WorkspaceTreeItem {
  name: string;
  path: string;
  relativePath: string;
  type: 'file' | 'directory';
  size?: number;
  children?: WorkspaceTreeItem[];
  omittedDirectories?: Array<{ path: string; reason: string }>;
  scanComplete?: boolean;
  truncated?: boolean;
  visitedEntries?: number;
}

export interface WorkspaceGitStatus {
  isGit: boolean | null;
  branch?: string;
  isClean?: boolean;
  headCommit?: string;
  remoteUrl?: string;
  status?: 'clean' | 'dirty' | 'unknown';
  errorCode?: 'GIT_UNAVAILABLE' | 'GIT_QUERY_FAILED';
}

export interface WorkspaceMetadata {
  totalFiles: number | null;
  totalDirectories: number | null;
  totalSizeBytes: number | null;
  targetFramework?: string;
  frameworks: string[];
  packageManagers: string[];
  solutions: string[];
  projectList: string[];
  scanScope: 'filtered-depth-limited' | 'project-discovery-only';
  maxScanDepth: number;
  omittedDirectories: Array<{ path: string; reason: string }>;
  omittedDirectoryCount: number;
  projectDiscovery?: {
    visitedEntries: number;
    descriptorBytesRead: number;
    maxEntries: number;
    maxDepth: number;
    maxDescriptorBytes: number;
    ignoredDirectoryCount: number;
    omissions: Array<{ path: string; reason: string }>;
    omittedCount: number;
  };
}

export interface WorkspaceOpenOptions {
  includeTree?: boolean;
  maxOutputChars?: number;
}

export interface WorkspaceDirectoryOptions {
  path?: string;
  maxDepth?: number;
  maxEntries?: number;
  maxOutputChars?: number;
  includeIgnored?: boolean;
}

export interface WorkspaceDirectoryResult {
  workspace: string;
  path: string;
  entries: Array<{ path: string; type: 'file' | 'directory' }>;
  omissions: Array<{ path: string; reason: string }>;
  omittedCount: number;
  visitedEntries: number;
  returnedEntries: number;
  scanComplete: boolean;
  truncated: boolean;
  limits: { maxDepth: number; maxEntries: number; maxOutputChars: number; includeIgnored: boolean };
  outputOmissions: string[];
}

export interface WorkspaceOpenResult {
  workspace: string;
  type: 'dotnet' | 'node' | 'python' | 'rust' | 'go' | 'general';
  solution: string | null;
  projects: number;
  language: string;
  git: WorkspaceGitStatus;
  metadata: WorkspaceMetadata;
  fileTree?: WorkspaceTreeItem;
  entryPoints: string[];
  projectScanComplete: boolean;
  truncated: boolean;
  limits: { maxOutputChars: number; includeTree: boolean };
  outputOmissions: string[];
}

export function isWorkspacePathInside(parentDir: string, targetPath: string, allowEqual = false): boolean {
  const resolvedParent = path.resolve(parentDir);
  const resolvedTarget = path.resolve(targetPath);
  const normalizedParent = process.platform === 'win32' ? resolvedParent.toLowerCase() : resolvedParent;
  const normalizedTarget = process.platform === 'win32' ? resolvedTarget.toLowerCase() : resolvedTarget;
  const rel = path.relative(normalizedParent, normalizedTarget);
  return (!rel && allowEqual) || Boolean(rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

export function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

/** Pure admission checks; execution separately resolves filesystem links. */
export function validateWorkspaceDirectoryOptions(options: WorkspaceDirectoryOptions, workspaceRoot: string) {
  const maxDepth = boundedInteger(options.maxDepth, 1, 1, 5, 'maxDepth');
  const maxEntries = boundedInteger(options.maxEntries, 100, 1, 500, 'maxEntries');
  const maxOutputChars = boundedInteger(options.maxOutputChars, 8000, 2048, 32768, 'maxOutputChars');
  if (options.includeIgnored !== undefined && typeof options.includeIgnored !== 'boolean') throw new Error('includeIgnored must be a boolean.');
  const requested = options.path ?? '.';
  if (typeof requested !== 'string' || !requested.trim() || requested.length > 4096 || requested.includes('\0') ||
    requested.split(/[\\/]/).includes('..') || path.isAbsolute(requested) || /^[a-z]:/i.test(requested) || /^(\/\/|\\\\)/.test(requested)) {
    throw new Error('Directory path must be a non-empty relative path inside the workspace.');
  }
  const full = path.resolve(workspaceRoot, requested);
  if (!isWorkspacePathInside(workspaceRoot, full, true)) throw new Error('Directory path is outside the workspace.');
  return { requested, full, maxDepth, maxEntries, maxOutputChars };
}

/** Preserve the safe-trash lexical policy and its user-facing failure messages. */
export function validateTrashPath(relativeFilePath: string, workspaceRoot: string, trashDir: string): void {
  if (typeof relativeFilePath !== 'string' || !relativeFilePath.trim()) {
    throw new Error('Failed to move file to trash: Path cannot be empty.');
  }
  if (path.isAbsolute(relativeFilePath) || /^[a-zA-Z]:/.test(relativeFilePath) || /^(\/\/|\\\\)/.test(relativeFilePath)) {
    throw new Error(`Failed to move file to trash: Only non-empty relative paths within the workspace are accepted. Received: "${relativeFilePath}".`);
  }
  const targetPath = path.resolve(workspaceRoot, relativeFilePath);
  if (!isWorkspacePathInside(workspaceRoot, targetPath)) {
    throw new Error(`Failed to move file to trash: Path "${relativeFilePath}" is outside the workspace boundary.`);
  }
  if (isWorkspacePathInside(trashDir, targetPath, true)) {
    throw new Error('Failed to move file to trash: Cannot move items from or within the trash directory.');
  }
}
