import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { CodeQueryError } from '../Core/CodeQueries.js';
import { checkOperation, type OperationContext } from '../Core/OperationContext.js';
import { AbortError, ResourceManager, TimeoutError, killProcessTree, withTimeout } from '../Core/ResourceManager.js';
import { cleanupDesignTimeArtifacts } from './DesignTimeArtifacts.js';

/** 已通过帧边界和基础信封校验的内部响应；业务字段仍须由适配器逐项校验。 */
export type HostReply = Record<string, unknown> & { success: boolean; id?: string | null; errorCode?: string; error?: string };
interface Pending { resolve: (value: HostReply) => void; reject: (error: unknown) => void }

/**
 * 一个直接 Code Host 进程的 JSON 行通道。只管理本类 spawn 的进程，不接受外部 PID。
 * 取消先等待目标请求收尾，超过宽限才终止自有进程树；调用方在清理完成前不得释放请求占用。
 */
export class RoslynHostClient {
  readonly buildInstance = randomUUID().replaceAll('-', '');
  private readonly artifactRoot?: string;
  readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, Pending>();
  private readonly cancelIds = new Set<string>();
  private readonly exited: Promise<number | null>;
  private readonly ready: Promise<HostReply>;
  private closing = false;
  private ended = false;
  private closePromise?: Promise<void>;
  private failure?: Error;
  private buffer = '';
  private stderr = '';

