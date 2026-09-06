import { WinCodeConfig } from './Config.js';
import { CacheManager } from './Cache.js';
import { WorkspaceManager } from './Workspace.js';
import { ContextManager } from './Context.js';
import { RepomixAdapter } from '../Adapters/RepomixAdapter.js';
import { SerenaAdapter } from '../Adapters/SerenaAdapter.js';
import { ArchitectureAnalyzer } from '../CompositeTools/ArchitectureAnalyzer.js';
import { ImpactAnalyzer } from '../CompositeTools/ImpactAnalyzer.js';
import { RefactorAssistant } from '../CompositeTools/RefactorAssistant.js';
import { ProjectDiagnostics } from '../CompositeTools/ProjectDiagnostics.js';
import { ExtensionManager } from '../Extensions/ExtensionManager.js';

export class ToolRouter {
  readonly config: WinCodeConfig;
  readonly cache: CacheManager;
  readonly workspace: WorkspaceManager;
  readonly context: ContextManager;
  readonly repomix: RepomixAdapter;
  readonly serena: SerenaAdapter;
  readonly architecture: ArchitectureAnalyzer;
  readonly impact: ImpactAnalyzer;
  readonly refactor: RefactorAssistant;
  readonly diagnostics: ProjectDiagnostics;
  readonly extensions: ExtensionManager;

  constructor(config: WinCodeConfig) {
    this.config = config;
    this.cache = new CacheManager(config.cacheDir);
    this.workspace = new WorkspaceManager(config);
    this.repomix = new RepomixAdapter(config, this.cache);
    this.serena = new SerenaAdapter(config, this.cache);
    this.context = new ContextManager(config, this.repomix, this.serena);
    this.architecture = new ArchitectureAnalyzer(this.workspace, this.serena);
    this.impact = new ImpactAnalyzer(this.serena);
    this.refactor = new RefactorAssistant(this.workspace, this.serena, this.impact);
    this.diagnostics = new ProjectDiagnostics(this.workspace, this.config);
    this.extensions = new ExtensionManager(config);
  }

  async initialize(): Promise<void> {
    await this.cache.initialize();
    await this.repomix.initialize();
    await this.serena.initialize();
    await this.extensions.initializeAll();
  }

  async dispose(): Promise<void> {
    await this.repomix.dispose();
    await this.serena.dispose();
    await this.extensions.disposeAll();
  }
}
