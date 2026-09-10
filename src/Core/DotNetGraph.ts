/** File-derived .NET declarations; never evaluates MSBuild or imports outside projects. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveWorkspaceFile } from './FileSystemBoundary.js';
import { checkOperation, rethrowOperationError, type OperationContext } from './OperationContext.js';
import { listDirectory } from './WorkspaceBrowser.js';
import { isWorkspacePathInside } from './WorkspaceContracts.js';

export interface DotNetProjectNode {
  name: string;
  relativePath: string;
  targetFramework?: string;
  outputType?: string;
  sdk?: string;
  isWpf: boolean;
  isWinUi: boolean;
  isWinForms: boolean;
  isWeb: boolean;
  projectReferences: string[];
  entryPoints: string[];
}

export interface DotNetProjectGraph {
  solutions: string[];
  projects: DotNetProjectNode[];
  edges: { from: string; to: string }[];
  scanComplete: boolean;
  omissions: Array<{ path: string; reason: string }>;
  omittedCount: number;
  descriptorBytesRead: number;
  visitedEntries: number;
  limits: { maxProjects: number; maxDescriptorBytes: number; maxFileBytes: number; maxEntries: number };
}

const ENTRY_NAMES = new Set(['program.cs', 'app.xaml.cs', 'startup.cs', 'main.cs']);

export async function loadDotNetProjectGraph(
  workspaceRoot: string, solutionFiles: string[], projectFiles: string[],
  operation: OperationContext = { deadline: Date.now() + 20_000 },
): Promise<DotNetProjectGraph> {
  checkOperation(operation);
  const graph: DotNetProjectGraph = {
    solutions: solutionFiles.slice(0, 64), projects: [], edges: [], scanComplete: true, omissions: [], omittedCount: 0,
    descriptorBytesRead: 0, visitedEntries: 0,
    limits: { maxProjects: 16, maxDescriptorBytes: 262144, maxFileBytes: 65536, maxEntries: 2000 },
  };
  const omit = (file: string, reason: string) => {
    graph.scanComplete = false;
    graph.omittedCount++;
    if (graph.omissions.length < 24) graph.omissions.push({ path: file, reason });
  };
  // ProjectDiscovery already parses .sln/.slnx entries under the common workspace boundary.
  const unique = [...new Set(projectFiles.map(file => file.replace(/\\/g, '/')))];
  if (unique.length > graph.limits.maxProjects) omit('.', 'project-budget');
  if (solutionFiles.length > graph.solutions.length) omit('.', 'solution-budget');
  for (const rel of unique.slice(0, graph.limits.maxProjects)) {
    checkOperation(operation);
    if (graph.descriptorBytesRead >= graph.limits.maxDescriptorBytes) { omit(rel, 'descriptor-budget'); break; }
    let content: string;
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      const full = await resolveWorkspaceFile(workspaceRoot, rel);
      handle = await fs.open(full, 'r');
      const stat = await handle.stat();
      if (!stat.isFile()) { omit(rel, 'not-a-file'); continue; }
      const capacity = Math.min(graph.limits.maxFileBytes, graph.limits.maxDescriptorBytes - graph.descriptorBytesRead);
      if (stat.size > capacity) { omit(rel, 'descriptor-too-large'); continue; }
      const buffer = Buffer.alloc(capacity);
      const { bytesRead } = await handle.read(buffer, 0, capacity, 0);
      graph.descriptorBytesRead += bytesRead;
      checkOperation(operation);
      if (bytesRead !== stat.size || (await handle.stat()).size !== stat.size) { omit(rel, 'descriptor-changed'); continue; }
      content = buffer.subarray(0, bytesRead).toString('utf8');
    } catch (error) {
      rethrowOperationError(error, operation);
      omit(rel, 'descriptor-unreadable-or-outside-workspace');
      continue;
    } finally { await handle?.close(); }

    const field = (value?: string) => {
      if (value && value.length > 512) { omit(rel, 'metadata-field-budget'); return undefined; }
      return value?.trim();
    };
    const sdk = field(content.match(/<Project\s+[^>]*Sdk="([^"]+)"/i)?.[1]);
    const refs: string[] = [];
    for (const match of content.matchAll(/<ProjectReference\s+Include="([^"]+)"/gi)) {
      checkOperation(operation);
      if (refs.length >= 16) { omit(rel, 'reference-budget'); break; }
      const full = path.resolve(workspaceRoot, path.dirname(rel), match[1].replace(/\\/g, '/'));
      if (!isWorkspacePathInside(workspaceRoot, full)) { omit(rel, 'reference-outside-workspace'); continue; }
      refs.push(path.relative(workspaceRoot, full).replace(/\\/g, '/'));
    }
    const entryPoints: string[] = [];
    if (graph.visitedEntries < graph.limits.maxEntries) {
      try {
        const listing = await listDirectory(workspaceRoot, {
          path: path.dirname(rel), maxDepth: 4,
          maxEntries: Math.min(500, graph.limits.maxEntries - graph.visitedEntries), maxOutputChars: 32768,
        }, operation);
        graph.visitedEntries += listing.visitedEntries;
        if (!listing.scanComplete || listing.truncated) omit(rel, 'entry-point-scan-incomplete');
        for (const entry of listing.entries) {
          if (entry.type !== 'file' || !ENTRY_NAMES.has(path.posix.basename(entry.path).toLowerCase())) continue;
          if (entryPoints.length >= 8) { omit(rel, 'entry-point-result-budget'); break; }
          entryPoints.push(entry.path);
        }
      } catch (error) {
        rethrowOperationError(error, operation);
        omit(rel, 'entry-point-directory-unreadable');
      }
    } else omit(rel, 'entry-point-entry-budget');
    graph.projects.push({
      name: path.basename(rel, path.extname(rel)), relativePath: rel, sdk,
      targetFramework: field((content.match(/<TargetFramework>([^<]+)<\/TargetFramework>/i) ||
        content.match(/<TargetFrameworks>([^<]+)<\/TargetFrameworks>/i))?.[1]),
      outputType: field(content.match(/<OutputType>([^<]+)<\/OutputType>/i)?.[1]),
      isWpf: /<UseWPF>\s*true\s*<\/UseWPF>/i.test(content),
      isWinUi: /<UseWinUI>\s*true\s*<\/UseWinUI>/i.test(content),
      isWinForms: /<UseWindowsForms>\s*true\s*<\/UseWindowsForms>/i.test(content),
      isWeb: (sdk ?? '').toLowerCase().includes('web'), projectReferences: refs, entryPoints,
    });
  }
  const byRel = new Map(graph.projects.map(project => [project.relativePath.toLowerCase(), project]));
  for (const project of graph.projects) {
    const names: string[] = [];
    for (const ref of project.projectReferences) {
      const target = byRel.get(ref.toLowerCase());
      if (target) graph.edges.push({ from: project.name, to: target.name });
      names.push(target?.name ?? path.basename(ref, path.extname(ref)));
    }
    project.projectReferences = [...new Set(names)];
  }
  checkOperation(operation);
  return graph;
}
