import { boundedInteger, invalidTrashResult, type WorkspaceGitStatus, type WorkspaceOpenResult } from './WorkspaceContracts.js';
import { identifyProject, discoverProject, getMetadata } from './ProjectDiscovery.js';
import { getDirectoryTree, listDirectory } from './WorkspaceBrowser.js';
import { isWorkspacePathInside, validateTrashPath, type TrashMoveResult, type ProjectIdentity, type WorkspaceMetadata, type WorkspaceTreeItem, type WorkspaceOpenOptions, type WorkspaceDirectoryOptions, type WorkspaceDirectoryResult } from './WorkspaceContracts.js';
export { type TrashMoveResult, invalidTrashResult, type ProjectIdentity, type WorkspaceTreeItem, type WorkspaceGitStatus, type WorkspaceMetadata, type WorkspaceOpenOptions, type WorkspaceDirectoryOptions, type WorkspaceDirectoryResult, type WorkspaceOpenResult, validateWorkspaceDirectoryOptions, validateTrashPath } from './WorkspaceContracts.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runGit } from './GitClient.js';
import { assertLinkFreePath } from './FileSystemBoundary.js';
import type { OperationContext } from './OperationContext.js';
import { WinCodeConfig } from './Config.js';
import { randomUUID } from 'node:crypto';

export class WorkspaceManager {
  private config: WinCodeConfig;

  constructor(config: WinCodeConfig) {
    this.config = config;
    if (this.config.workspaceRoot && !this.config.trashDir) {
      this.config.trashDir = path.join(this.config.workspaceRoot, 'trash');
    }
  }

  get root(): string {
    return this.config.workspaceRoot;
  }

  get trashDir(): string {
    return this.config.trashDir;
  }

  /**
   * Checks if targetPath is strictly inside parentDir (not parentDir itself, and not outside)
   */
  private isPathInside(parentDir: string, targetPath: string): boolean {
    return isWorkspacePathInside(parentDir, targetPath);
  }

  private isPathInsideOrEqual(parentDir: string, targetPath: string): boolean {
    return isWorkspacePathInside(parentDir, targetPath, true);
  }

  /**
   * Resolves the real filesystem path, following any symlinks or directory junctions.
   * If the target does not exist, traverses up to the nearest existing ancestor.
   */
  private async getRealPath(targetPath: string): Promise<string> {
    let current = path.resolve(targetPath);
    const remainingSegments: string[] = [];

    while (true) {
      try {
        const real = await fs.realpath(current);
        return remainingSegments.length > 0 ? path.join(real, ...remainingSegments) : real;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const parent = path.dirname(current);
        if (parent === current) {
          return targetPath;
        }
        remainingSegments.unshift(path.basename(current));
        current = parent;
      }
    }
  }

  /**
   * Sets the workspace root path and synchronizes the trash directory
   */
  setRoot(newRoot: string): void {
    const oldRoot = this.config.workspaceRoot ? path.resolve(this.config.workspaceRoot) : '';
    const resolvedRoot = path.resolve(newRoot);
    this.config.workspaceRoot = resolvedRoot;

    // Synchronize trashDir to the new workspace root
    if (!oldRoot || !this.config.trashDir || this.isPathInside(oldRoot, this.config.trashDir) || path.resolve(this.config.trashDir) === path.join(oldRoot, 'trash')) {
      const relTrash = (oldRoot && this.config.trashDir && this.isPathInside(oldRoot, this.config.trashDir))
        ? path.relative(oldRoot, this.config.trashDir)
        : 'trash';
      this.config.trashDir = path.resolve(resolvedRoot, relTrash);
    } else {
      this.config.trashDir = path.resolve(resolvedRoot, 'trash');
    }
  }

  /**
   * Identifies the project types, especially Windows / .NET ecosystems
   */
  async identifyProject(operation?: OperationContext): Promise<ProjectIdentity> {
    return identifyProject(this.root, operation);
  }

