import fs from 'node:fs/promises';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { WinCodeConfig } from './Config.js';

const execAsync = promisify(exec);

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
}

export interface WorkspaceTreeItem {
  name: string;
  path: string;
  relativePath: string;
  type: 'file' | 'directory';
  size?: number;
  children?: WorkspaceTreeItem[];
}

export interface WorkspaceGitStatus {
  isGit: boolean;
  branch?: string;
  isClean?: boolean;
  headCommit?: string;
  remoteUrl?: string;
}

export interface WorkspaceMetadata {
  totalFiles: number;
  totalDirectories: number;
  totalSizeBytes: number;
  targetFramework?: string;
  frameworks: string[];
  packageManagers: string[];
  solutions: string[];
  projectList: string[];
}

export interface WorkspaceOpenResult {
  type: 'dotnet' | 'node' | 'python' | 'rust' | 'go' | 'general';
  solution: string | null;
  projects: number;
  language: string;
  git: WorkspaceGitStatus;
  metadata: WorkspaceMetadata;
  fileTree: WorkspaceTreeItem;
}

export class WorkspaceManager {
  private config: WinCodeConfig;
  private defaultIgnores = new Set([
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
    const resolvedParent = path.resolve(parentDir);
    const resolvedTarget = path.resolve(targetPath);

    const normalizedParent = process.platform === 'win32' ? resolvedParent.toLowerCase() : resolvedParent;
    const normalizedTarget = process.platform === 'win32' ? resolvedTarget.toLowerCase() : resolvedTarget;

    const rel = path.relative(normalizedParent, normalizedTarget);
    if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
      return false;
    }
    return true;
  }

