import fs from 'node:fs/promises';
import path from 'node:path';
import { parseProjectXml } from './ProjectXml.js';
import { checkOperation, rethrowOperationError, type OperationContext } from './OperationContext.js';
import { isWorkspacePathInside, validateWorkspaceDirectoryOptions, type ProjectIdentity, type WorkspaceMetadata, type WorkspaceTreeItem, type WorkspaceDirectoryOptions, type WorkspaceDirectoryResult } from './WorkspaceContracts.js';
import { DEFAULT_IGNORES, directoryOmission, previewOmission } from './WorkspaceBrowser.js';
const isInsideOrEqual = (parent: string, target: string) => isWorkspacePathInside(parent, target, true);

/** 识别现有项目声明；不求值构建脚本。 */
export async function identifyProject(root: string, operation?: OperationContext): Promise<ProjectIdentity> {
  const result = await discoverProject(root, operation);
  return { ...result.identity, scanComplete: result.complete, discovery: result.discovery };
}

/** 有界项目发现；保留原有深度、文件数和读取预算。 */
export async function discoverProject(root: string, parent?: OperationContext): Promise<{
  identity: ProjectIdentity; complete: boolean; entryPoints: string[];
  discovery: NonNullable<WorkspaceMetadata['projectDiscovery']>;
}> {
  const operation = { ...parent, deadline: Math.min(parent?.deadline ?? Infinity, Date.now() + 20_000) };
  checkOperation(operation);
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
  const realRoot = await fs.realpath(root);
  const solutions = new Set<string>();
  const projects = new Set<string>();
  const manifests = new Set<string>();
  const entryPoints = new Set<string>();
  const frameworks = new Set<string>();
  const packageManagers = new Set<string>();
  let targetFramework: string | undefined;
  let descriptorReads = 0;
  const relative = (full: string) => path.relative(root, full).replace(/\\/g, '/') || '.';
  const acceptProject = (project: string) => {
    const portable = project.replace(/\\/g, '/');
    if (path.isAbsolute(portable) || /^[a-z]:/i.test(portable) || !isWorkspacePathInside(root, path.resolve(root, portable))) {
      omit('.', 'project-path-outside-workspace');
      return;
    }
    const normalized = relative(path.resolve(root, portable));
    if (projects.size < 256) projects.add(normalized);
    else if (!projects.has(normalized)) omit('.', 'project-list-limit');
  };
  const readDescriptor = async (rel: string): Promise<string | null> => {
    checkOperation(operation);
    if (descriptorReads >= 16 || discovery.descriptorBytesRead >= discovery.maxDescriptorBytes) {
      omit(rel, 'descriptor-budget'); return null;
    }
    const full = path.resolve(root, rel);
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      const real = await fs.realpath(full);
      checkOperation(operation);
      if (!isWorkspacePathInside(realRoot, real)) { omit(rel, 'external-link'); return null; }
      handle = await fs.open(real, 'r');
      checkOperation(operation);
      const stat = await handle.stat();
      checkOperation(operation);
      if (!stat.isFile()) { omit(rel, 'not-a-file'); return null; }
      descriptorReads++;
      const capacity = Math.min(65536, discovery.maxDescriptorBytes - discovery.descriptorBytesRead);
      const buffer = Buffer.alloc(capacity);
      const { bytesRead } = await handle.read(buffer, 0, capacity, 0);
      checkOperation(operation);
      discovery.descriptorBytesRead += bytesRead;
      if (stat.size > bytesRead) omit(rel, 'descriptor-truncated');
      return buffer.subarray(0, bytesRead).toString('utf8');
    } catch (error) {
      rethrowOperationError(error, operation);
      omit(rel, 'descriptor-unreadable'); return null;
    } finally { await handle?.close(); }
  };
  // Fixed probes preserve common root identities even if a wide root exhausts enumeration.
  for (const name of ['package.json', 'requirements.txt', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'Directory.Build.props']) {
    checkOperation(operation);
    const stat = await fs.lstat(path.join(root, name)).catch(() => null);
    if (stat?.isFile()) manifests.add(name);
  }
  const queue = [{ full: root, depth: 0 }];
  while (queue.length && discovery.visitedEntries < discovery.maxEntries) {
    checkOperation(operation);
    const current = queue.shift()!;
    try {
      const real = await fs.realpath(current.full);
      if (!isInsideOrEqual(realRoot, real)) { omit(relative(current.full), 'external-link'); continue; }
      const directory = await fs.opendir(real);
      try { while (discovery.visitedEntries < discovery.maxEntries) {
        checkOperation(operation);
        const entry = await directory.read();
        checkOperation(operation);
        if (!entry) break;
        discovery.visitedEntries++;
        const full = path.join(current.full, entry.name);
        const rel = relative(full);
        if (entry.isSymbolicLink()) { omit(rel, 'link-not-followed'); continue; }
        if (entry.isDirectory()) {
          const reason = await previewOmission(full);
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
    } catch (error) {
      rethrowOperationError(error, operation);
      if (current.depth === 0) throw new Error('Workspace root could not be read during project discovery.');
      omit(relative(current.full), 'directory-unreadable');
    }
  }
  if (queue.length) omit('.', 'entry-budget');
  const readXml = async (file: string, rootElement: 'project' | 'solution') => {
    const content = await readDescriptor(file);
    if (content === null) return null;
    const parsed = parseProjectXml(content, rootElement);
    if (!parsed) omit(file, 'invalid-project-xml');
    return parsed;
  };
  for (const solution of solutions) {
    if (solution.toLowerCase().endsWith('.slnx')) {
      const xml = await readXml(solution, 'solution');
      for (const project of xml?.solutionProjects ?? []) acceptProject(project);
    } else {
      const content = await readDescriptor(solution);
      if (!content) continue;
      const declarations = /Project\("\{[A-Za-z0-9-]+\}"\)\s*=\s*"[^"]+",\s*"([^"]+\.csproj)"/g;
      for (const match of content.matchAll(declarations)) acceptProject(match[1]);
    }
  }
  for (const project of Array.from(projects).slice(0, 5)) {
    const xml = await readXml(project, 'project');
    if (!xml) continue;
    targetFramework ??= xml.targetFramework ?? xml.targetFrameworks;
    if (xml.isWpf) frameworks.add('WPF');
    if (xml.isWinUi) frameworks.add('WinUI');
    if (xml.isWinForms) frameworks.add('WinForms');
  }
  if (!targetFramework && manifests.has('Directory.Build.props')) {
    const props = await readXml('Directory.Build.props', 'project');
    targetFramework = props?.targetFramework ?? props?.targetFrameworks;
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
    name: path.basename(root), type, language, primarySolution: solutions.values().next().value ?? null,
    frameworks: Array.from(frameworks), isDotNet, solutionFiles: Array.from(solutions),
    projectFiles: Array.from(projects), hasGit: await fs.lstat(path.join(root, '.git')).then(() => true).catch(() => false),
    packageManagers: Array.from(packageManagers), targetFramework,
  };
  checkOperation(operation);
  return {
    identity, complete, discovery,
    entryPoints: Array.from(new Set([...Array.from(solutions).slice(0, 1), ...manifests, ...entryPoints, ...projects])).slice(0, 8),
  };
}

/** 按既有过滤规则统计目录，不改变搜索或缓存策略。 */
export async function getMetadata(root: string, identity: ProjectIdentity): Promise<WorkspaceMetadata> {
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
        if (!entry.isDirectory() && DEFAULT_IGNORES.has(entry.name)) continue;
        if (entry.isDirectory()) {
          const reason = await directoryOmission(full);
          if (reason) {
            omittedDirectoryCount++;
            // Keep the explanation bounded in repositories with many generated directories.
            if (omittedDirectories.length < 100) omittedDirectories.push({
              path: path.relative(root, full).replace(/\\/g, '/'), reason,
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

  await countWalk(root);

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