  /**
   * Retrieves Git status safely for the current workspace
   */
  async getGitStatus(): Promise<WorkspaceGitStatus> {
    const gitTimeout = this.config.timeouts?.gitMs ?? 5000;
    try {
      if ((await runGit(this.root, ['rev-parse', '--is-inside-work-tree'], gitTimeout)).stdout.trim() !== 'true') return { isGit: false };
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { stderr?: string };
      if (failure.stderr?.startsWith('fatal: not a git repository')) return { isGit: false };
      return { isGit: null, status: 'unknown', errorCode: failure.code === 'GIT_UNAVAILABLE' ? 'GIT_UNAVAILABLE' : 'GIT_QUERY_FAILED' };
    }
    const [branch, head, status, remote] = await Promise.allSettled([
      runGit(this.root, ['rev-parse', '--abbrev-ref', 'HEAD'], gitTimeout),
      runGit(this.root, ['rev-parse', '--short', 'HEAD'], gitTimeout),
      runGit(this.root, ['status', '--porcelain'], gitTimeout),
      runGit(this.root, ['remote', 'get-url', 'origin'], gitTimeout),
    ]);
    const clean = status.status === 'fulfilled' ? status.value.stdout.trim().length === 0 : undefined;
    return { isGit: true,
      ...(branch.status === 'fulfilled' ? { branch: branch.value.stdout.trim() } : {}),
      ...(head.status === 'fulfilled' ? { headCommit: head.value.stdout.trim() } : {}),
      ...(remote.status === 'fulfilled' ? { remoteUrl: remote.value.stdout.trim() } : {}),
      ...(clean === undefined ? { status: 'unknown', errorCode: 'GIT_QUERY_FAILED' } : { isClean: clean, status: clean ? 'clean' : 'dirty' }),
    };
  }

  /**
   * Scans the workspace directory tree up to maxDepth and collects summary statistics
   */
  async getDirectoryTree(maxDepth = 3, operation?: OperationContext): Promise<WorkspaceTreeItem> {
    return getDirectoryTree(this.root, maxDepth, operation);
  }

  /**
   * Collects workspace statistics (file count, dir count, total size)
   */
  async getMetadata(identity: ProjectIdentity): Promise<WorkspaceMetadata> {
    return getMetadata(this.root, identity);
  }

  /** Bounded discovery intentionally does not build a tree or stat individual output binaries. */
  private async discoverProject(): Promise<{
    identity: ProjectIdentity; complete: boolean; entryPoints: string[];
    discovery: NonNullable<WorkspaceMetadata['projectDiscovery']>;
  }> {
    return discoverProject(this.root);
  }

  /** Directory browsing is stateless and bounds enumeration as well as final serialization. */
  async listDirectory(options: WorkspaceDirectoryOptions = {}, operation?: OperationContext): Promise<WorkspaceDirectoryResult> {
    return listDirectory(this.root, options, operation);
  }

