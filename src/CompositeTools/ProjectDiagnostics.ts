import { probeWorkspaceSdk, isSdkResolutionFailure, SdkPolicyError } from '../Core/WorkspaceSdk.js';
import { WorkspaceManager, ProjectIdentity } from '../Core/Workspace.js';
import { WinCodeConfig } from '../Core/Config.js';
import { AdapterHealthQuery } from '../Core/AdapterStatus.js';
import { checkOperation, type OperationContext } from '../Core/OperationContext.js';

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
  private queries?: AdapterHealthQuery;

  constructor(workspace: WorkspaceManager, config: WinCodeConfig, queries?: AdapterHealthQuery) {
    this.workspace = workspace;
    this.config = config;
    this.queries = queries;
  }

  async runDiagnostics(operation?: OperationContext): Promise<DiagnosticsReport> {
    checkOperation(operation);
    const identity: ProjectIdentity = await this.workspace.identifyProject(operation);
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

    // Check .NET SDK availability — presence is not semantic analysis capability
    try {
      checkOperation(operation);
      const executable = this.config.adapters.roslyn?.enabled ? this.config.adapters.roslyn.dotnetPath : 'dotnet';
      const version = await probeWorkspaceSdk(this.workspace.root, executable, this.config.timeouts?.dotnetMs ?? 5000, operation);
      items.push({
        category: 'Environment',
        status: 'PASS',
        message: `.NET SDK selected for this workspace (Version: ${version}).`,
      });
    } catch (error) {
      checkOperation(operation);
      const failure = error as { code?: number | string; syscall?: string; signal?: string };
      let message = `The workspace SDK probe failed (${failure.code ?? failure.signal ?? 'execution error'}).`;
      let suggestion: string | undefined;
      if (error instanceof SdkPolicyError) {
        message = error.message;
      } else if (failure.code === 'ENOENT' && failure.syscall?.startsWith('spawn')) {
        message = 'The dotnet executable could not be found.';
        suggestion = 'Check the configured dotnet path or install the .NET SDK on PATH.';
      } else if (isSdkResolutionFailure(failure.code)) {
        message = 'The dotnet host could not find a compatible .NET SDK for this workspace.';
        suggestion = 'Compare the workspace global.json settings with dotnet --list-sdks.';
      }
      const status = identity.isDotNet && !(error instanceof SdkPolicyError) ? 'FAIL' : 'WARN';
      items.push({ category: 'Environment', status, message, suggestion });
    }

    if (this.queries) {
      checkOperation(operation);
      const health = await this.queries.checkHealth();
      if (this.config.adapters.roslyn?.enabled) {
        items.push({ category: 'Dependencies', status: health.available ? 'PASS' : 'WARN',
          message: `Direct Roslyn: ${health.details ?? 'state unavailable'}. Query completeness must be checked separately.` });
      } else {
        items.push({ category: 'Dependencies', status: 'WARN',
          message: 'Local text search is available. Semantic analysis is not configured.',
          suggestion: 'Explicitly configure Roslyn with a C# project, framework and project evaluation permission.' });
      }
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
