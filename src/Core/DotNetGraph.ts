/**
 * File-derived .NET solution graph: .sln project list, csproj ProjectReference,
 * TFM / WPF-WinUI-WinForms flags, and conventional entry files.
 * This is not an architecture judgment and does not use Roslyn.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

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
}

const ENTRY_NAMES = new Set([
  'program.cs',
  'app.xaml.cs',
  'startup.cs',
  'main.cs',
]);

export async function loadDotNetProjectGraph(
  workspaceRoot: string,
  solutionFiles: string[],
  projectFiles: string[]
): Promise<DotNetProjectGraph> {
  const solutions = [...solutionFiles];
  const discovered = new Map<string, string>();

  for (const proj of projectFiles) {
    const rel = proj.replace(/\\/g, '/');
    const name = path.basename(rel, path.extname(rel));
    discovered.set(rel.toLowerCase(), rel);
    if (!discovered.has(name.toLowerCase())) {
      discovered.set(name.toLowerCase(), rel);
    }
  }

  for (const sln of solutionFiles) {
    try {
      const slnContent = await fs.readFile(path.join(workspaceRoot, sln), 'utf-8');
      const projectRegex =
        /Project\("\{[A-Za-z0-9-]+\}"\)\s*=\s*"([^"]+)",\s*"([^"]+\.csproj)"/gi;
      let match: RegExpExecArray | null;
      while ((match = projectRegex.exec(slnContent)) !== null) {
        const rel = match[2].replace(/\\/g, '/');
        discovered.set(rel.toLowerCase(), rel);
        discovered.set(match[1].toLowerCase(), rel);
      }
    } catch {
      // Ignore unreadable solution files
    }
  }

  const uniqueRels = Array.from(new Set(Array.from(discovered.values())));
  const projects: DotNetProjectNode[] = [];

  for (const rel of uniqueRels) {
    const node = await parseCsproj(workspaceRoot, rel);
    if (node) {
      projects.push(node);
    }
  }

  const byRel = new Map(projects.map((p) => [p.relativePath.replace(/\\/g, '/').toLowerCase(), p]));
  const byName = new Map(projects.map((p) => [p.name.toLowerCase(), p]));
  const edges: { from: string; to: string }[] = [];

  for (const project of projects) {
    const resolvedRefs: string[] = [];
    for (const ref of project.projectReferences) {
      const target =
        byRel.get(ref.replace(/\\/g, '/').toLowerCase()) || byName.get(path.basename(ref, '.csproj').toLowerCase());
      if (target) {
        resolvedRefs.push(target.name);
        edges.push({ from: project.name, to: target.name });
      } else {
        resolvedRefs.push(path.basename(ref, '.csproj'));
      }
    }
    project.projectReferences = Array.from(new Set(resolvedRefs));
  }

  return { solutions, projects, edges };
}

async function parseCsproj(workspaceRoot: string, relativePath: string): Promise<DotNetProjectNode | null> {
  const fullPath = path.isAbsolute(relativePath) ? relativePath : path.join(workspaceRoot, relativePath);
  let content: string;
  try {
    content = await fs.readFile(fullPath, 'utf-8');
  } catch {
    return null;
  }

  const rel = path.relative(workspaceRoot, fullPath).replace(/\\/g, '/');
  const name = path.basename(rel, path.extname(rel));
  const sdkMatch = content.match(/<Project\s+[^>]*Sdk="([^"]+)"/i);
  const tfMatch =
    content.match(/<TargetFramework>([^<]+)<\/TargetFramework>/i) ||
    content.match(/<TargetFrameworks>([^<]+)<\/TargetFrameworks>/i);
  const outputMatch = content.match(/<OutputType>([^<]+)<\/OutputType>/i);

  const projectDir = path.dirname(fullPath);
  const rawRefs: string[] = [];
  const refRegex = /<ProjectReference\s+Include="([^"]+)"/gi;
  let refMatch: RegExpExecArray | null;
  while ((refMatch = refRegex.exec(content)) !== null) {
    const resolved = path.normalize(path.join(projectDir, refMatch[1].replace(/\\/g, path.sep)));
    rawRefs.push(path.relative(workspaceRoot, resolved).replace(/\\/g, '/'));
  }

  return {
    name,
    relativePath: rel,
    targetFramework: tfMatch?.[1]?.trim(),
    outputType: outputMatch?.[1]?.trim(),
    sdk: sdkMatch?.[1],
    isWpf: /<UseWPF>\s*true\s*<\/UseWPF>/i.test(content),
    isWinUi: /<UseWinUI>\s*true\s*<\/UseWinUI>/i.test(content),
    isWinForms: /<UseWindowsForms>\s*true\s*<\/UseWindowsForms>/i.test(content),
    isWeb: (sdkMatch?.[1] || '').toLowerCase().includes('web'),
    projectReferences: rawRefs,
    entryPoints: await findEntryPoints(workspaceRoot, projectDir),
  };
}

async function findEntryPoints(workspaceRoot: string, projectDir: string): Promise<string[]> {
  const found: string[] = [];

  const walk = async (dir: string, depth: number) => {
    if (depth > 3 || found.length >= 8) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (found.length >= 8) break;
      if (entry.name === 'bin' || entry.name === 'obj' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile() && ENTRY_NAMES.has(entry.name.toLowerCase())) {
        found.push(path.relative(workspaceRoot, full).replace(/\\/g, '/'));
      }
    }
  };

  await walk(projectDir, 0);
  return found;
}