  /** 调用方先验证路径/许可；参数始终通过 argv 传递，禁用 shell 和可见窗口。 */
  constructor(command: string, args: string[], cwd: string, resources: ResourceManager) {
    if (args[1] === '--allow-project-evaluation' && path.isAbsolute(args[2] ?? '')) this.artifactRoot = args[2];
    this.ready = new Promise((resolve, reject) => this.pending.set('@ready', { resolve, reject }));
    // 即使进程在调用 waitReady 前失败，也不会产生未处理的 Promise 拒绝。
    void this.ready.catch(() => {});
    this.child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false,
      // 只固定本子进程的 SDK 安装根；避免继承的 DOTNET_HOST_PATH 将 MSBuild 引向另一套 dotnet。
      env: { ...process.env, DOTNET_HOST_PATH: command, DOTNET_ROOT: path.dirname(command), WINCODE_OWNER_PID: String(process.pid),
        WINCODE_BUILD_INSTANCE: this.buildInstance },
      detached: process.platform !== 'win32' });
    resources.registerProcess('roslyn', this.child);
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (text: string) => this.read(text));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (text: string) => { this.stderr = (this.stderr + text).slice(-8192); });
    this.child.stdin.on('error', error => this.fail(new CodeQueryError('HOST_UNAVAILABLE', error.message)));
    this.child.on('error', error => this.fail(new CodeQueryError('HOST_UNAVAILABLE', error.message)));
    this.exited = new Promise(resolve => this.child.once('close', code => {
      this.ended = true;
      this.fail(new CodeQueryError('HOST_CRASHED', `Code Host exited (${code}); search again to restart. ${this.stderr}`));
      resolve(code);
    }));
  }

  /** 仅返回已知进程状态，不启动探测或执行项目。 */
  get active(): boolean { return !this.ended && !this.closing && !this.failure; }

  /** 进程/协议失败只结算一次；清理由等待该失败的操作或资源所有者完成。 */
  private fail(error: Error): void {
    this.failure ??= error;
    for (const item of this.pending.values()) item.reject(this.failure);
    this.pending.clear();
  }

  /** 输出最大 1 Mi UTF-16 字符/帧；未知 id、非法 JSON 或信封会使整个通道失效。 */
  private read(text: string): void {
    if (this.failure) return;
    this.buffer += text;
    try {
      while (true) {
        const newline = this.buffer.indexOf('\n');
        if ((newline < 0 ? this.buffer.length : newline) > 1048576) throw new Error('Host response frame exceeds 1 Mi characters.');
        if (newline < 0) return;
        const frame = JSON.parse(this.buffer.slice(0, newline));
        this.buffer = this.buffer.slice(newline + 1);
        if (!frame || typeof frame !== 'object' || typeof frame.success !== 'boolean') throw new Error('Invalid Host envelope.');
        if (typeof frame.id === 'string' && this.cancelIds.delete(frame.id)) continue;
        const key = frame.id === null && this.pending.has('@ready') ? '@ready' : frame.id;
        const item = this.pending.get(key);
        if (!item) throw new Error('Unexpected Host response id.');
        this.pending.delete(key);
        item.resolve(frame);
      }
    } catch (error) { this.fail(new CodeQueryError('HOST_PROTOCOL_ERROR', String(error))); }
  }

  /** 发送一帧并注册关联；同步写入失败也结算对应请求，不能留下悬空等待。 */
  private send(request: Record<string, unknown>): { id: string; result: Promise<HostReply> } {
    const id = randomUUID();
    const result = new Promise<HostReply>((resolve, reject) => {
      if (this.failure || this.ended) { reject(this.failure ?? new CodeQueryError('HOST_UNAVAILABLE', 'Host is closed.')); return; }
      this.pending.set(id, { resolve, reject });
      const frame = JSON.stringify({ ...request, id });
      if (frame.length > 65536) { this.pending.delete(id); reject(new CodeQueryError('INVALID_ARGUMENT', 'Host request exceeds frame budget.')); return; }
      try { this.child.stdin.write(frame + '\n'); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
    return { id, result };
  }

  /** 等待操作或取消/截止；所有计时器与 AbortSignal 监听在结算时释放。 */
  private async wait<T>(result: Promise<T>, budget: number, operation?: OperationContext): Promise<T> {
    checkOperation(operation);
    const duration = Math.max(1, Math.min(budget, operation?.deadline === undefined ? budget : operation.deadline - Date.now()));
    let abort: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(new AbortError());
      operation?.signal?.addEventListener('abort', abort, { once: true });
      if (operation?.signal?.aborted) abort();
    });
    try { return await withTimeout(Promise.race([result, cancelled]), duration, 'roslyn'); }
    finally { if (abort) operation?.signal?.removeEventListener('abort', abort); }
  }

  /** 初次加载前 Host 尚不读取 cancel；取消或超时直接回收自有进程，不自动重试启动。 */
  async waitReady(budget: number, operation?: OperationContext): Promise<HostReply> {
    try { return await this.wait(this.ready, budget, operation); }
    catch (error) { await this.close(true); throw error instanceof TimeoutError ? new CodeQueryError('HOST_TIMEOUT', error.message) : error; }
  }

  /** 请求失败不自动重放；取消后确认目标结束，超宽限则关闭整条连接并等待进程退出。 */
  async request(request: Record<string, unknown>, budget: number, operation?: OperationContext): Promise<HostReply> {
    checkOperation(operation);
    if (this.closing) throw new CodeQueryError('HOST_UNAVAILABLE', 'Code Host is closing.');
    const sent = this.send({ ...request, timeoutMs: Math.max(1, Math.min(budget, operation?.deadline === undefined ? budget : operation.deadline - Date.now())) });
    try { return await this.wait(sent.result, budget, operation); }
    catch (error) {
      if ((error instanceof AbortError || error instanceof TimeoutError) && this.active) {
        const id = randomUUID();
        this.cancelIds.add(id);
        this.child.stdin.write(JSON.stringify({ id, operation: 'cancel', targetId: sent.id }) + '\n');
        try { await withTimeout(sent.result, 1000, 'roslyn-cancel'); }
        catch { await this.close(true); }
      } else if (this.failure) await this.close(true);
      throw error instanceof TimeoutError ? new CodeQueryError('HOST_TIMEOUT', error.message) : error;
    }
  }

  /** 正常关闭先请求 shutdown；协议失败/硬截止直接回收，重复调用保留同一清理结果。 */
  close(force = false): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.closeWithArtifacts(force);
    return this.closePromise;
  }

  /** Recover this namespace only after actual process shutdown; preserve failures for the adapter. */
  private async closeWithArtifacts(force: boolean): Promise<void> {
    const failures: unknown[] = [];
    try { await this.closeOnce(force); } catch (error) { failures.push(error); }
    if (this.ended && this.artifactRoot) {
      try { await cleanupDesignTimeArtifacts(this.artifactRoot, this.buildInstance); } catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, 'Code Host or build output cleanup failed.');
  }

  /** 即使优雅关闭没有回复，也尝试终止；最终必须等到实际进程退出。 */
  private async closeOnce(force: boolean): Promise<void> {
    let cleanupFailure: unknown;
    if (!this.ended && !force && !this.failure) {
      try {
        const reply = await withTimeout(this.send({ operation: 'shutdown' }).result, 1000, 'roslyn-close');
        if (!reply.success) throw new Error('Host cleanup failed.');
        const code = await withTimeout(this.exited, 1000, 'roslyn-exit');
        if (code !== 0) throw new Error(`Host cleanup exited ${code}.`);
        return;
      } catch (error) {
        // 超时可由已验证的硬回收完成；明确的关闭/协议失败仍须向 E1 保留，不能仅因 PID 消失而隐藏。
        if (!(error instanceof TimeoutError)) cleanupFailure = error;
      }
    }
    if (!this.ended) await killProcessTree(this.child);
    await withTimeout(this.exited, 2500, 'roslyn-exit');
    if (cleanupFailure) throw cleanupFailure;
  }
}