  /**
   * Checks if targetPath is parentDir itself or strictly inside parentDir
   */
  private isPathInsideOrEqual(parentDir: string, targetPath: string): boolean {
    const resolvedParent = path.resolve(parentDir);
    const resolvedTarget = path.resolve(targetPath);

    const normalizedParent = process.platform === 'win32' ? resolvedParent.toLowerCase() : resolvedParent;
    const normalizedTarget = process.platform === 'win32' ? resolvedTarget.toLowerCase() : resolvedTarget;

    if (normalizedParent === normalizedTarget) {
      return true;
    }

    const rel = path.relative(normalizedParent, normalizedTarget);
    if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
      return false;
    }
    return true;
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
      } catch {
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
  async identifyProject(): Promise<ProjectIdentity> {
    const frameworks: string[] = [];
    const solutionFiles: string[] = [];
    const projectFiles: string[] = [];
    const packageManagers: string[] = [];
    let hasGit = false;
    let targetFramework: string | undefined;

    try {
      const entries = await fs.readdir(this.root, { withFileTypes: true });

      for (const entry of entries) {
        const lower = entry.name.toLowerCase();
        if (entry.name === '.git') hasGit = true;
        if (lower.endsWith('.sln') || lower.endsWith('.slnx')) {
          solutionFiles.push(entry.name);
          frameworks.push('.NET Solution');
        }
        if (lower.endsWith('.csproj')) {
          projectFiles.push(entry.name);
          frameworks.push('C# / .NET');
        }
        if (entry.name === 'package.json') {
          packageManagers.push('npm/node');
          frameworks.push('Node.js / TypeScript');
        }
        if (entry.name === 'requirements.txt' || entry.name === 'pyproject.toml') {
          packageManagers.push('pip/python');
          frameworks.push('Python');
        }
        if (entry.name === 'Cargo.toml') {
          frameworks.push('Rust');
        }
        if (entry.name === 'go.mod') {
          frameworks.push('Go');
        }
      }

      // If solution file exists, parse projects defined inside it
      if (solutionFiles.length > 0) {
        for (const sln of solutionFiles) {
          try {
            const slnContent = await fs.readFile(path.join(this.root, sln), 'utf-8');
            const projectRegex = /Project\("\{[A-Za-z0-9-]+\}"\)\s*=\s*"([^"]+)",\s*"([^"]+\.csproj)"/g;
            let match;
            while ((match = projectRegex.exec(slnContent)) !== null) {
              const projRelPath = match[2].replace(/\\/g, '/');
              if (!projectFiles.includes(projRelPath)) {
                projectFiles.push(projRelPath);
              }
            }
          } catch {
            // Ignore sln read errors
          }
        }
      }

      // Deep search for .csproj files in subdirectories up to 3 levels if not in solution
      if (projectFiles.length === 0) {
        const scanCsproj = async (dir: string, depth: number) => {
          if (depth > 3) return;
          const subEntries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
          for (const sub of subEntries) {
            if (this.defaultIgnores.has(sub.name)) continue;
            const full = path.join(dir, sub.name);
            if (sub.isDirectory()) {
              await scanCsproj(full, depth + 1);
            } else if (sub.name.toLowerCase().endsWith('.csproj')) {
              projectFiles.push(path.relative(this.root, full));
            }
          }
        };
        await scanCsproj(this.root, 0);
      }

      // Inspect csproj files for WPF/WinUI/TargetFramework
      for (const proj of projectFiles.slice(0, 5)) {
        try {
          const fullProj = path.isAbsolute(proj) ? proj : path.join(this.root, proj);
          const projContent = await fs.readFile(fullProj, 'utf-8');
          const tfMatch = projContent.match(/<TargetFramework>([^<]+)<\/TargetFramework>/i);
          if (tfMatch && !targetFramework) {
            targetFramework = tfMatch[1].trim();
          }
          if (projContent.includes('<UseWPF>true</UseWPF>') && !frameworks.includes('WPF')) {
            frameworks.push('WPF');
          }
          if (projContent.includes('<UseWinUI>true</UseWinUI>') && !frameworks.includes('WinUI')) {
            frameworks.push('WinUI');
          }
          if (projContent.includes('<UseWindowsForms>true</UseWindowsForms>') && !frameworks.includes('WinForms')) {
            frameworks.push('WinForms');
          }
        } catch {
          // Ignore
        }
      }

      // Check Directory.Build.props if targetFramework not yet found
      if (!targetFramework) {
        try {
          const propsContent = await fs.readFile(path.join(this.root, 'Directory.Build.props'), 'utf-8');
          const tfMatch = propsContent.match(/<TargetFramework>([^<]+)<\/TargetFramework>/i);
          if (tfMatch) targetFramework = tfMatch[1].trim();
        } catch {
          // Ignore
        }
      }
    } catch (err) {
      console.warn('[WorkspaceManager] Error identifying project:', err);
    }

    const isDotNet = solutionFiles.length > 0 || projectFiles.length > 0;
    let type: 'dotnet' | 'node' | 'python' | 'rust' | 'go' | 'general' = 'general';
    let language = 'Unknown';

    if (isDotNet) {
      type = 'dotnet';
      language = 'C#';
      if (!packageManagers.includes('NuGet')) packageManagers.push('NuGet');
      if (targetFramework && !frameworks.includes(targetFramework)) frameworks.push(targetFramework);
    } else if (packageManagers.includes('npm/node')) {
      type = 'node';
      language = 'TypeScript';
    } else if (packageManagers.includes('pip/python')) {
      type = 'python';
      language = 'Python';
    } else if (frameworks.includes('Rust')) {
      type = 'rust';
      language = 'Rust';
    } else if (frameworks.includes('Go')) {
      type = 'go';
      language = 'Go';
    }

    return {
      name: path.basename(this.root),
      type,
      language,
      primarySolution: solutionFiles[0] || null,
      frameworks: Array.from(new Set(frameworks)),
      isDotNet,
      solutionFiles,
      projectFiles,
      hasGit,
      packageManagers,
      targetFramework,
    };
  }

  /**
   * Retrieves Git status safely for the current workspace
   */
  async getGitStatus(): Promise<WorkspaceGitStatus> {
    const gitDir = path.join(this.root, '.git');
    const isGit = await fs.stat(gitDir).then((s) => s.isDirectory()).catch(() => false);
    if (!isGit) {
      return { isGit: false };
    }

    let branch = 'unknown';
    let isClean = true;
    let headCommit: string | undefined;
    let remoteUrl: string | undefined;

    try {
      const { stdout: bOut } = await execAsync('git rev-parse --abbrev-ref HEAD', {
        cwd: this.root,
        windowsHide: true,
      });
      branch = bOut.trim();
    } catch {
      // Fallback: read .git/HEAD
      try {
        const headContent = await fs.readFile(path.join(gitDir, 'HEAD'), 'utf-8');
        const match = headContent.match(/ref:\s*refs\/heads\/([^\r\n]+)/);
        if (match) branch = match[1];
      } catch {}
    }

    try {
      const { stdout: cOut } = await execAsync('git rev-parse --short HEAD', {
        cwd: this.root,
        windowsHide: true,
      });
      headCommit = cOut.trim();
    } catch {}

    try {
      const { stdout: sOut } = await execAsync('git status --porcelain', {
        cwd: this.root,
        windowsHide: true,
      });
      isClean = sOut.trim().length === 0;
    } catch {}

    try {
      const { stdout: rOut } = await execAsync('git remote get-url origin', {
        cwd: this.root,
        windowsHide: true,
      });
      remoteUrl = rOut.trim();
    } catch {}

    return {
      isGit: true,
      branch,
      isClean,
      headCommit,
      remoteUrl,
    };
  }

  /**
   * Scans the workspace directory tree up to maxDepth and collects summary statistics
   */
  async getDirectoryTree(maxDepth = 3): Promise<WorkspaceTreeItem> {
    const scan = async (dirPath: string, currentDepth: number): Promise<WorkspaceTreeItem> => {
      const name = path.basename(dirPath);
      const relativePath = path.relative(this.root, dirPath) || '.';
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
          if (this.defaultIgnores.has(entry.name)) continue;
          const fullPath = path.join(dirPath, entry.name);

          if (entry.isDirectory()) {
            item.children?.push(await scan(fullPath, currentDepth + 1));
          } else if (entry.isFile()) {
            const stat = await fs.stat(fullPath).catch(() => null);
            item.children?.push({
              name: entry.name,
              path: fullPath,
              relativePath: path.relative(this.root, fullPath),
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

    return scan(this.root, 0);
  }

  /**
   * Collects workspace statistics (file count, dir count, total size)
   */
  async getMetadata(identity: ProjectIdentity): Promise<WorkspaceMetadata> {
    let totalFiles = 0;
    let totalDirectories = 0;
    let totalSizeBytes = 0;

    const countWalk = async (dir: string, depth = 0) => {
      if (depth > 6) return;
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (this.defaultIgnores.has(entry.name)) continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            totalDirectories++;
            await countWalk(full, depth + 1);
          } else if (entry.isFile()) {
            totalFiles++;
            const s = await fs.stat(full).catch(() => null);
            if (s) totalSizeBytes += s.size;
          }
        }
      } catch {}
    };

    await countWalk(this.root);

    return {
      totalFiles,
      totalDirectories,
      totalSizeBytes,
      targetFramework: identity.targetFramework,
      frameworks: identity.frameworks,
      packageManagers: identity.packageManagers,
      solutions: identity.solutionFiles,
      projectList: identity.projectFiles,
    };
  }

  /**
   * Phase 2: Opens and analyzes any target workspace directory.
   */
  async openWorkspace(targetPath: string): Promise<WorkspaceOpenResult> {
    const resolvedPath = path.resolve(targetPath);

    const stat = await fs.stat(resolvedPath).catch(() => null);
    if (!stat || !stat.isDirectory()) {
      throw new Error(`Invalid workspace path: "${targetPath}". Directory does not exist.`);
    }

    // Switch current workspace root
    this.setRoot(resolvedPath);

    const identity = await this.identifyProject();
    const git = await this.getGitStatus();
    const metadata = await this.getMetadata(identity);
    const fileTree = await this.getDirectoryTree(2);

    return {
      type: identity.type,
      solution: identity.primarySolution,
      projects: identity.projectFiles.length,
      language: identity.language,
      git,
      metadata,
      fileTree,
    };
  }

  /**
   * Safe file deletion policy: Moves files to the project trash directory.
   * Only accepts non-empty relative paths strictly within the workspace.
   */
  async moveToTrash(relativeFilePath: string, reason?: string): Promise<{ success: boolean; trashPath: string; message: string }> {
    // 1. Validate non-empty input
    if (!relativeFilePath || !relativeFilePath.trim()) {
      return {
        success: false,
        trashPath: '',
        message: 'Failed to move file to trash: Path cannot be empty.',
      };
    }

    // 2. Reject absolute paths, Windows drive-relative paths (e.g. C:foo), and UNC paths
    if (
      path.isAbsolute(relativeFilePath) ||
      /^[a-zA-Z]:/.test(relativeFilePath) ||
      /^(\/\/|\\\\)/.test(relativeFilePath)
    ) {
      return {
        success: false,
        trashPath: '',
        message: `Failed to move file to trash: Only non-empty relative paths within the workspace are accepted. Received: "${relativeFilePath}".`,
      };
    }

    const targetPath = path.resolve(this.root, relativeFilePath);

    // 3. Lexical boundary check: must be strictly inside workspace root (reject root itself and parent traversal)
    if (!this.isPathInside(this.root, targetPath)) {
      return {
        success: false,
        trashPath: '',
        message: `Failed to move file to trash: Path "${relativeFilePath}" is outside the workspace boundary.`,
      };
    }

    // 4. Lexical trash directory & sub-tree check: cannot move trash root or anything inside trash
    if (this.isPathInsideOrEqual(this.config.trashDir, targetPath)) {
      return {
        success: false,
        trashPath: '',
        message: 'Failed to move file to trash: Cannot move items from or within the trash directory.',
      };
    }

    // 5. Realpath boundary check: resolve symlinks and Windows junctions to prevent escaping via links
    const realRoot = await this.getRealPath(this.root);
    const realTarget = await this.getRealPath(targetPath);
    const realTrash = await this.getRealPath(this.config.trashDir);

    if (!this.isPathInside(realRoot, realTarget)) {
      return {
        success: false,
        trashPath: '',
        message: `Failed to move file to trash: Target path "${relativeFilePath}" resolves outside the workspace via symlink or junction.`,
      };
    }

    if (this.isPathInsideOrEqual(realTrash, realTarget)) {
      return {
        success: false,
        trashPath: '',
        message: 'Failed to move file to trash: Cannot move items from or within the trash directory.',
      };
    }

    // All checks passed without side-effects -> proceed to file operations
    await fs.mkdir(this.config.trashDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = path.basename(targetPath);
    const trashFileName = `${timestamp}_${fileName}`;
    const destinationPath = path.join(this.config.trashDir, trashFileName);

    try {
      await fs.rename(targetPath, destinationPath);

      const metaPath = path.join(this.config.trashDir, `${trashFileName}.meta.json`);
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
        trashPath: destinationPath,
        message: `File safely moved to trash: ${path.relative(this.root, destinationPath)}`,
      };
    } catch (err: any) {
      return {
        success: false,
        trashPath: destinationPath,
        message: `Failed to move file to trash: ${err?.message || String(err)}`,
      };
    }
  }
}
