import path from 'node:path';
import { WinCodeConfig, WINCODE_VERSION } from './Config.js';
import { CacheManager, CacheStats } from './Cache.js';
import { WorkspaceManager, WorkspaceOpenOptions } from './Workspace.js';
import { ContextManager } from './Context.js';
import { RepomixAdapter } from '../Adapters/RepomixAdapter.js';
import { SerenaAdapter } from '../Adapters/SerenaAdapter.js';
import { FlaUiAdapter } from '../Adapters/FlaUiAdapter.js';
import { UiInspectRequest, UiInspectResult } from './UiContracts.js';
import { reviewUi, UiReviewResult } from '../CompositeTools/UiReview.js';
import { ArchitectureAnalyzer } from '../CompositeTools/ArchitectureAnalyzer.js';
import { ImpactAnalyzer } from '../CompositeTools/ImpactAnalyzer.js';
import { RefactorAssistant } from '../CompositeTools/RefactorAssistant.js';
import { ProjectDiagnostics } from '../CompositeTools/ProjectDiagnostics.js';
import { ExtensionManager } from '../Extensions/ExtensionManager.js';
import { Mutex, ResourceManager, AbortError } from './ResourceManager.js';
import { SessionManager, WorkspaceSession } from './SessionManager.js';
import { WorkspaceWatch } from './WorkspaceWatch.js';
import { AdapterLastError } from '../Adapters/IAdapter.js';

export interface RuntimeHealth {
  version: string;
  status: 'online' | 'shutting_down';
  uptimeMs: number;
  startedAt: string;
  activeWorkspace: string | null;
  workspaceWatch: ReturnType<WorkspaceWatch['getStatus']>;
  session: WorkspaceSession | null;
  serena: {
    commandFound: boolean;
    handshakeOk: boolean;
    projectActive: boolean | null;
    semanticQueryUsable: boolean;
    mode: 'connected' | 'degraded';
    lastError?: AdapterLastError;
  };
  repomix: {
    available: boolean;
    source: string;
    details?: string;
    lastError?: AdapterLastError;
  };
  flaui: {
    runtime: ReturnType<FlaUiAdapter['getRuntimeStatus']>;
    available: boolean;
    source: string;
    details?: string;
    lastError?: AdapterLastError;
  };
  cache: CacheStats;
  managedChildProcesses: number;
  nodeMemory: NodeJS.MemoryUsage;
  inFlightRequests: number;
  lastAdapterError: AdapterLastError & { provider: string } | null;
}

export class ToolRouter {
  readonly config: WinCodeConfig;
  readonly cache: CacheManager;
  readonly workspace: WorkspaceManager;
  readonly resources: ResourceManager;
  readonly session: SessionManager;
  context: ContextManager;
  repomix: RepomixAdapter;
  serena: SerenaAdapter;
  flaui: FlaUiAdapter;
  architecture: ArchitectureAnalyzer;
  impact: ImpactAnalyzer;
  refactor: RefactorAssistant;
  diagnostics: ProjectDiagnostics;
  extensions: ExtensionManager;

  private readonly startedAt = Date.now();
  private shuttingDown = false;
  private inFlight = 0;
  private disposePromise: Promise<void> | null = null;
  private readonly workspaceLock = new Mutex();
  private switchingPromise: Promise<void> | null = null;
  private resolveSwitching: (() => void) | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private readonly watch = new WorkspaceWatch();
  private watchRegistered = false;

