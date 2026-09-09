import path from 'node:path';
import { WinCodeConfig, WINCODE_VERSION } from './Config.js';
import { CacheManager, CacheStats } from './Cache.js';
import { WorkspaceManager, WorkspaceOpenOptions, WorkspaceDirectoryOptions } from './Workspace.js';
import { ContextManager, PreparedContextOptions } from './Context.js';
import { RepomixAdapter } from '../Adapters/RepomixAdapter.js';
import { LocalTextAdapter } from '../Adapters/LocalTextAdapter.js';
import { RoslynAdapter } from '../Adapters/RoslynAdapter.js';
import { CodeQueryError, type SymbolLocation } from './CodeQueries.js';
import { FlaUiAdapter } from '../Adapters/FlaUiAdapter.js';
import { UiInspectRequest, UiInspectResult } from './UiContracts.js';
import { reviewUi, UiReviewResult } from '../CompositeTools/UiReview.js';
import { ArchitectureAnalyzer } from '../CompositeTools/ArchitectureAnalyzer.js';
import { ImpactAnalyzer } from '../CompositeTools/ImpactAnalyzer.js';
import { RefactorAssistant } from '../CompositeTools/RefactorAssistant.js';
import { ProjectDiagnostics } from '../CompositeTools/ProjectDiagnostics.js';
import { ExtensionManager } from '../Extensions/ExtensionManager.js';
import { Mutex, ResourceManager, AbortError, TimeoutError, GatewayRestartRequiredError, withTimeout } from './ResourceManager.js';
import { SessionManager, WorkspaceSession } from './SessionManager.js';
import { WorkspaceWatch } from './WorkspaceWatch.js';
import { AdapterLastError } from './AdapterStatus.js';
import { type OperationContext, checkOperation } from './OperationContext.js';

export interface WorkspaceRecovery {
  activeWorkspace: string;
  attemptedWorkspace: string;
  phase: string;
  message: string;
  recoveryAction: 'workspace_open' | 'restart_gateway';
}

export class WorkspaceRecoveryRequiredError extends Error {
  constructor(readonly recovery: WorkspaceRecovery) {
    super(recovery.recoveryAction === 'restart_gateway'
      ? 'Workspace cleanup could not be confirmed. Check Gateway-owned resource cleanup and restart the Gateway; workspace_open cannot recover this instance.'
      : 'Workspace consistency is unconfirmed. Call workspace_open to complete recovery.');
    this.name = 'WorkspaceRecoveryRequiredError';
  }
}

export interface RuntimeHealth {
  codeProvider: 'local-text' | 'roslyn';
  roslyn?: ReturnType<RoslynAdapter['getKnownHealth']>;
  resourceCleanup: ReturnType<ResourceManager['getCloseReport']>;
  version: string;
  status: 'online' | 'shutting_down' | 'recovery_required';
  workspaceRecovery: WorkspaceRecovery | null;
  uptimeMs: number;
  startedAt: string;
  activeWorkspace: string | null;
  workspaceWatch: ReturnType<WorkspaceWatch['getStatus']>;
  session: WorkspaceSession | null;
  text: { available: boolean; semanticConfigured: false; details: string };
  repomix: {
    available: boolean | null;
    source: string;
    details?: string;
    lastError?: AdapterLastError;
  };
  flaui: {
    runtime: ReturnType<FlaUiAdapter['getRuntimeStatus']>;
    available: boolean | null;
    source: string;
    details?: string;
    lastError?: AdapterLastError;
  };
  cache: CacheStats;
  managedChildProcesses: number;
  nodeMemory: NodeJS.MemoryUsage;
  inFlightRequests: number;
  lastAdapterError: AdapterLastError & { provider: string } | null;
  healthObservation: Record<'text' | 'repomix' | 'flaui', { state: 'known' | 'unknown'; observedAt: string | null }>;
}

export class ToolRouter {
  readonly config: WinCodeConfig;
  readonly cache: CacheManager;
  readonly workspace: WorkspaceManager;
  readonly resources: ResourceManager;
  readonly session: SessionManager;
  context: ContextManager;
  repomix: RepomixAdapter;
  text: LocalTextAdapter;
  roslyn?: RoslynAdapter;
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
  private initialization: Promise<void> | null = null;
  private readonly shutdownController = new AbortController();
  private readonly workspaceLock = new Mutex();
  private switchingPromise: Promise<void> | null = null;
  private resolveSwitching: (() => void) | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private readonly watch = new WorkspaceWatch();
  private watchRegistered = false;
  private workspaceRecovery: WorkspaceRecovery | null = null;
  private readonly codeOperations = new Set<AbortController>();

