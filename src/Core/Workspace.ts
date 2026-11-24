import { boundedInteger, invalidTrashResult, WorkspaceMismatchError, type WorkspaceBinding, type WorkspaceGitStatus, type WorkspaceOpenResult } from './WorkspaceContracts.js';
import { identifyProject, discoverProject, getMetadata } from './ProjectDiscovery.js';
import { getDirectoryTree, listDirectory } from './WorkspaceBrowser.js';
import { isWorkspacePathInside, validateTrashPath, type TrashMoveResult, type ProjectIdentity, type WorkspaceMetadata, type WorkspaceTreeItem, type WorkspaceOpenOptions, type WorkspaceDirectoryOptions, type WorkspaceDirectoryResult } from './WorkspaceContracts.js';
export { type TrashMoveResult, invalidTrashResult, type ProjectIdentity, type WorkspaceTreeItem, type WorkspaceGitStatus, type WorkspaceMetadata, type WorkspaceOpenOptions, type WorkspaceDirectoryOptions, type WorkspaceDirectoryResult, type WorkspaceOpenResult, validateWorkspaceDirectoryOptions, validateTrashPath } from './WorkspaceContracts.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { gitRootIsTrusted, publicGitRemote, runGit } from './GitClient.js';
import { assertLinkFreePath, assertWorkspaceDirectory, resolveWorkspaceDirectory } from './FileSystemBoundary.js';
import { checkOperation, rethrowOperationError, type OperationContext } from './OperationContext.js';
import { WinCodeConfig } from './Config.js';
import { randomUUID } from 'node:crypto';
import { moveValidatedFile, TrashMoveUnconfirmed } from './TrashFileMove.js';

export class WorkspaceManager {
  private config: WinCodeConfig;
  readonly binding: WorkspaceBinding;
  private configuredPhysicalRoot?: string;

  constructor(config: WinCodeConfig) {
    this.config = config;
    this.binding = Object.freeze({ mode: config.workspaceMode ?? 'fixed', root: path.resolve(config.workspaceRoot), source: config.workspaceRootSource ?? 'configuration' });
    // Each router and its adapters keep the same root, including on a dynamic connection.
    Object.defineProperty(config, 'workspaceRoot', { value: this.binding.root, enumerable: true, writable: false, configurable: false });
    if (this.config.workspaceRoot && !this.config.trashDir) {
      this.config.trashDir = path.join(this.config.workspaceRoot, 'trash');
    }
  }

  get root(): string {
    return this.binding.root;
  }