  constructor(config: WinCodeConfig) {
    this.config = config;
    this.resources = new ResourceManager();
    this.session = new SessionManager();
    this.cache = new CacheManager(
      config.cacheDir,
      config.cacheLimits?.maxMemoryEntries ?? 500,
      config.cacheLimits?.maxDiskEntries ?? 500,
      config.cacheLimits
    );
    this.workspace = new WorkspaceManager(config);
    this.repomix = new RepomixAdapter(config, this.cache, this.resources);
    this.serena = new SerenaAdapter(config, this.cache, this.resources);
    this.flaui = new FlaUiAdapter(config, this.resources);
    this.context = new ContextManager(config, this.workspace, this.repomix, this.serena);
    this.architecture = new ArchitectureAnalyzer(this.workspace, this.serena);
    this.impact = new ImpactAnalyzer(this.serena, this.config);
    this.refactor = new RefactorAssistant(this.workspace, this.serena, this.impact);
    this.diagnostics = new ProjectDiagnostics(this.workspace, this.config, this.serena);
    this.extensions = new ExtensionManager(config);
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  get inFlightRequests(): number {
    return this.inFlight;
  }

  get isSwitchingWorkspace(): boolean {
    return this.switchingPromise !== null;
  }

  async acquireRequestSlot(signal?: AbortSignal): Promise<void> {
    if (this.shuttingDown) throw new Error('WinCode is shutting down; tool call rejected.');
    if (signal?.aborted) throw new AbortError('The tool call was cancelled.');
    while (this.switchingPromise) {
      if (!signal) {
        await this.switchingPromise;
      } else {
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => reject(new AbortError('The tool call was cancelled.'));
          signal.addEventListener('abort', onAbort, { once: true });
          this.switchingPromise!.then(
            () => {
              signal.removeEventListener('abort', onAbort);
              resolve();
            },
            () => {
              signal.removeEventListener('abort', onAbort);
              resolve();
            }
          );
        });
      }
      if (signal?.aborted) throw new AbortError('The tool call was cancelled.');
    }
    if (this.shuttingDown) throw new Error('WinCode is shutting down; tool call rejected.');
    this.beginRequest();
  }

  beginRequest(): void {
    this.inFlight++;
    this.session.touch();
  }

  endRequest(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  async initialize(): Promise<void> {
    this.cache.setNamespace(this.config.workspaceRoot);
    this.session.open(this.config.workspaceRoot, this.cache.currentNamespace);
    await this.cache.initialize();
    await this.repomix.initialize();
    await this.serena.initialize();
    await this.flaui.initialize();
    await this.extensions.initializeAll();
    const fp = await this.cache.computeWorkspaceFingerprint(this.config.workspaceRoot);
    this.session.setFingerprint(fp);
    await this.bindWatch(this.config.workspaceRoot);

    if (!this.pruneTimer) {
      this.pruneTimer = setInterval(() => {
        this.cache.pruneExpiredMemory();
      }, 60_000);
      this.pruneTimer.unref();
      this.resources.registerTimer('cache', this.pruneTimer, 'interval');
    }
  }

  private async bindWatch(workspaceRoot: string): Promise<void> {
    await this.watch.stop();
    this.watch.start(workspaceRoot, () => {
      this.cache.noteFilesystemChange(workspaceRoot);
    });
    if (!this.watchRegistered) {
      this.resources.register('disposable', 'workspace-watch', () => this.watch.stop());
      this.watchRegistered = true;
    }
  }

  /**
   * Switch the active workspace. Serialized so two MCP calls cannot interleave
   * Serena dispose/connect and cache namespace changes.
   */
  async openWorkspace(targetPath: string, options: WorkspaceOpenOptions = {}) {
    return this.workspaceLock.runExclusive(async () => {
      if (this.shuttingDown) {
        throw new Error('WinCode is shutting down; workspace_open rejected.');
      }

      if (!this.switchingPromise) {
        this.switchingPromise = new Promise<void>((resolve) => {
          this.resolveSwitching = resolve;
        });
      }

      try {
        // Wait for existing in-flight queries on the old workspace to settle before re-binding
        const drainTimeout = this.config.timeouts?.shutdownMs ?? 8_000;
        const drained = await this.waitForIdle(drainTimeout);
        if (!drained) {
          throw new Error(
            `Workspace switch rejected: in-flight queries failed to drain within ${drainTimeout}ms (in-flight: ${this.inFlight}).`
          );
        }

        const resolved = path.resolve(targetPath);
        const previousRoot = this.config.workspaceRoot;
        const sameWorkspace =
          Boolean(previousRoot) && path.resolve(previousRoot) === resolved && Boolean(this.session.current);

        const fp = await this.cache.computeWorkspaceFingerprint(resolved, { fresh: true });
        const result = await this.workspace.openWorkspace(targetPath, options);

        if (sameWorkspace) {
          const previousFp = this.session.current?.fingerprint ?? null;
          this.session.touch();
          this.session.setFingerprint(fp);
          if (previousFp && previousFp !== fp) {
            this.cache.invalidateFingerprint(resolved);
            this.cache.setNamespace(this.config.workspaceRoot);
            this.serena.markProjectStale();
          }
          return result;
        }

        // Keep the process cache directory; isolate by namespace so we do not
        // write `.cache/wincode` into every opened repo, and so project A
        // symbols cannot be read as project B.
        this.cache.invalidateFingerprint(previousRoot);
        this.cache.setNamespace(this.config.workspaceRoot);
        this.session.open(this.config.workspaceRoot, this.cache.currentNamespace);
        this.session.setFingerprint(fp);
        await this.bindWatch(this.config.workspaceRoot);

        await this.repomix.dispose();
        await this.serena.resetConnection();
        await this.repomix.initialize();
        await this.serena.initialize();
        this.bindCompositeTools();
        return result;
      } finally {
        const resolve = this.resolveSwitching;
        this.switchingPromise = null;
        this.resolveSwitching = null;
        resolve?.();
      }
    });
  }

  private bindCompositeTools(): void {
    this.context = new ContextManager(this.config, this.workspace, this.repomix, this.serena);
    this.architecture = new ArchitectureAnalyzer(this.workspace, this.serena);
    this.impact = new ImpactAnalyzer(this.serena, this.config);
    this.refactor = new RefactorAssistant(this.workspace, this.serena, this.impact);
    this.diagnostics = new ProjectDiagnostics(this.workspace, this.config, this.serena);
  }

  async waitForIdle(timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (this.inFlight > 0) {
      if (Date.now() - start >= timeoutMs) {
        return false;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    return true;
  }

  async getRuntimeHealth(): Promise<RuntimeHealth> {
    const serenaHealth = await this.serena.checkHealth();
    const repomixHealth = await this.repomix.checkHealth();
    const flauiHealth = await this.flaui.checkHealth();
    const cache = await this.cache.getStats();
    const up = serenaHealth.upstream;
    const lastAdapterError = this.pickLastError(
      { error: serenaHealth.lastError, provider: 'serena' },
      { error: repomixHealth.lastError, provider: 'repomix' },
      { error: flauiHealth.lastError, provider: 'flaui' }
    );

    return {
      version: WINCODE_VERSION,
      status: this.shuttingDown ? 'shutting_down' : 'online',
      uptimeMs: Date.now() - this.startedAt,
      startedAt: new Date(this.startedAt).toISOString(),
      activeWorkspace: this.config.workspaceRoot,
      workspaceWatch: this.watch.getStatus(),
      session: this.session.current,
      serena: {
        commandFound: up?.commandFound ?? false,
        handshakeOk: up?.handshakeOk ?? false,
        projectActive: up?.projectActive ?? null,
        semanticQueryUsable: up?.semanticQueryUsable ?? false,
        mode: up?.mode ?? 'degraded',
        lastError: serenaHealth.lastError,
      },
      repomix: {
        available: repomixHealth.available,
        source: repomixHealth.source,
        details: repomixHealth.details,
        lastError: repomixHealth.lastError,
      },
      flaui: {
        runtime: this.flaui.getRuntimeStatus(),
        available: flauiHealth.available,
        source: flauiHealth.source,
        details: flauiHealth.details,
        lastError: flauiHealth.lastError,
      },
      cache,
      managedChildProcesses: this.resources.childProcessCount(),
      nodeMemory: process.memoryUsage(),
      inFlightRequests: this.inFlight,
      lastAdapterError,
    };
  }

  private pickLastError(
    ...entries: Array<{ error: AdapterLastError | undefined; provider: string }>
  ): (AdapterLastError & { provider: string }) | null {
    const items: Array<AdapterLastError & { provider: string }> = [];
    for (const entry of entries) {
      if (entry.error) {
        items.push({ ...entry.error, provider: entry.provider });
      }
    }
    if (items.length === 0) return null;
    items.sort((x, y) => (x.at < y.at ? 1 : -1));
    return items[0];
  }

  async inspectUi(request: UiInspectRequest, signal?: AbortSignal): Promise<UiInspectResult> {
    return this.flaui.inspect(request, signal);
  }

  async listUiWindows(request: import('./UiContracts.js').UiListWindowsRequest, signal?: AbortSignal): Promise<UiInspectResult> {
    return this.flaui.listWindows(request, signal);
  }

  async reviewUi(request: UiInspectRequest, candidateFiles: string[], signal?: AbortSignal, textQueries?: string[], candidateCodeFiles?: string[]): Promise<UiReviewResult> {
    // MCP owns the request slot across both stages, preventing workspace changes between them.
    return reviewUi((input, abort) => this.inspectUi(input, abort),
      this.config.workspaceRoot, request, candidateFiles, signal, textQueries, candidateCodeFiles);
  }

  async dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.shuttingDown = true;
    this.disposePromise = this.disposeOnce();
    // Retain the settled result: repeated callers must not see success after failed cleanup.
    return this.disposePromise;
  }

  private async disposeOnce(): Promise<void> {
    this.shuttingDown = true;
    // Let any active switch finish before disposing the resources it binds.
    return this.workspaceLock.runExclusive(async () => {
      const drainMs = Math.min(3_000, this.config.timeouts?.shutdownMs ?? 8_000);
      await this.waitForIdle(drainMs);
      if (this.pruneTimer) {
        clearInterval(this.pruneTimer);
        this.pruneTimer = null;
      }
      const failures: unknown[] = [];
      // Every owner gets a cleanup attempt even if a previous adapter failed.
      // Keep ordering: adapters stop producing work before queued cache writes drain.
      for (const cleanup of [
        () => this.watch.stop(),
        () => this.repomix.dispose(),
        () => this.serena.dispose(),
        () => this.flaui.dispose(),
        () => this.extensions.disposeAll(),
        () => this.cache.flush(),
        () => this.session.close(),
        () => this.resources.dispose(),
      ]) {
        try { await cleanup(); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, 'One or more gateway resources failed to close.');
    });
  }
}
