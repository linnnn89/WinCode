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
  omittedDirectories?: Array<{ path: string; reason: string }>;
}

export interface WorkspaceGitStatus {
  isGit: boolean;
  branch?: string;
  isClean?: boolean;
  headCommit?: string;
  remoteUrl?: string;
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

  /** Browsing policy only: do not silently change symbol searches or cache fingerprints. */
  private async directoryOmission(dir: string): Promise<string | null> {
    if (this.defaultIgnores.has(path.basename(dir))) return 'default-ignore';
    if (path.basename(dir).toLowerCase() !== '.dotnet') return null;
    // The name alone is insufficient: preserve ordinary source folders named .dotnet.
    // Inspect marker metadata only; never execute the local SDK or follow marker links.
    const markers = await Promise.all(['dotnet.exe', 'dotnet', 'sdk', 'host'].map(name =>
      fs.lstat(path.join(dir, name)).catch(() => null)));
    const [exe, unix, sdk, host] = markers;
    return (exe?.isFile() || unix?.isFile()) && sdk?.isDirectory() && host?.isDirectory()
      ? 'local-dotnet-sdk' : null;
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

    const gitTimeout = this.config.timeouts?.gitMs ?? 5000;

    try {
      const { stdout: bOut } = await execAsync('git rev-parse --abbrev-ref HEAD', {
        cwd: this.root,
        windowsHide: true,
        timeout: gitTimeout,
      });
      branch = bOut.trim();
    } catch {
      // Fallback: read .git/HEAD when git CLI is missing, hung, or timed out
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
        timeout: gitTimeout,
      });
      headCommit = cOut.trim();
    } catch {}

    try {
      const { stdout: sOut } = await execAsync('git status --porcelain', {
        cwd: this.root,
        windowsHide: true,
        timeout: gitTimeout,
      });
      isClean = sOut.trim().length === 0;
    } catch {}

    try {
      const { stdout: rOut } = await execAsync('git remote get-url origin', {
        cwd: this.root,
        windowsHide: true,
        timeout: gitTimeout,
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
          const fullPath = path.join(dirPath, entry.name);
          if (!entry.isDirectory() && this.defaultIgnores.has(entry.name)) continue;

          if (entry.isDirectory()) {
            const reason = await this.directoryOmission(fullPath);
            if (reason) {
              (item.omittedDirectories ??= []).push({ path: path.relative(this.root, fullPath).replace(/\\/g, '/'), reason });
              continue;
            }
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
    const omittedDirectories: Array<{ path: string; reason: string }> = [];
    let omittedDirectoryCount = 0;

    const countWalk = async (dir: string, depth = 0) => {
      if (depth > 6) return;
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (!entry.isDirectory() && this.defaultIgnores.has(entry.name)) continue;
          if (entry.isDirectory()) {
            const reason = await this.directoryOmission(full);
            if (reason) {
              omittedDirectoryCount++;
              // Keep the explanation bounded in repositories with many generated directories.
              if (omittedDirectories.length < 100) omittedDirectories.push({
                path: path.relative(this.root, full).replace(/\\/g, '/'), reason,
              });
              continue;
            }
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
      scanScope: 'filtered-depth-limited',
      maxScanDepth: 6,
      omittedDirectories,
      omittedDirectoryCount,
      targetFramework: identity.targetFramework,
      frameworks: identity.frameworks,
      packageManagers: identity.packageManagers,
      solutions: identity.solutionFiles,
      projectList: identity.projectFiles,
    };
  }

  private boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number, name: string): number {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
      throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
    }
    return value;
  }

  /** Extra preview filters do not affect symbol discovery, cache keys, or explicit legacy scans. */
  private async previewOmission(dir: string): Promise<string | null> {
    const existing = await this.directoryOmission(dir);
    if (existing) return existing;
    const name = path.basename(dir).toLowerCase();
    return /^(?:\.publish(?:[-.].*)?|publish|artifacts|work)$/.test(name)
      ? 'generated-or-work-directory' : null;
  }

  /** Bounded discovery intentionally does not build a tree or stat individual output binaries. */
  private async discoverProject(): Promise<{
    identity: ProjectIdentity; complete: boolean; entryPoints: string[];
    discovery: NonNullable<WorkspaceMetadata['projectDiscovery']>;
  }> {
    const discovery: NonNullable<WorkspaceMetadata['projectDiscovery']> = {
      visitedEntries: 0, descriptorBytesRead: 0, maxEntries: 2000, maxDepth: 3,
      maxDescriptorBytes: 262144, ignoredDirectoryCount: 0, omissions: [], omittedCount: 0,
    };
    let complete = true;
    const omit = (relative: string, reason: string, incomplete = true) => {
      if (incomplete) complete = false;
      discovery.omittedCount++;
      if (['default-ignore', 'local-dotnet-sdk', 'generated-or-work-directory'].includes(reason)) discovery.ignoredDirectoryCount++;
      if (discovery.omissions.length < 24) discovery.omissions.push({ path: relative, reason });
    };
    const realRoot = await fs.realpath(this.root);
    const solutions = new Set<string>();
    const projects = new Set<string>();
    const manifests = new Set<string>();
    const entryPoints = new Set<string>();
    const frameworks = new Set<string>();
    const packageManagers = new Set<string>();
    let targetFramework: string | undefined;
    let descriptorReads = 0;
    const relative = (full: string) => path.relative(this.root, full).replace(/\\/g, '/') || '.';
    const acceptProject = (project: string) => {
      const portable = project.replace(/\\/g, '/');
      if (path.isAbsolute(portable) || /^[a-z]:/i.test(portable) || !this.isPathInside(this.root, path.resolve(this.root, portable))) {
        omit('.', 'project-path-outside-workspace');
        return;
      }
      const normalized = relative(path.resolve(this.root, portable));
      if (projects.size < 256) projects.add(normalized);
      else if (!projects.has(normalized)) omit('.', 'project-list-limit');
    };
    const readDescriptor = async (rel: string): Promise<string | null> => {
      if (descriptorReads >= 16 || discovery.descriptorBytesRead >= discovery.maxDescriptorBytes) {
        omit(rel, 'descriptor-budget'); return null;
      }
      const full = path.resolve(this.root, rel);
      let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
      try {
        const real = await fs.realpath(full);
        if (!this.isPathInside(realRoot, real)) { omit(rel, 'external-link'); return null; }
        handle = await fs.open(real, 'r');
        const stat = await handle.stat();
        if (!stat.isFile()) { omit(rel, 'not-a-file'); return null; }
        descriptorReads++;
        const capacity = Math.min(65536, discovery.maxDescriptorBytes - discovery.descriptorBytesRead);
        const buffer = Buffer.alloc(capacity);
        const { bytesRead } = await handle.read(buffer, 0, capacity, 0);
        discovery.descriptorBytesRead += bytesRead;
        if (stat.size > bytesRead) omit(rel, 'descriptor-truncated');
        return buffer.subarray(0, bytesRead).toString('utf8');
      } catch {
        omit(rel, 'descriptor-unreadable'); return null;
      } finally { await handle?.close(); }
    };
    // Fixed probes preserve common root identities even if a wide root exhausts enumeration.
    for (const name of ['package.json', 'requirements.txt', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'Directory.Build.props']) {
      const stat = await fs.lstat(path.join(this.root, name)).catch(() => null);
      if (stat?.isFile()) manifests.add(name);
    }
    const queue = [{ full: this.root, depth: 0 }];
    while (queue.length && discovery.visitedEntries < discovery.maxEntries) {
      const current = queue.shift()!;
      try {
        const real = await fs.realpath(current.full);
        if (!this.isPathInsideOrEqual(realRoot, real)) { omit(relative(current.full), 'external-link'); continue; }
        const directory = await fs.opendir(real);
        try { while (discovery.visitedEntries < discovery.maxEntries) {
          const entry = await directory.read();
          if (!entry) break;
          discovery.visitedEntries++;
          const full = path.join(current.full, entry.name);
          const rel = relative(full);
          if (entry.isSymbolicLink()) { omit(rel, 'link-not-followed'); continue; }
          if (entry.isDirectory()) {
            const reason = await this.previewOmission(full);
            if (reason) { omit(rel, reason, false); continue; }
            if (current.depth >= discovery.maxDepth) { omit(rel, 'depth-limit'); continue; }
            queue.push({ full, depth: current.depth + 1 });
          } else if (entry.isFile()) {
            const lower = entry.name.toLowerCase();
            if (lower.endsWith('.csproj')) acceptProject(rel);
            if (/^(?:src\/)?(?:index\.[cm]?[jt]s|main\.[cm]?[jt]s|main\.py|Program\.cs|App\.xaml)$/i.test(rel) && entryPoints.size < 8) entryPoints.add(rel);
            if (current.depth === 0) {
              if (lower.endsWith('.sln') || lower.endsWith('.slnx')) {
                if (solutions.size < 64) solutions.add(rel); else omit('.', 'solution-list-limit');
              }
              if (/^(readme(?:\.(?:md|txt))?|agents\.md)$/i.test(entry.name) && entryPoints.size < 8) entryPoints.add(rel);
            }
          }
        } } finally { await directory.close(); }
        if (discovery.visitedEntries >= discovery.maxEntries) omit(relative(current.full), 'entry-budget');
      } catch {
        if (current.depth === 0) throw new Error('Workspace root could not be read during project discovery.');
        omit(relative(current.full), 'directory-unreadable');
      }
    }
    if (queue.length) omit('.', 'entry-budget');
    const decodeXmlPath = (value: string): string | null => {
      const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
      let valid = true;
      const decoded = value.replace(/&([^;]*);|&/g, (_match, entity: string | undefined) => {
        if (entity && Object.hasOwn(named, entity)) return named[entity];
        if (entity && /^(?:#[0-9]+|#x[0-9a-fA-F]+)$/.test(entity)) {
          const code = entity.startsWith('#x') ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
          // XML 1.0 permits these characters; reject NUL, surrogate halves and invalid code points.
          if (Number.isSafeInteger(code) && (code === 9 || code === 10 || code === 13 ||
            (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) ||
            (code >= 0x10000 && code <= 0x10ffff))) return String.fromCodePoint(code);
        }
        valid = false;
        return '';
      });
      return valid ? decoded : null;
    };
    for (const solution of solutions) {
      const content = await readDescriptor(solution);
      if (!content) continue;
      const isXml = solution.toLowerCase().endsWith('.slnx');
      const regex = isXml
        ? /<Project\b[^>]*\bPath\s*=\s*(?:"([^"]*)"|'([^']*)')/gi
        : /Project\("\{[A-Za-z0-9-]+\}"\)\s*=\s*"[^"]+",\s*"([^"]+\.csproj)"/g;
      let match;
      while ((match = regex.exec(content)) !== null) {
        const project = isXml ? decodeXmlPath(match[1] ?? match[2]) : match[1];
        if (project === null) omit(solution, 'invalid-project-path-entity');
        else if (!isXml || project.toLowerCase().endsWith('.csproj')) acceptProject(project);
      }
    }
    for (const project of Array.from(projects).slice(0, 5)) {
      const content = await readDescriptor(project);
      if (!content) continue;
      targetFramework ??= content.match(/<TargetFramework>([^<]+)<\/TargetFramework>/i)?.[1].trim();
      if (/<UseWPF>\s*true\s*<\/UseWPF>/i.test(content)) frameworks.add('WPF');
      if (/<UseWinUI>\s*true\s*<\/UseWinUI>/i.test(content)) frameworks.add('WinUI');
      if (/<UseWindowsForms>\s*true\s*<\/UseWindowsForms>/i.test(content)) frameworks.add('WinForms');
    }
    if (!targetFramework && manifests.has('Directory.Build.props')) {
      targetFramework = (await readDescriptor('Directory.Build.props'))?.match(/<TargetFramework>([^<]+)<\/TargetFramework>/i)?.[1].trim();
    }
    if (manifests.has('package.json')) { packageManagers.add('npm/node'); frameworks.add('Node.js / TypeScript'); }
    if (manifests.has('requirements.txt') || manifests.has('pyproject.toml')) { packageManagers.add('pip/python'); frameworks.add('Python'); }
    if (manifests.has('Cargo.toml')) frameworks.add('Rust');
    if (manifests.has('go.mod')) frameworks.add('Go');
    const isDotNet = solutions.size > 0 || projects.size > 0;
    let type: ProjectIdentity['type'] = 'general';
    let language = 'Unknown';
    if (isDotNet) {
      type = 'dotnet'; language = 'C#'; packageManagers.add('NuGet');
      if (solutions.size) frameworks.add('.NET Solution');
      if (projects.size) frameworks.add('C# / .NET');
      if (targetFramework) frameworks.add(targetFramework);
    } else if (packageManagers.has('npm/node')) { type = 'node'; language = 'TypeScript'; }
    else if (packageManagers.has('pip/python')) { type = 'python'; language = 'Python'; }
    else if (frameworks.has('Rust')) { type = 'rust'; language = 'Rust'; }
    else if (frameworks.has('Go')) { type = 'go'; language = 'Go'; }
    const identity: ProjectIdentity = {
      name: path.basename(this.root), type, language, primarySolution: solutions.values().next().value ?? null,
      frameworks: Array.from(frameworks), isDotNet, solutionFiles: Array.from(solutions),
      projectFiles: Array.from(projects), hasGit: await fs.lstat(path.join(this.root, '.git')).then(() => true).catch(() => false),
      packageManagers: Array.from(packageManagers), targetFramework,
    };
    return {
      identity, complete, discovery,
      entryPoints: Array.from(new Set([...Array.from(solutions).slice(0, 1), ...manifests, ...entryPoints, ...projects])).slice(0, 8),
    };
  }

  /** Directory browsing is stateless and bounds enumeration as well as final serialization. */
  async listDirectory(options: WorkspaceDirectoryOptions = {}): Promise<WorkspaceDirectoryResult> {
    const maxDepth = this.boundedInteger(options.maxDepth, 1, 1, 5, 'maxDepth');
    const maxEntries = this.boundedInteger(options.maxEntries, 100, 1, 500, 'maxEntries');
    const maxOutputChars = this.boundedInteger(options.maxOutputChars, 8000, 2048, 32768, 'maxOutputChars');
    if (options.includeIgnored !== undefined && typeof options.includeIgnored !== 'boolean') throw new Error('includeIgnored must be a boolean.');
    const requested = options.path ?? '.';
    if (typeof requested !== 'string' || !requested.trim() || requested.length > 4096 || requested.includes('\0') ||
      requested.split(/[\\/]/).includes('..') || path.isAbsolute(requested) || /^[a-z]:/i.test(requested) || /^(\/\/|\\\\)/.test(requested)) {
      throw new Error('Directory path must be a non-empty relative path inside the workspace.');
    }
    const full = path.resolve(this.root, requested);
    if (!this.isPathInsideOrEqual(this.root, full)) throw new Error('Directory path is outside the workspace.');
    const realRoot = await fs.realpath(this.root);
    const realTarget = await fs.realpath(full);
    if (!this.isPathInsideOrEqual(realRoot, realTarget)) throw new Error('Directory path resolves outside the workspace.');
    if (!(await fs.stat(realTarget)).isDirectory()) throw new Error('Directory path is not a directory.');
    const relative = (value: string) => path.relative(this.root, value).replace(/\\/g, '/') || '.';
    const result: WorkspaceDirectoryResult = {
      workspace: this.root, path: relative(full), entries: [], omissions: [], omittedCount: 0,
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
        if (!this.isPathInsideOrEqual(realRoot, real)) { omit(relative(current.full), 'external-link'); continue; }
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
            const reason = await this.previewOmission(entryFull);
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
    return this.fitDirectory(result);
  }

  private fitDirectory(result: WorkspaceDirectoryResult): WorkspaceDirectoryResult {
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

  /**
   * Phase 2: Opens and analyzes any target workspace directory.
   */
  async openWorkspace(targetPath: string, options: WorkspaceOpenOptions = {}): Promise<WorkspaceOpenResult> {
    const maxOutputChars = this.boundedInteger(options.maxOutputChars, 8000, 2048, 32768, 'maxOutputChars');
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
    this.setRoot(resolvedPath);
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
