import fs from 'node:fs/promises';
import path from 'node:path';
import { WINCODE_VERSION, type RoslynConfig, type WinCodeConfig } from '../Core/Config.js';
import { CodeQueryError, computeTypeMatchStats, type CodeSymbol, type ContextCodeQuery, type CodeReferenceQuery,
  type FindReferencesResult, type FindSymbolsResult, type SemanticContext, type SymbolLocation, type SymbolReference } from '../Core/CodeQueries.js';
import type { AdapterHealth, AdapterLastError } from '../Core/AdapterStatus.js';
import { checkOperation, type OperationContext } from '../Core/OperationContext.js';
import { GatewayRestartRequiredError, Mutex, ResourceManager, TimeoutError } from '../Core/ResourceManager.js';
import { RoslynHostClient, type HostReply } from './RoslynHostClient.js';

const kinds = new Set(['class', 'interface', 'method', 'function', 'property', 'enum', 'struct', 'type']);

/**
 * 显式启用的直接 C# 语义适配器；只保留一个当前根/配置的 Host，不缓存语义结果或自动回退上游。
 * 简单名称先返回候选；携带当前 location 的请求才能在不完整项目中确认具体符号。
 */
export class RoslynAdapter implements CodeReferenceQuery, ContextCodeQuery {
  private readonly options: Readonly<RoslynConfig>;
  private readonly lock = new Mutex();
  private client?: RoslynHostClient;
  private snapshot?: string;
  private reloadRequired = false;
  private restartRequired = false;
  private cleanupFailure?: GatewayRestartRequiredError;
  private disposed = false;
  private operations = 0;
  private health?: AdapterHealth;
  private observedAt: string | null = null;
  private lastError?: AdapterLastError;