  /**
   * Phase 2: Opens and analyzes any target workspace directory.
   */
  async openWorkspace(targetPath: string, options: WorkspaceOpenOptions = {}): Promise<WorkspaceOpenResult> {
    const maxOutputChars = boundedInteger(options.maxOutputChars, 8000, 2048, 32768, 'maxOutputChars');
    if (options.includeTree !== undefined && typeof options.includeTree !== 'boolean') throw new Error('includeTree must be a boolean.');
    const resolvedPath = path.resolve(targetPath);

    const stat = await fs.stat(resolvedPath).catch(() => null);
    if (!stat || !stat.isDirectory()) {
      throw new Error(`Invalid workspace path: "${targetPath}". Directory does not exist.`);
    }

    const previousRoot = this.config.workspaceRoot;
    const previousTrash = this.config.trashDir;
    // Metadata collection can fail after validation (e.g. the directory disappears).
    // Restore both mutable paths on failure so callers never observe a rejected root.
    // Same-root overview must not mutate trash/config while business requests are running.
    if (path.relative(previousRoot, resolvedPath) !== '') this.setRoot(resolvedPath);
    try {
      const { identity, complete, discovery, entryPoints } = await this.discoverProject();
      const git = await this.getGitStatus();
      const metadata: WorkspaceMetadata = {
        totalFiles: null, totalDirectories: null, totalSizeBytes: null,
        scanScope: 'project-discovery-only', maxScanDepth: discovery.maxDepth,
        omittedDirectories: discovery.omissions.filter(item => ['default-ignore', 'local-dotnet-sdk', 'generated-or-work-directory'].includes(item.reason)),
        omittedDirectoryCount: discovery.ignoredDirectoryCount,
        targetFramework: identity.targetFramework, frameworks: identity.frameworks,
        packageManagers: identity.packageManagers, solutions: identity.solutionFiles, projectList: identity.projectFiles,
        projectDiscovery: discovery,
      };
      const result: WorkspaceOpenResult = {
        workspace: this.root,
        type: identity.type,
        solution: identity.primarySolution,
        projects: identity.projectFiles.length,
        language: identity.language,
        git,
        metadata,
        entryPoints, projectScanComplete: complete, truncated: !complete,
        limits: { maxOutputChars, includeTree: options.includeTree ?? false }, outputOmissions: [],
      };
      if (discovery.omittedCount > discovery.omissions.length) {
        result.outputOmissions.push('omission-details-limit'); result.truncated = true;
      }
      if (options.includeTree) {
        const listing = await this.listDirectory({ maxDepth: 2, maxEntries: 100, maxOutputChars });
        const fileTree: WorkspaceTreeItem = {
          name: path.basename(this.root), path: this.root, relativePath: '.', type: 'directory', children: [],
        };
        const nodes = new Map<string, WorkspaceTreeItem>([['.', fileTree]]);
        for (const entry of listing.entries) {
          const node: WorkspaceTreeItem = {
            name: path.posix.basename(entry.path), path: path.join(this.root, entry.path), relativePath: entry.path,
            type: entry.type, ...(entry.type === 'directory' ? { children: [] } : {}),
          };
          nodes.get(path.posix.dirname(entry.path))?.children?.push(node);
          nodes.set(entry.path, node);
        }
        fileTree.omittedDirectories = listing.omissions;
        result.fileTree = fileTree;
        if (listing.truncated) { result.truncated = true; result.outputOmissions.push('fileTree-bounded'); }
      }
      const fits = () => JSON.stringify(result).length <= maxOutputChars;
      if (!fits()) {
        result.truncated = true;
        result.outputOmissions.push('response-budget');
        const trim = (items: unknown[], field: string) => {
          if (!fits() && items.length) {
            result.outputOmissions.push(field);
            while (!fits() && items.length) items.pop();
          }
        };
        trim(result.fileTree?.omittedDirectories ?? [], 'fileTree.omittedDirectories');
        trim(result.fileTree?.children ?? [], 'fileTree.children');
        trim(discovery.omissions, 'metadata.projectDiscovery.omissions');
        trim(metadata.omittedDirectories, 'metadata.omittedDirectories');
        trim(metadata.projectList, 'metadata.projectList');
        trim(metadata.solutions, 'metadata.solutions');
        trim(metadata.frameworks, 'metadata.frameworks');
        trim(metadata.packageManagers, 'metadata.packageManagers');
        if (!fits() && metadata.targetFramework !== undefined) {
          delete metadata.targetFramework; result.outputOmissions.push('metadata.targetFramework');
        }
        for (const key of ['remoteUrl', 'branch', 'headCommit'] as const) {
          if (!fits() && git[key] !== undefined) { delete git[key]; result.outputOmissions.push(`git.${key}`); }
        }
        trim(result.entryPoints, 'entryPoints');
      }
      if (!fits()) throw new Error('maxOutputChars cannot contain the workspace identity and required summary.');
      return result;
    } catch (error) {
      this.config.workspaceRoot = previousRoot;
      this.config.trashDir = previousTrash;
      throw error;
    }
  }