  get continuationWorkspacePath(): string | undefined {
    return this.binding.mode === 'dynamic' ? this.configuredPhysicalRoot ?? this.root : undefined;
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

  /** Retained internal entry point: confirming the same root never changes configuration or trash. */
  setRoot(newRoot: string): void {
    this.assertWorkspace(newRoot);
  }

  /** Compare normalized spellings before any filesystem access or request/resource state change. */
  assertWorkspace(targetPath: string): string {
    if (typeof targetPath !== 'string' || !targetPath.trim()) throw new Error('Workspace path must be a non-empty string.');
    const requested = path.resolve(targetPath);
    if (path.relative(this.root, requested) !== '') throw new WorkspaceMismatchError(this.root, requested);
    return this.root;
  }

  async validateRoot(operation?: OperationContext): Promise<void> {
    if (this.binding.mode === 'dynamic' && this.binding.source === 'argument' && this.configuredPhysicalRoot === undefined) {
      this.configuredPhysicalRoot = await resolveWorkspaceDirectory(this.root, operation);
      return;
    }
    await assertWorkspaceDirectory(this.root, operation);
  }

  /** The caller has validated the request path. An alternate spelling must still reach the configured directory. */
  async matchesConfiguredRoot(requested: string, physical: string, operation: OperationContext): Promise<boolean> {
    if (this.configuredPhysicalRoot !== undefined && physical !== this.configuredPhysicalRoot) return false;
    if (requested === this.root || physical === this.root) return true;
    try {
      return await resolveWorkspaceDirectory(this.root, operation) === physical;
    } catch (error) {
      rethrowOperationError(error, operation);
      return false;
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
  async getGitStatus(operation?: OperationContext, observedClean?: boolean): Promise<WorkspaceGitStatus> {
    const gitTimeout = this.config.timeouts?.gitMs ?? 5000;
    const trusted = this.config.trustedGitRoots;
    checkOperation(operation);
    if (!gitRootIsTrusted(this.root, trusted)) {
      const absent = await fs.lstat(path.join(this.root, '.git')).then(() => false,
        (e: NodeJS.ErrnoException) => e.code === 'ENOENT');
      checkOperation(operation);
      return absent ? { isGit: false } : { isGit: null, status: 'unknown', errorCode: 'GIT_NOT_TRUSTED' };
    }
    const git = (args: string[]) => runGit(this.root, trusted, args, gitTimeout, operation);
    try {
      if ((await git(['rev-parse', '--is-inside-work-tree'])).stdout.trim() !== 'true') return { isGit: false };
    } catch (error) {
      rethrowOperationError(error, operation);
      const failure = error as NodeJS.ErrnoException & { stderr?: string };
      if (failure.stderr?.startsWith('fatal: not a git repository')) return { isGit: false };
      return { isGit: null, status: 'unknown', errorCode: failure.code === 'GIT_UNAVAILABLE' ? 'GIT_UNAVAILABLE' : 'GIT_QUERY_FAILED' };
    }
    const [branch, head, status, remote] = await Promise.allSettled([
      git(['rev-parse', '--abbrev-ref', 'HEAD']),
      git(['rev-parse', '--short', 'HEAD']),
      observedClean ?? git(['status', '--porcelain']).then(result => !result.stdout.trim()),
      git(['remote', 'get-url', 'origin']),
    ]);
    checkOperation(operation);
    const clean = status.status === 'fulfilled' ? status.value : undefined;
    const remoteUrl = remote.status === 'fulfilled' ? publicGitRemote(remote.value.stdout) : undefined;
    return { isGit: true,
      ...(branch.status === 'fulfilled' ? { branch: branch.value.stdout.trim() } : {}),
      ...(head.status === 'fulfilled' ? { headCommit: head.value.stdout.trim() } : {}),
      ...(remoteUrl === undefined ? {} : { remoteUrl }),
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
  private discoverProject(operation?: OperationContext) {
    return discoverProject(this.root, operation);
  }

  /** Directory browsing is stateless and bounds enumeration as well as final serialization. */
  async listDirectory(options: WorkspaceDirectoryOptions = {}, operation?: OperationContext): Promise<WorkspaceDirectoryResult> {
    return listDirectory(this.root, options, operation);
  }

  /**
   * Describes the bound workspace; opening another root is never a mutation path.
   */
  async openWorkspace(targetPath: string, options: WorkspaceOpenOptions = {}, operation?: OperationContext,
    observedGitClean?: boolean): Promise<WorkspaceOpenResult> {
    checkOperation(operation);
    this.assertWorkspace(targetPath);
    const maxOutputChars = boundedInteger(options.maxOutputChars, 8000, 2048, 32768, 'maxOutputChars');
    if (options.includeTree !== undefined && typeof options.includeTree !== 'boolean') throw new Error('includeTree must be a boolean.');
    await this.validateRoot(operation);
    const { identity, complete, discovery, entryPoints } = await this.discoverProject(operation);
    checkOperation(operation);
    const git = await this.getGitStatus(operation, observedGitClean);
    checkOperation(operation);
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
      const listing = await this.listDirectory({ maxDepth: 2, maxEntries: 100, maxOutputChars }, operation);
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
    checkOperation(operation);
    return result;
  }

  /**
   * Safe file deletion policy: Moves files to the project trash directory.
   * Only accepts non-empty relative paths strictly within the workspace.
   */
  async moveToTrash(relativeFilePath: string, reason?: string, operation?: OperationContext): Promise<TrashMoveResult> {
    checkOperation(operation);
    try { validateTrashPath(relativeFilePath, this.root, this.config.trashDir); }
    catch (error) {
      return invalidTrashResult(error instanceof Error ? error.message : String(error));
    }
    const targetPath = path.resolve(this.root, relativeFilePath);

    let failureStage: NonNullable<TrashMoveResult['failureStage']> = 'validation';
    let destinationPath = '';
    let moved = false;
    let pinnedSource: fs.FileHandle | undefined;
    try {
      // Resolve symlinks and Windows junctions before any move.
      const realRoot = await this.getRealPath(this.root);
      const realTarget = await this.getRealPath(targetPath);
      checkOperation(operation);
      const realTrash = await this.getRealPath(this.config.trashDir);

      if (!this.isPathInside(realRoot, realTarget)) {
        return invalidTrashResult(`Failed to move file to trash: Target path "${relativeFilePath}" resolves outside the workspace via symlink or junction.`);
      }

      if (this.isPathInsideOrEqual(realTrash, realTarget)) {
        return invalidTrashResult('Failed to move file to trash: Cannot move items from or within the trash directory.');
      }

      if (!this.isPathInside(realRoot, realTrash)) return invalidTrashResult('Failed to move file to trash: Trash destination resolves outside the workspace.');
      const source = await fs.lstat(targetPath, { bigint: true });
      if (!source.isFile()) return invalidTrashResult('Failed to move file to trash: Only regular files can be moved.');
      if (process.platform !== 'win32') return invalidTrashResult('Verified file moves require the published Windows helper.');
      pinnedSource = await fs.open(realTarget, 'r');
      const pinned = await pinnedSource.stat({ bigint: true });
      if (!pinned.isFile() || pinned.ino === 0n || pinned.ino !== source.ino || pinned.dev !== source.dev)
        return invalidTrashResult('Failed to move file to trash: Could not pin the selected file.');
      await assertLinkFreePath(this.config.trashDir);

      failureStage = 'prepare';
      checkOperation(operation);
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
      const current = await fs.lstat(targetPath, { bigint: true });
      if (!current.isFile() || current.dev !== source.dev || current.ino !== source.ino)
        return invalidTrashResult('Failed to move file to trash: Source file changed during preparation.');
      await moveValidatedFile(realRoot, realTarget, realTrash, trashFileName, pinned, operation);
      moved = true;

      // After the move, finish recording its location rather than cancelling metadata recovery evidence.
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
        ), { flag: 'wx' }
      );

      return {
        success: true,
        outcome: 'completed', originalPath: targetPath, metadataPath: metaPath,
        trashPath: destinationPath,
        message: `File safely moved to trash: ${path.relative(this.root, destinationPath)}`,
      };
    } catch (err) {
      if (err instanceof TrashMoveUnconfirmed) return { success: false, outcome: 'partial', failureStage: 'move',
        errorCode: 'TRASH_MOVE_UNCONFIRMED', originalPath: targetPath, trashPath: destinationPath,
        message: err.message + ' Check the original and trash paths before retrying.' };
      if (!moved) rethrowOperationError(err, operation);
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
    } finally { await pinnedSource?.close(); }
  }
}