  /** textDeclarations 只处理已提供正文，用于保留既有多语言文本能力，不调用任何 Serena 连接方法。 */
  constructor(private readonly config: WinCodeConfig, private readonly resources: ResourceManager,
    private readonly textDeclarations: (content: string, file: string) => CodeSymbol[]) {
    const options = config.adapters.roslyn;
    if (options?.enabled !== true || options.allowProjectEvaluation !== true) throw new CodeQueryError('PROJECT_EVALUATION_NOT_ALLOWED', 'Explicit Roslyn project evaluation permission is required.');
    if (![options.configuration, options.targetFramework].every(value => typeof value === 'string' && value.trim().length > 0 && value.length <= 128 &&
      !/[\\/:*?"<>|;$%@\u0000-\u001f]/.test(value) && !/[.\s]$/.test(value)))
      throw new CodeQueryError('INVALID_ARGUMENT', 'Configuration and TargetFramework must be literal directory names.');
    for (const value of [options.dotnetPath, options.hostPath])
      if (typeof value !== 'string' || !path.isAbsolute(value)) throw new CodeQueryError('INVALID_ARGUMENT', 'Roslyn executable and Host paths must be absolute.');
    for (const [value, maximum] of [[options.loadTimeoutMs, 120000], [options.queryTimeoutMs, 60000]] as const)
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > maximum)) throw new CodeQueryError('INVALID_ARGUMENT', 'Invalid Roslyn time budget.');
    const additionalInputs = options.additionalInputs === undefined ? [] : options.additionalInputs;
    if (!Array.isArray(additionalInputs) || additionalInputs.length > 32 || JSON.stringify(additionalInputs).length > 4096)
      throw new CodeQueryError('INVALID_ARGUMENT', 'additionalInputs must be an array of at most 32 files and 4096 JSON characters.');
    const inputIdentities = new Set<string>();
    for (const file of additionalInputs) {
      if (typeof file !== 'string' || /[*?:\0]/.test(file)) throw new CodeQueryError('INVALID_ARGUMENT', 'additionalInputs requires literal relative file paths.');
      const full = this.localPath(file);
      const identity = process.platform === 'win32' ? full.toLowerCase() : full;
      if (inputIdentities.has(identity)) throw new CodeQueryError('INVALID_ARGUMENT', 'Duplicate additional input.');
      inputIdentities.add(identity);
    }
    this.options = Object.freeze({ ...options, additionalInputs: Object.freeze([...additionalInputs]) });
    this.localPath(options.project);
    if (path.extname(options.project).toLowerCase() !== '.csproj') throw new CodeQueryError('INVALID_ARGUMENT', 'Roslyn entry must be a C# project.');
    resources.register('disposable', 'roslyn-adapter', () => this.dispose());
  }

  /** 由 Router 使用单独预算，包含一次启动/重载与当前查询；不沿用 Serena RPC 时间配置。 */
  get operationBudgetMs(): number { return (this.options.loadTimeoutMs ?? 120000) + (this.options.queryTimeoutMs ?? 30000); }

  /** 输入和响应路径都验证词法边界；Host 另检查重解析路径和实际文件读取。 */
  private localPath(file: string): string {
    if (typeof file !== 'string' || !file.trim() || file.length > 4096 || path.isAbsolute(file)) throw new CodeQueryError('OUTSIDE_WORKSPACE', 'Expected an in-workspace relative path.');
    const full = path.resolve(this.config.workspaceRoot, file);
    const relative = path.relative(this.config.workspaceRoot, full);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new CodeQueryError('OUTSIDE_WORKSPACE', 'Path escapes the active workspace.');
    return full;
  }

  /** 开始进程前验证普通文件及所有祖先，不允许通过链接把配置入口或运行程序替换到别处。 */
  private async regularFile(file: string): Promise<void> {
    try {
      if (!(await fs.stat(file)).isFile()) throw new CodeQueryError('HOST_UNAVAILABLE', 'Configured input is not a regular file.');
      for (let current = file; ; current = path.dirname(current)) {
        if ((await fs.lstat(current)).isSymbolicLink()) throw new CodeQueryError('UNSUPPORTED_LINK', 'Linked Roslyn paths are unsupported.');
        if (path.dirname(current) === current) break;
      }
    } catch (error) { throw error instanceof CodeQueryError ? error : new CodeQueryError('INPUT_UNAVAILABLE', String(error).slice(0, 2048)); }
  }

  /** 校验内部失败码并更新恢复状态，不从异常文案猜测恢复方式。 */
  private accept(reply: HostReply): HostReply {
    if (!reply.success) {
      if (reply.errorCode === 'HOST_RESTART_REQUIRED') this.restartRequired = true;
      if (['SNAPSHOT_STALE', 'INPUTS_CHANGED', 'PROJECT_LOAD_FAILED', 'INPUT_BUDGET_EXCEEDED', 'INPUT_UNAVAILABLE'].includes(reply.errorCode ?? '')) this.reloadRequired = true;
      const error = new CodeQueryError(reply.errorCode ?? 'HOST_PROTOCOL_ERROR', reply.error ?? 'Code Host request failed.');
      this.observe(false, error.message);
      throw error;
    }
    this.observe(true, 'Loaded C# snapshot; evidence completeness remains bounded.');
    return reply;
  }

  /** 只在显式搜索需要时按需启动；启动失败不自动重试，不执行 restore、安装或其他提供方。 */
  private async ready(operation?: OperationContext): Promise<RoslynHostClient> {
    checkOperation(operation);
    if (this.cleanupFailure) throw this.cleanupFailure;
    if (this.disposed) throw new CodeQueryError('HOST_UNAVAILABLE', 'Roslyn adapter is disposed.');
    if (this.restartRequired) throw new CodeQueryError('HOST_RESTART_REQUIRED', 'Reopen the workspace to restart Code Host.');
    if (this.client && !this.client.active) await this.stopClient();
    if (!this.client) {
      const project = this.localPath(this.options.project);
      await Promise.all([this.regularFile(project), this.regularFile(this.options.dotnetPath), this.regularFile(this.options.hostPath)]);
      checkOperation(operation);
      this.client = new RoslynHostClient(this.options.dotnetPath, [this.options.hostPath, '--allow-project-evaluation',
        this.config.workspaceRoot, project, this.options.configuration, this.options.targetFramework,
        JSON.stringify(this.options.additionalInputs)], this.config.workspaceRoot, this.resources);
      try {
        const reply = this.accept(await this.client.waitReady(this.options.loadTimeoutMs ?? 120000, operation));
        this.acceptReady(reply);
      } catch (error) { await this.stopClient(true); throw error; }
    } else if (this.reloadRequired) {
      this.snapshot = undefined;
      const reply = this.accept(await this.client.request({ operation: 'reload' }, this.options.loadTimeoutMs ?? 120000, operation));
      this.acceptReady(reply);
    }
    return this.client;
  }

  /** v2/根配置握手不符立即拒绝；Windows 接入必须具有自有进程树关闭保障。 */
  private acceptReady(reply: HostReply): void {
    if (reply.type !== 'ready' || reply.protocolVersion !== 2 || typeof reply.snapshot !== 'string' || !/^[a-f0-9]{32}$/.test(reply.snapshot) ||
        reply.configuration !== this.options.configuration || reply.framework !== this.options.targetFramework ||
        (process.platform === 'win32' && reply.processTreeGuard !== true))
      throw new CodeQueryError('HOST_PROTOCOL_ERROR', 'Code Host ready/configuration contract mismatch.');
    const identity = reply.hostIdentity as { version?: unknown; configuration?: unknown; protocolVersion?: unknown } | undefined;
    if (identity?.version !== WINCODE_VERSION || identity.configuration !== 'Release' || identity.protocolVersion !== 2) {
      throw new CodeQueryError('HOST_VERSION_MISMATCH', 'Code Host must match this Gateway version, Release configuration and protocol; rebuild the delivery.');
    }
    // 必须确认 Host 实际采用了补充输入；旧 Host 或漏传配置不能被当成成功加载。
    const policy = reply.inputPolicy as { version?: unknown; additionalInputs?: unknown } | undefined;
    if (policy?.version !== 2 || !Array.isArray(policy.additionalInputs) ||
        policy.additionalInputs.length !== this.options.additionalInputs!.length ||
        policy.additionalInputs.some((file, index) => typeof file !== 'string' ||
          path.relative(this.localPath(file), this.localPath(this.options.additionalInputs![index])) !== ''))
      throw new CodeQueryError('HOST_PROTOCOL_ERROR', 'Code Host input policy/configuration mismatch.');
    this.snapshot = reply.snapshot;
    this.reloadRequired = false;
  }

  /** 保留已知观察，不把 hello 当成主动加载或健康探针。 */
  private observe(available: boolean, details: string): void {
    this.observedAt = new Date().toISOString();
    this.health = { available, source: available ? 'installed' : 'unavailable', details, lastError: this.lastError };
  }

  /** 只按明确错误类型记录已发生的失败；保留最后失败，不从消息文字猜测超时或恢复动作。 */
  private recordError(error: unknown): void {
    const code = error instanceof CodeQueryError ? error.errorCode : undefined;
    const reason: AdapterLastError['reason'] = code === 'HOST_TIMEOUT' || error instanceof TimeoutError ? 'timeout' :
      code === 'HOST_CRASHED' ? 'crash' :
      code === 'CANCELLED' || (error instanceof Error && error.name === 'AbortError') ? 'cancelled' :
      code === 'HOST_UNAVAILABLE' || code === 'INPUT_UNAVAILABLE' ? 'unavailable' : 'error';
    this.lastError = { at: new Date().toISOString(), reason,
      message: (error instanceof Error ? error.message : String(error)).slice(0, 2048), recoverable: !this.cleanupFailure };
    this.observe(false, this.lastError.message);
  }

  /** 被动状态同时表明是否需要重载/重启，不以活进程替代语义完整性。 */
  getKnownHealth() {
    return { health: this.health, observedAt: this.observedAt, processAlive: Boolean(this.client?.active),
      snapshotId: this.snapshot ?? null, reloadRequired: this.reloadRequired, restartRequired: this.restartRequired,
      cleanupFailed: Boolean(this.cleanupFailure) };
  }

  /** 返回当前已知 Host 状态，无额外进程探测；该诊断不重新执行项目。 */
  async checkHealth(): Promise<AdapterHealth> {
    return { available: Boolean(this.client?.active && this.snapshot && !this.reloadRequired && !this.restartRequired && !this.cleanupFailure),
      source: this.client?.active ? 'installed' : 'unavailable', details: this.cleanupFailure ? 'Gateway restart required after cleanup failure.' :
        this.restartRequired ? 'Reopen workspace to restart Code Host.' : this.reloadRequired ? 'Search again to reload changed inputs.' : this.health?.details ?? 'Not loaded; an explicit symbol search loads the configured project.' };
  }

  /** 不完整性来自实际 Host 范围，不能把有精确位置的局部结果说成全局完备。 */
  private limitations(reply: HostReply): string[] {
    if (reply.queryComplete !== false || !Array.isArray(reply.compilationErrors) || !Array.isArray(reply.loadDiagnostics) || !Number.isSafeInteger(reply.excludedAnalyzers))
      throw new CodeQueryError('HOST_PROTOCOL_ERROR', 'Missing Host completeness evidence.');
    return ['范围仅为当前入口加载的 C# 项目及单配置快照；不覆盖动态调用或仓外调用。',
      `排除 ${reply.excludedAnalyzers} 个分析器/生成器引用，生成源码覆盖未证明。`,
      '输入校验覆盖声明的文件集合，不保证任意外部 targets 输入或全磁盘原子一致。',
      ...[...reply.loadDiagnostics, ...reply.compilationErrors].slice(0, 5).map(value => String(value).slice(0, 1024))];
  }

  /** 传递经校验的实际检查点，不把缺失的校验结果补写成 verified。 */
  private evidence(reply: HostReply): SemanticContext {
    const freshness = reply.freshness as SemanticContext['freshness'];
    if (reply.snapshot !== this.snapshot || reply.scope !== 'loaded-solution-snapshot' || reply.diskFreshnessVerified !== false ||
        !freshness || freshness.status !== 'checked' || freshness.externalCustomInputsVerified !== false ||
        typeof freshness.scope !== 'string' || typeof freshness.fingerprint !== 'string' || !/^[A-F0-9]{64}$/.test(freshness.fingerprint) ||
        !Number.isSafeInteger(freshness.files) || freshness.files < 0 || freshness.files > 5000 ||
        !Number.isSafeInteger(freshness.bytes) || freshness.bytes < 0 || freshness.bytes > 128 * 1024 * 1024)
      throw new CodeQueryError('HOST_PROTOCOL_ERROR', 'Invalid semantic checkpoint evidence.');
    return { snapshotId: this.snapshot!, scope: 'loaded-solution-snapshot', diskFreshnessVerified: false,
      excludedAnalyzers: reply.excludedAnalyzers as number, freshness };
  }

  /** 校验定位的坐标和范围；过期身份在启动或查询 Host 前拒绝。 */
  private validateLocation(location: SymbolLocation, current = true): void {
    if (!location || typeof location.snapshotId !== 'string' || !/^[a-f0-9]{32}$/.test(location.snapshotId) || !Number.isSafeInteger(location.position) || location.position < 0)
      throw new CodeQueryError('INVALID_ARGUMENT', 'Invalid symbolLocation.');
    this.localPath(location.project); this.localPath(location.file);
    if (current && (!this.client?.active || location.snapshotId !== this.snapshot || this.reloadRequired || this.restartRequired))
      throw new CodeQueryError('SNAPSHOT_STALE', 'Symbol location expired; search again or reopen the workspace when restart is required.');
  }

  /** 验证当前 Host 返回的声明列表，禁止跨根或没有身份的候选进入公共响应。 */
  private symbols(reply: HostReply): CodeSymbol[] {
    if (!Array.isArray(reply.symbols) || reply.symbols.length > 200) throw new CodeQueryError('HOST_PROTOCOL_ERROR', 'Invalid symbol list.');
    return reply.symbols.map((value: CodeSymbol) => {
      if (!value || typeof value.name !== 'string' || !kinds.has(value.kind) || !Number.isSafeInteger(value.line) || value.line < 1 || !value.location)
        throw new CodeQueryError('HOST_PROTOCOL_ERROR', 'Invalid symbol declaration.');
      this.validateLocation(value.location);
      if (path.relative(this.localPath(value.file), this.localPath(value.location.file))) throw new CodeQueryError('HOST_PROTOCOL_ERROR', 'Declaration path mismatch.');
      return value;
    });
  }

  /** 持有串行占用直到协议失败的进程清理结束；清理失败优先传播给 Router 的 E1 恢复门。 */
  private perform<T>(operation: OperationContext | undefined, work: () => Promise<T>): Promise<T> {
    this.operations++;
    return this.lock.runExclusive(async () => {
      try { return await work(); }
      catch (error) {
        this.recordError(error);
        if (this.cleanupFailure) throw this.cleanupFailure;
        if (this.client && (!this.client.active || (error instanceof CodeQueryError && error.errorCode === 'HOST_PROTOCOL_ERROR')))
          await this.stopClient(true);
        throw error;
      }
    }, operation?.signal, operation?.queue).finally(() => { this.operations--; });
  }

  /** 名称搜索不读语义缓存；过期时要求下一次显式搜索重载，不重放本次失败请求。 */
  async findSymbolsDetailed(query: string, kind?: string, relativePath?: string, operation?: OperationContext): Promise<FindSymbolsResult> {
    if (typeof query !== 'string' || !query.trim() || query.length > 256 || (kind !== undefined && (typeof kind !== 'string' || kind.length > 128)))
      throw new CodeQueryError('INVALID_ARGUMENT', 'Roslyn query must contain 1–256 characters; kind must be a string of at most 128 characters.');
    if (relativePath) this.localPath(relativePath);
    return this.perform(operation, async () => {
      const client = await this.ready(operation);
      const reply = this.accept(await client.request({ operation: 'symbols', snapshot: this.snapshot, query,
        ...(kind ? { kind } : {}), ...(relativePath ? { file: relativePath } : {}) }, this.options.queryTimeoutMs ?? 30000, operation));
      const symbols = this.symbols(reply);
      const limitations = this.limitations(reply);
      if (!Number.isSafeInteger(reply.totalFound) || (reply.totalFound as number) < symbols.length || typeof reply.truncated !== 'boolean')
        throw new CodeQueryError('HOST_PROTOCOL_ERROR', 'Invalid declaration coverage.');
      return { query, kindFilter: kind, symbols, totalFound: reply.totalFound as number, source: 'roslyn', analysisCompleteness: 'incomplete',
        queryComplete: false, truncated: reply.truncated, limitations, semanticContext: this.evidence(reply), ...computeTypeMatchStats(symbols, query) };
    });
  }

  /** 旧数组调用仍可用；其消费者必须另行保留详细结果中的证据边界。 */
  async findSymbols(query: string, kind?: string, operation?: OperationContext): Promise<CodeSymbol[]> {
    return (await this.findSymbolsDetailed(query, kind, undefined, operation)).symbols;
  }

  /** 已知文本片段沿用既有声明模式；该方法不扫描文件、不加载 Roslyn，也不调用 Serena。 */
  findSymbolsInContent(content: string, file: string): CodeSymbol[] { return this.textDeclarations(content, file); }

  /** 精确引用只能使用本次搜索得到的定位；简单名结果保留候选，绝不选择第一个重载。 */
  async findReferencesDetailed(symbolName: string, relativePath?: string, operation?: OperationContext, location?: SymbolLocation): Promise<FindReferencesResult> {
    if (relativePath) this.localPath(relativePath);
    if (symbolName.includes('/') || /\[\d+\]/.test(symbolName)) throw new CodeQueryError('LEGACY_SYMBOL_ID', 'Serena namePath cannot identify a Roslyn symbol; search again.');
    if (!location) {
      const found = await this.findSymbolsDetailed(symbolName, undefined, relativePath, operation);
      const candidates = found.symbols.filter(symbol => symbol.name === symbolName);
      return { symbolName, references: [], totalReferences: 0, source: 'roslyn', analysisCompleteness: 'incomplete', queryComplete: false,
        truncated: found.truncated, resolution: candidates.length > 1 ? 'ambiguous' : 'incomplete', candidates, candidateCount: found.truncated ? undefined : candidates.length,
        candidatesTruncated: found.truncated, semanticContext: found.semanticContext,
        limitations: [...found.limitations, '请从候选选择明确的 symbolLocation；未查询引用不能解释为零引用。'] };
    }
    this.validateLocation(location);
    if (relativePath && path.relative(this.localPath(relativePath), this.localPath(location.file))) throw new CodeQueryError('INVALID_ARGUMENT', 'relativePath and symbolLocation.file disagree.');
    return this.perform(operation, async () => {
      this.validateLocation(location);
      const reply = this.accept(await this.client!.request({ operation: 'references', snapshot: location.snapshotId, project: location.project,
        file: location.file, position: location.position, symbolName }, this.options.queryTimeoutMs ?? 30000, operation));
      if (!Array.isArray(reply.references) || reply.references.length > 1000 || typeof reply.truncated !== 'boolean' || !Number.isSafeInteger(reply.totalReferences))
        throw new CodeQueryError('HOST_PROTOCOL_ERROR', 'Invalid reference result.');
      const references: SymbolReference[] = reply.references.map((item: Record<string, unknown>) => {
        this.localPath(item.file as string); this.localPath(item.project as string);
        if (![item.line, item.column, item.length].every(value => Number.isSafeInteger(value) && (value as number) > 0) ||
            !Number.isSafeInteger(item.start) || (item.start as number) < 0 || typeof item.preview !== 'string') throw new CodeQueryError('HOST_PROTOCOL_ERROR', 'Invalid reference span.');
        return { ...item, symbolName, lineKind: 'reference' } as unknown as SymbolReference;
      });
      if ((reply.totalReferences as number) < references.length || reply.snapshot !== location.snapshotId) throw new CodeQueryError('HOST_PROTOCOL_ERROR', 'Reference snapshot/coverage mismatch.');
      return { symbolName, symbolLocation: location, references, totalReferences: reply.totalReferences as number, source: 'roslyn', analysisCompleteness: 'incomplete',
        queryComplete: false, truncated: reply.truncated, resolution: 'resolved', limitations: this.limitations(reply), semanticContext: this.evidence(reply) };
    });
  }

  /** 兼容已有内部数组接口；无定位时只返回已实际查询的引用，候选保留在详细接口。 */
  async findReferences(name: string, file?: string, operation?: OperationContext): Promise<SymbolReference[]> {
    return (await this.findReferencesDetailed(name, file, operation)).references;
  }

  /** 工作区切换或同根恢复先回收旧进程，失败永久保留并交给 E1 阻止业务请求。 */
  async resetConnection(): Promise<void> {
    await this.lock.runExclusive(async () => {
      if (this.cleanupFailure) throw this.cleanupFailure;
      await this.stopClient(); this.restartRequired = false; this.reloadRequired = false;
      this.health = undefined; this.observedAt = null;
      this.lastError = undefined;
    });
  }

  /** 手动释放复用当前生命周期锁；忙碌时不排队等待任务结束后突然释放。 */
  async releaseWarmState(canRelease: () => boolean = () => true): Promise<'released' | 'already-cold' | 'busy'> {
    if (this.operations || !canRelease()) return 'busy';
    return this.lock.runExclusive(async () => {
      if (this.operations || !canRelease()) return 'busy';
      if (this.cleanupFailure) throw this.cleanupFailure;
      if (this.disposed) throw new CodeQueryError('HOST_UNAVAILABLE', 'Roslyn adapter is disposed.');
      if (!this.client) return 'already-cold';
      await this.stopClient();
      // 保留故障/配置；不绕过已有 restartRequired，也不把最终 dispose 用作休眠。
      this.observe(false, 'Roslyn memory released manually; an explicit symbol search loads a new snapshot.');
      return 'released';
    });
  }

  /** 关闭后的失败不可通过清空引用隐藏；后续 dispose/reset 必须重抛同一恢复要求。 */
  private async stopClient(force = false): Promise<void> {
    this.snapshot = undefined;
    if (!this.client) return;
    try { await this.client.close(force); this.client = undefined; }
    catch (error) { this.cleanupFailure ??= new GatewayRestartRequiredError([error], 'Code Host cleanup failed; restart Gateway.'); this.recordError(this.cleanupFailure); throw this.cleanupFailure; }
  }

  /** 仅释放自有 Host；不处置复用的文本解析器、Gateway 或目标应用。 */
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.resetConnection();
  }
}