  private async runCode<T>(signal: AbortSignal | undefined, work: (operation: OperationContext) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const budget = (this.roslyn?.operationBudgetMs ?? 0) + this.config.timeouts.fileScanMs;
    const operation = { signal: controller.signal, deadline: Date.now() + budget };
    const timer = setTimeout(() => controller.abort(new TimeoutError('operation', budget)), budget);
    this.codeOperations.add(controller);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted || this.shuttingDown) cancel();
    try { checkOperation(operation); const result = await work(operation); checkOperation(operation); return result; }
    catch (error) {
      // 查询清理失败同样会留下不可信的自有 Host 状态；按 E1 阻止后续业务，不能只返回一次错误。
      if (this.roslyn && error instanceof GatewayRestartRequiredError) {
        this.workspaceRecovery = { activeWorkspace: this.config.workspaceRoot, attemptedWorkspace: this.config.workspaceRoot,
          phase: 'roslyn-cleanup', message: error.message.slice(0, 1024), recoveryAction: 'restart_gateway' };
        throw new WorkspaceRecoveryRequiredError({ ...this.workspaceRecovery });
      }
      throw error;
    }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); this.codeOperations.delete(controller); }
  }

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
    this.text = new LocalTextAdapter(config, this.cache);
    if (config.adapters.roslyn?.enabled)
      this.roslyn = new RoslynAdapter(config, this.resources, (content, file) => this.text.findSymbolsInContent(content, file));
    this.flaui = new FlaUiAdapter(config, this.resources);
    this.context = new ContextManager(config, this.workspace, this.repomix, this.code);
    this.architecture = new ArchitectureAnalyzer(this.workspace);
    this.impact = new ImpactAnalyzer(this.code, this.config);
    this.refactor = new RefactorAssistant(this.workspace, this.impact);
    this.diagnostics = new ProjectDiagnostics(this.workspace, this.config, this.code);
    this.extensions = new ExtensionManager(config);
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  get shutdownSignal(): AbortSignal { return this.shutdownController.signal; }

  private assertActive(): void {
    if (this.shuttingDown) throw new AbortError('WinCode is shutting down; operation cancelled.');
  }

  /** 提供方在构造时显式选择；Roslyn 失败不触发 Serena RPC。 */
  private get code(): LocalTextAdapter | RoslynAdapter { return this.roslyn ?? this.text; }

  get inFlightRequests(): number {
    return this.inFlight;
  }

  get isSwitchingWorkspace(): boolean {
    return this.switchingPromise !== null;
  }

  get workspaceRecoveryState(): WorkspaceRecovery | null {
    return this.workspaceRecovery ? { ...this.workspaceRecovery } : null;
  }

  findCodeSymbols(query: string, kind?: string, signal?: AbortSignal) {
    return this.runCode(signal, operation => this.code.findSymbolsDetailed(query, kind, undefined, operation));
  }

  /** 精确位置只属于 Roslyn；旧提供方收到该字段必须明确拒绝，不能忽略后再猜符号。 */
  findCodeReferences(symbolName: string, relativePath?: string, signal?: AbortSignal, location?: SymbolLocation) {
    if (location && !this.roslyn) throw new CodeQueryError('UNSUPPORTED_SYMBOL_LOCATION', 'Semantic analysis is not configured; local text search cannot accept a Roslyn symbolLocation.');
    return this.runCode(signal, operation => this.roslyn ? this.roslyn.findReferencesDetailed(symbolName, relativePath, operation, location) :
      this.text.findReferencesDetailed(symbolName, relativePath, operation));
  }

  prepareContext(options: PreparedContextOptions, signal?: AbortSignal) {
    return this.runCode(signal, operation => this.context.prepareContext(options, operation));
  }

  analyzeWorkspace(maxDepth?: number) {
    return this.architecture.analyze(maxDepth);
  }

  analyzeChangeImpact(target: string, signal?: AbortSignal, location?: SymbolLocation) {
    if (location && !this.roslyn) throw new CodeQueryError('UNSUPPORTED_SYMBOL_LOCATION', 'Exact locations require configured Roslyn.');
    return this.runCode(signal, operation => this.impact.analyzeImpact(target, operation, location));
  }

  async diagnoseProject() {
    const diagnostics = await this.diagnostics.runDiagnostics();
    await this.repomix.checkHealth(this.config.timeouts.repomixHealthMs);
    await this.flaui.checkHealth(this.config.timeouts.healthProbeMs);
    const runtime = await this.getRuntimeHealth();
    return { ...diagnostics, runtime };
  }

  planRefactoring(target: string, goal: string, signal?: AbortSignal, location?: SymbolLocation) {
    if (location && !this.roslyn) throw new CodeQueryError('UNSUPPORTED_SYMBOL_LOCATION', 'Exact locations require configured Roslyn.');
    return this.runCode(signal, operation => this.refactor.planRefactoring(target, goal, operation, location));
  }

  moveToTrash(filePath: string, reason?: string) {
    return this.workspace.moveToTrash(filePath, reason);
  }

  listDirectory(options: WorkspaceDirectoryOptions = {}) {
    return this.workspace.listDirectory(options);
  }

  async acquireRequestSlot(signal?: AbortSignal, allowDuringRecovery = false): Promise<void> {
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
    if (this.workspaceRecovery && !allowDuringRecovery) throw new WorkspaceRecoveryRequiredError({ ...this.workspaceRecovery });
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
    try {
      this.assertActive();
      this.initialization ??= this.initializeOnce();
      await this.initialization;
    }
    catch (error) {
      try { await this.dispose(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'Initialization and cleanup failed.'); }
      throw error;
    }
  }

  private async initializeOnce(): Promise<void> {
    this.cache.setNamespace(this.config.workspaceRoot);
    this.session.open(this.config.workspaceRoot, this.cache.currentNamespace);
    for (const initialize of [() => this.cache.initialize(), () => this.repomix.initialize(),
      () => this.roslyn ? Promise.resolve() : this.text.initialize(), () => this.flaui.initialize(),
      () => this.extensions.initializeAll()]) {
      this.assertActive();
      await initialize();
      this.assertActive();
    }
    const fp = await this.cache.computeWorkspaceFingerprint(this.config.workspaceRoot);
    this.assertActive();
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
    try { await this.watch.stop(); }
    catch (error) { throw new GatewayRestartRequiredError([error], 'Workspace watcher cleanup failed; restart the Gateway after checking cleanup.'); }
    this.assertActive();
    this.watch.start(workspaceRoot, () => {
      this.cache.noteFilesystemChange(workspaceRoot);
    });
    this.assertWatchBound(workspaceRoot);
    if (!this.watchRegistered) {
      this.resources.register('disposable', 'workspace-watch', () => this.watch.stop());
      this.watchRegistered = true;
    }
  }

  private assertWatchBound(workspaceRoot: string): void {
    const status = this.watch.getStatus();
    if (!status.active || status.root !== path.resolve(workspaceRoot))
      throw new Error(`Workspace watcher binding failed: ${status.lastError?.message ?? 'no active watcher for the requested workspace'}`);
  }

  /**
   * Switch the active workspace. Serialized so two MCP calls cannot interleave
   * provider cleanup/reinitialization and cache namespace changes.
   */
  async openWorkspace(targetPath: string, options: WorkspaceOpenOptions = {}, signal?: AbortSignal) {
    signal = signal ? AbortSignal.any([signal, this.shutdownSignal]) : this.shutdownSignal;
    return this.workspaceLock.runExclusive(async () => {
      if (this.shuttingDown) {
        throw new Error('WinCode is shutting down; workspace_open rejected.');
      }
      if (this.workspaceRecovery?.recoveryAction === 'restart_gateway')
        throw new WorkspaceRecoveryRequiredError({ ...this.workspaceRecovery });

      if (!this.switchingPromise) {
        this.switchingPromise = new Promise<void>((resolve) => {
          this.resolveSwitching = resolve;
        });
      }

      const previousRoot = this.config.workspaceRoot;
      let rootPrepared = false;
      let phase = 'drain';
      try {
        // Wait for existing in-flight queries on the old workspace to settle before re-binding
        const drainTimeout = this.config.timeouts?.shutdownMs ?? 8_000;
        const drained = await this.waitForIdle(drainTimeout, signal);
        if (!drained) {
          throw new Error(
            `Workspace switch rejected: in-flight queries failed to drain within ${drainTimeout}ms (in-flight: ${this.inFlight}).`
          );
        }

        const resolved = path.resolve(targetPath);
        const sameWorkspace =
          !this.workspaceRecovery && this.watch.getStatus().active && Boolean(previousRoot) && path.resolve(previousRoot) === resolved && Boolean(this.session.current);

        phase = 'fingerprint';
        const fp = await this.cache.computeWorkspaceFingerprint(resolved, { fresh: true });
        checkOperation({ signal });
        phase = 'workspace';
        const result = await this.workspace.openWorkspace(targetPath, options);
        rootPrepared = true;
        checkOperation({ signal });

        if (sameWorkspace) {
          phase = 'refresh';
          // 同根 workspace_open 是显式恢复入口；停止旧 Host 后由下一次搜索按新 SDK/输入加载。
          if (this.roslyn) { phase = 'roslyn-reset'; await this.roslyn.resetConnection(); }
          const previousFp = this.session.current?.fingerprint ?? null;
          this.session.touch();
          this.session.setFingerprint(fp);
          if (previousFp && previousFp !== fp) {
            this.cache.invalidateFingerprint(resolved);
            this.cache.setNamespace(this.config.workspaceRoot);
          }
          return result;
        }

        // Keep the process cache directory; isolate by namespace so we do not
        // write `.cache/wincode` into every opened repo, and so project A
        // symbols cannot be read as project B.
        phase = 'cache';
        this.cache.invalidateFingerprint(previousRoot);
        this.cache.setNamespace(this.config.workspaceRoot);
        phase = 'session';
        this.session.open(this.config.workspaceRoot, this.cache.currentNamespace);
        this.session.setFingerprint(fp);
        phase = 'watch';
        await this.bindWatch(this.config.workspaceRoot);
        checkOperation({ signal });

        phase = 'repomix-dispose';
        await this.repomix.dispose();
        checkOperation({ signal });
        if (this.roslyn) {
          phase = 'roslyn-reset';
          await this.roslyn.resetConnection();
        }
        checkOperation({ signal });
        phase = 'repomix-initialize';
        await this.repomix.initialize();
        checkOperation({ signal });
        phase = 'text-initialize';
        if (!this.roslyn) await this.text.initialize();
        checkOperation({ signal });
        phase = 'composites';
        this.bindCompositeTools();
        checkOperation({ signal });
        phase = 'watch-confirmation';
        this.assertWatchBound(this.config.workspaceRoot);
        // Publish readiness only after every participant has completed rebinding.
        this.workspaceRecovery = null;
        return result;
      } catch (error) {
        if (rootPrepared || this.config.workspaceRoot !== previousRoot || this.workspaceRecovery) {
          this.workspaceRecovery = {
            activeWorkspace: this.config.workspaceRoot, attemptedWorkspace: path.resolve(targetPath),
            phase, message: (error instanceof Error ? error.message : String(error)).slice(0, 1024),
            recoveryAction: error instanceof GatewayRestartRequiredError ? 'restart_gateway' : 'workspace_open',
          };
          if (!signal?.aborted && !(error instanceof AbortError))
            throw new WorkspaceRecoveryRequiredError({ ...this.workspaceRecovery });
        }
        throw error;
      } finally {
        const resolve = this.resolveSwitching;
        this.switchingPromise = null;
        this.resolveSwitching = null;
        resolve?.();
      }
    }, signal);
  }

  private bindCompositeTools(): void {
    this.context = new ContextManager(this.config, this.workspace, this.repomix, this.code);
    this.architecture = new ArchitectureAnalyzer(this.workspace);
    this.impact = new ImpactAnalyzer(this.code, this.config);
    this.refactor = new RefactorAssistant(this.workspace, this.impact);
    this.diagnostics = new ProjectDiagnostics(this.workspace, this.config, this.code);
  }

  async waitForIdle(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    const start = Date.now();
    while (this.inFlight > 0) {
      checkOperation({ signal });
      if (Date.now() - start >= timeoutMs) {
        return false;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    return true;
  }

  async getRuntimeHealth(): Promise<RuntimeHealth> {
    const snapshots = { text: this.text.getKnownHealth(), repomix: this.repomix.getKnownHealth(), flaui: this.flaui.getKnownHealth() };
    const unknown = { available: null, source: 'unknown', details: 'Not probed; use wincode_diagnose_project for an active check.', lastError: undefined };
    const textHealth = snapshots.text.health;
    const repomixHealth = snapshots.repomix.health ?? unknown;
    const flauiHealth = snapshots.flaui.health ?? unknown;
    const cache = await this.cache.getStats();
    const lastAdapterError = this.pickLastError(
      { error: repomixHealth.lastError, provider: 'repomix' },
      { error: flauiHealth.lastError, provider: 'flaui' },
      { error: this.roslyn?.getKnownHealth().health?.lastError, provider: 'roslyn' }
    );

    return {
      version: WINCODE_VERSION,
      codeProvider: this.roslyn ? 'roslyn' : 'local-text',
      ...(this.roslyn ? { roslyn: this.roslyn.getKnownHealth() } : {}),
      status: this.shuttingDown ? 'shutting_down' : this.workspaceRecovery ? 'recovery_required' : 'online',
      workspaceRecovery: this.workspaceRecovery ? { ...this.workspaceRecovery } : null,
      uptimeMs: Date.now() - this.startedAt,
      startedAt: new Date(this.startedAt).toISOString(),
      activeWorkspace: this.config.workspaceRoot,
      workspaceWatch: this.watch.getStatus(),
      session: this.session.current,
      text: { available: true, semanticConfigured: false, details: textHealth.details! },
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
      healthObservation: Object.fromEntries(Object.entries(snapshots).map(([name, snapshot]) =>
        [name, { state: snapshot.health ? 'known' : 'unknown', observedAt: snapshot.observedAt }])) as RuntimeHealth['healthObservation'],
      resourceCleanup: this.resources.getCloseReport(),
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
    this.shutdownController.abort();
    this.resources.seal();
    for (const controller of this.codeOperations) controller.abort();
    this.disposePromise = this.disposeOnce();
    // Retain the settled result: repeated callers must not see success after failed cleanup.
    return this.disposePromise;
  }

  private async disposeOnce(): Promise<void> {
    this.shuttingDown = true;
    const budget = this.config.timeouts?.shutdownMs ?? 8_000;
    const deadline = Date.now() + budget;
    const softDeadline = deadline - Math.min(2_000, budget / 4);
    const failures: unknown[] = [];
    const attempt = async (name: string, work: () => Promise<unknown> | void, limit: number) => {
      try { await withTimeout(Promise.resolve().then(work), Math.max(1, limit), name); }
      catch (error) { failures.push(error); }
    };
    // A stuck initializer/switch cannot monopolize the process-wide exit deadline.
    await attempt('shutdown-drain', async () => {
      await this.initialization?.catch(() => {});
      await this.switchingPromise?.catch(() => {});
      const drained = await this.waitForIdle(Math.max(1, Math.min(3_000, softDeadline - Date.now())));
      if (!drained) throw new Error('Requests did not settle before shutdown.');
    }, Math.min(3_000, (softDeadline - Date.now()) / 3));
    const drained = failures.length === 0;
      if (this.pruneTimer) {
        clearInterval(this.pruneTimer);
        this.pruneTimer = null;
      }
      // Every owner gets a cleanup attempt even if a previous adapter failed.
      // Keep ordering: adapters stop producing work before queued cache writes drain.
      const cleanups = [
        () => this.watch.stop(),
        () => this.repomix.dispose(),
        () => this.text.dispose(),
        () => this.roslyn?.dispose(),
        () => this.flaui.dispose(),
        () => this.extensions.disposeAll(),
        // Never race a cache flush against an initializer or request that failed to drain.
        () => drained ? this.cache.flush() : Promise.resolve(),
        () => this.session.close(),
      ];
      for (const [index, cleanup] of cleanups.entries()) {
        await attempt(`shutdown-owner-${index}`, cleanup, (softDeadline - Date.now()) / (cleanups.length - index));
      }
      // Independent ownership cleanup still runs when an adapter has hung or thrown.
      await attempt('shutdown-owned-resources', () => this.resources.dispose(deadline), deadline - Date.now());
      if (failures.length) throw new AggregateError(failures, 'One or more gateway resources failed to close.');
  }
}
