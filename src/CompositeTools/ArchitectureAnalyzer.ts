import { WorkspaceManager, ProjectIdentity, WorkspaceTreeItem } from '../Core/Workspace.js';
import { SerenaAdapter } from '../Adapters/SerenaAdapter.js';
import { DotNetProjectGraph, loadDotNetProjectGraph } from '../Core/DotNetGraph.js';

export interface ArchitectureReport {
  projectName: string;
  projectTypes: string[];
  isWindowsDotNet: boolean;
  solutions: string[];
  projects: string[];
  layers: {
    name: string;
    description: string;
    matchedFiles: string[];
  }[];
  keyEntryPoints: string[];
  recommendedAgentFocus: string;
  projectGraph: DotNetProjectGraph | null;
}

/** Directory folder names are hints. For .NET, prefer projectGraph from sln/csproj files. */
export class ArchitectureAnalyzer {
  private workspace: WorkspaceManager;
  private serena: SerenaAdapter;

  constructor(workspace: WorkspaceManager, serena: SerenaAdapter) {
    this.workspace = workspace;
    this.serena = serena;
    void this.serena;
  }

  async analyze(maxDepth = 2): Promise<ArchitectureReport> {
    const identity: ProjectIdentity = await this.workspace.identifyProject();
    const tree: WorkspaceTreeItem = await this.workspace.getDirectoryTree(maxDepth);

    const layers = [
      {
        name: 'Presentation / Gateway',
        description: 'Entry points, API / MCP protocol handlers, UI layers (WPF/WinUI)',
        matchedFiles: [] as string[],
      },
      {
        name: 'Core / Domain',
        description: 'Business logic, workspace models, context orchestration, cache rules',
        matchedFiles: [] as string[],
      },
      {
        name: 'Adapters / Infrastructure',
        description: 'External integrations (Serena, Repomix, FlaUI)',
        matchedFiles: [] as string[],
      },
      {
        name: 'Composite Tools',
        description: 'High-level aggregated capabilities for coding agents',
        matchedFiles: [] as string[],
      },
    ];

    const directoryEntryPoints: string[] = [];

    const categorizeItem = (item: WorkspaceTreeItem) => {
      const lower = item.name.toLowerCase();
      if (['gateway', 'ui', 'views', 'controllers'].includes(lower)) {
        layers[0].matchedFiles.push(item.relativePath);
      } else if (['core', 'domain', 'models', 'services'].includes(lower)) {
        layers[1].matchedFiles.push(item.relativePath);
      } else if (['adapters', 'infra', 'infrastructure', 'external'].includes(lower)) {
        layers[2].matchedFiles.push(item.relativePath);
      } else if (['compositetools', 'tools', 'analyzers'].includes(lower)) {
        layers[3].matchedFiles.push(item.relativePath);
      }

      if (['index.ts', 'main.ts', 'app.xaml.cs', 'program.cs', 'main.py', 'server.ts'].includes(lower)) {
        directoryEntryPoints.push(item.relativePath.replace(/\\/g, '/'));
      }

      if (item.children) {
        for (const sub of item.children) {
          categorizeItem(sub);
        }
      }
    };

    if (tree.children) {
      for (const child of tree.children) {
        categorizeItem(child);
      }
    }

    let projectGraph: DotNetProjectGraph | null = null;
    if (identity.isDotNet) {
      projectGraph = await loadDotNetProjectGraph(
        this.workspace.root,
        identity.solutionFiles,
        identity.projectFiles
      );
    }

    const graphEntryPoints = projectGraph
      ? projectGraph.projects.flatMap((p) => p.entryPoints)
      : [];
    const keyEntryPoints = Array.from(new Set([...graphEntryPoints, ...directoryEntryPoints]));

    let recommendedAgentFocus: string;
    if (projectGraph && projectGraph.projects.length > 0) {
      const edgeText =
        projectGraph.edges.length > 0
          ? projectGraph.edges.map((e) => `${e.from}→${e.to}`).join(', ')
          : 'no ProjectReference edges parsed';
      recommendedAgentFocus = `Solution graph from project files: ${projectGraph.projects.length} project(s); dependencies: ${edgeText}. This is file-derived structure, not an architecture judgment.`;
    } else if (identity.isDotNet) {
      recommendedAgentFocus = 'A .NET workspace was detected but no parseable .sln/.csproj graph was produced.';
    } else {
      recommendedAgentFocus =
        'Non-.NET workspace: directory hints only. Do not treat folder names as verified architecture layers.';
    }

    return {
      projectName: identity.name,
      projectTypes: identity.frameworks,
      isWindowsDotNet: identity.isDotNet,
      solutions: identity.solutionFiles,
      projects: identity.projectFiles,
      layers,
      keyEntryPoints,
      recommendedAgentFocus,
      projectGraph,
    };
  }
}
