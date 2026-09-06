import path from 'node:path';
import { WorkspaceManager, ProjectIdentity, WorkspaceTreeItem } from '../Core/Workspace.js';
import { SerenaAdapter, CodeSymbol } from '../Adapters/SerenaAdapter.js';

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
}

export class ArchitectureAnalyzer {
  private workspace: WorkspaceManager;
  private serena: SerenaAdapter;

  constructor(workspace: WorkspaceManager, serena: SerenaAdapter) {
    this.workspace = workspace;
    this.serena = serena;
  }

  async analyze(): Promise<ArchitectureReport> {
    const identity: ProjectIdentity = await this.workspace.identifyProject();
    const tree: WorkspaceTreeItem = await this.workspace.getDirectoryTree(2);

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
        description: 'External integrations (Serena, Repomix, Roslyn, FlaUI)',
        matchedFiles: [] as string[],
      },
      {
        name: 'Composite Tools',
        description: 'High-level aggregated capabilities for coding agents',
        matchedFiles: [] as string[],
      },
    ];

    const entryPoints: string[] = [];

    // Helper to categorize items
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
        entryPoints.push(item.relativePath);
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

    let recommendedAgentFocus = 'Follow modular separation: keep adapters isolated and expose high-level composite tools via Gateway.';
    if (identity.isDotNet) {
      recommendedAgentFocus = 'Windows .NET solution detected. Ensure MSBuild / Roslyn compatibility and inspect project references.';
    }

    return {
      projectName: identity.name,
      projectTypes: identity.frameworks,
      isWindowsDotNet: identity.isDotNet,
      solutions: identity.solutionFiles,
      projects: identity.projectFiles,
      layers,
      keyEntryPoints: entryPoints,
      recommendedAgentFocus,
    };
  }
}
