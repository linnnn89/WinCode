import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { WorkspaceManager, ProjectIdentity } from '../Core/Workspace.js';
import { WinCodeConfig } from '../Core/Config.js';

const execAsync = promisify(exec);

export interface DiagnosticItem {
  category: 'Environment' | 'Project' | 'Dependencies' | 'Windows';
  status: 'PASS' | 'WARN' | 'FAIL';
  message: string;
  suggestion?: string;
}

export interface DiagnosticsReport {
  workspaceName: string;
  isDotNetProject: boolean;
  diagnostics: DiagnosticItem[];
  overallHealthy: boolean;
}

export class ProjectDiagnostics {
  private workspace: WorkspaceManager;
  private config: WinCodeConfig;

  constructor(workspace: WorkspaceManager, config: WinCodeConfig) {
    this.workspace = workspace;
    this.config = config;
  }

  async runDiagnostics(): Promise<DiagnosticsReport> {
    const identity: ProjectIdentity = await this.workspace.identifyProject();
    const items: DiagnosticItem[] = [];

    // Check Windows platform
    if (process.platform === 'win32') {
      items.push({
        category: 'Windows',
        status: 'PASS',
        message: 'Running natively on Windows OS with full desktop capabilities support.',
      });
    } else {
      items.push({
        category: 'Windows',
        status: 'WARN',
        message: `Running on ${process.platform}. Windows-specific integrations (WPF, FlaUI) may have limited support.`,
      });
    }

    // Check .NET SDK availability
    try {
      const { stdout } = await execAsync('dotnet --version', { windowsHide: true });
      items.push({
        category: 'Environment',
        status: 'PASS',
        message: `.NET SDK detected (Version: ${stdout.trim()}).`,
      });
    } catch {
      items.push({
        category: 'Environment',
        status: identity.isDotNet ? 'FAIL' : 'WARN',
        message: '.NET SDK (dotnet CLI) not found in system PATH.',
        suggestion: identity.isDotNet ? 'Install .NET SDK to enable building and analyzing C# projects.' : undefined,
      });
    }

    // Check Git status
    if (identity.hasGit) {
      items.push({
        category: 'Project',
        status: 'PASS',
        message: 'Git repository initialized.',
      });
    } else {
      items.push({
        category: 'Project',
        status: 'WARN',
        message: 'No git repository detected in workspace root. Version tracking & rollback unavailable.',
        suggestion: 'Consider running "git init" to track changes and revisions.',
      });
    }

    // Check .NET solution & project structure
    if (identity.isDotNet) {
      if (identity.solutionFiles.length === 0) {
        items.push({
          category: 'Project',
          status: 'WARN',
          message: `Found ${identity.projectFiles.length} .csproj files but no root .sln solution file.`,
          suggestion: 'Creating a solution (.sln) file simplifies project-wide MSBuild builds and reference resolution.',
        });
      } else {
        items.push({
          category: 'Project',
          status: 'PASS',
          message: `Detected solution file(s): ${identity.solutionFiles.join(', ')} with ${identity.projectFiles.length} project(s).`,
        });
      }
    }

    const overallHealthy = !items.some((i) => i.status === 'FAIL');

    return {
      workspaceName: identity.name,
      isDotNetProject: identity.isDotNet,
      diagnostics: items,
      overallHealthy,
    };
  }
}