  /**
   * Safe file deletion policy: Moves files to the project trash directory.
   * Only accepts non-empty relative paths strictly within the workspace.
   */
  async moveToTrash(relativeFilePath: string, reason?: string): Promise<TrashMoveResult> {
    try { validateTrashPath(relativeFilePath, this.root, this.config.trashDir); }
    catch (error) {
      return invalidTrashResult(error instanceof Error ? error.message : String(error));
    }
    const targetPath = path.resolve(this.root, relativeFilePath);

    let failureStage: NonNullable<TrashMoveResult['failureStage']> = 'validation';
    let destinationPath = '';
    let moved = false;
    try {
      // Resolve symlinks and Windows junctions before any move.
      const realRoot = await this.getRealPath(this.root);
      const realTarget = await this.getRealPath(targetPath);
      const realTrash = await this.getRealPath(this.config.trashDir);

      if (!this.isPathInside(realRoot, realTarget)) {
        return invalidTrashResult(`Failed to move file to trash: Target path "${relativeFilePath}" resolves outside the workspace via symlink or junction.`);
      }

      if (this.isPathInsideOrEqual(realTrash, realTarget)) {
        return invalidTrashResult('Failed to move file to trash: Cannot move items from or within the trash directory.');
      }

      if (!this.isPathInside(realRoot, realTrash)) return invalidTrashResult('Failed to move file to trash: Trash destination resolves outside the workspace.');
      await assertLinkFreePath(this.config.trashDir);

      failureStage = 'prepare';
      await fs.mkdir(this.config.trashDir, { recursive: true });
      await assertLinkFreePath(this.config.trashDir);
      if (await fs.realpath(this.config.trashDir) !== realTrash) throw new Error('Trash destination changed during preparation.');

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const fileName = path.basename(targetPath);
      const prefix = `${timestamp}_${randomUUID()}_`;
      // Bound both the payload name and its metadata sibling. UTF-8 bytes also
      // bound UTF-16 units on Windows; iterate code points to avoid splitting them.
      const nameBudget = 255 - Buffer.byteLength(prefix + '.meta.json');
      let displayName = '';
      let nameBytes = 0;
      for (const character of fileName) {
        const bytes = Buffer.byteLength(character);
        if (nameBytes + bytes > nameBudget) break;
        displayName += character;
        nameBytes += bytes;
      }
      displayName = displayName.replace(/[. ]+$/, '') || 'file';
      const trashFileName = prefix + displayName;
      destinationPath = path.join(this.config.trashDir, trashFileName);

      failureStage = 'move';
      await assertLinkFreePath(this.config.trashDir);
      if (await this.getRealPath(targetPath) !== realTarget) throw new Error('Trash source changed during preparation.');
      await fs.rename(targetPath, destinationPath);
      moved = true;

      failureStage = 'metadata';
      const metaPath = path.join(this.config.trashDir, `${trashFileName}.meta.json`);
      await assertLinkFreePath(this.config.trashDir);
      await fs.writeFile(
        metaPath,
        JSON.stringify(
          {
            originalPath: targetPath,
            deletedAt: new Date().toISOString(),
            reason: reason || 'Requested file deletion moved to trash according to safe workspace policy.',
          },
          null,
          2
        )
      );

      return {
        success: true,
        outcome: 'completed', originalPath: targetPath, metadataPath: metaPath,
        trashPath: destinationPath,
        message: `File safely moved to trash: ${path.relative(this.root, destinationPath)}`,
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        outcome: moved ? 'partial' : 'not_moved', failureStage,
        errorCode: moved ? 'TRASH_METADATA_FAILED' : 'TRASH_NOT_MOVED',
        originalPath: targetPath, trashPath: moved ? destinationPath : '',
        ...(moved ? { metadataPath: `${destinationPath}.meta.json` } : {}),
        message: moved
          ? `File was moved to ${destinationPath}, but metadata was not completed: ${detail}. Preserve this path; do not retry the move or assume it was rolled back.`
          : `Failed to move file to trash: ${detail}`,
      };
    }
  }
}
