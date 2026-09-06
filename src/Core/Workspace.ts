import fs from 'node:fs/promises';
import path from 'node:path';
import { WinCodeConfig } from './Config.js';

export interface ProjectIdentity {
  name: string;
  frameworks: string[];
  isDotNet: boolean;
  solutionFiles: string[];
  projectFiles: string[];
  hasGit: boolean;
  packageManagers: string[];
}

export interface WorkspaceTreeItem {
  name: string;
  path: string;
  relativePath: string;
  type: 'file' | 'directory';
  size?: number;
  children?: WorkspaceTreeItem[];
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
    'TestResults',
  ]);

  constructor(config: WinCodeConfig) {
    this.config = config;
  }

  get root(): string {
    return this.config.workspaceRoot;
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
      }

      // Check subdirectories (1 level down) for .csproj files if solution is at root
      for (const entry of entries) {
        if (entry.isDirectory() && !this.defaultIgnores.has(entry.name)) {
          try {
            const subEntries = await fs.readdir(path.join(this.root, entry.name));
            for (const sub of subEntries) {
              if (sub.toLowerCase().endsWith('.csproj')) {
                projectFiles.push(path.join(entry.name, sub));
                if (!frameworks.includes('C# / .NET')) frameworks.push('C# / .NET');
              }
            }
          } catch {
            // Ignore unreadable directory
          }
        }
      }
    } catch (err) {
      console.warn('[WorkspaceManager] Error identifying project:', err);
    }

    return {
      name: path.basename(this.root),
      frameworks: Array.from(new Set(frameworks)),
      isDotNet: solutionFiles.length > 0 || projectFiles.length > 0,
      solutionFiles,
      projectFiles,
      hasGit,
      packageManagers,
    };
  }

  /**
   * Scans the workspace directory tree up to maxDepth
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
   * Safe file deletion policy: Moves files to the project trash directory.
   * Direct deletion of files is strictly forbidden according to project rules.
   */
  async moveToTrash(relativeOrAbsolutePath: string, reason?: string): Promise<{ success: boolean; trashPath: string; message: string }> {
    const targetPath = path.isAbsolute(relativeOrAbsolutePath)
      ? relativeOrAbsolutePath
      : path.join(this.root, relativeOrAbsolutePath);

    await fs.mkdir(this.config.trashDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = path.basename(targetPath);
    const trashFileName = `${timestamp}_${fileName}`;
    const destinationPath = path.join(this.config.trashDir, trashFileName);

    try {
      await fs.rename(targetPath, destinationPath);

      // Write a small metadata file in trash explaining the removal
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
