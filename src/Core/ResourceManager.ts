import { ChildProcess, execFile } from 'node:child_process';

export type ResourceKind = 'process' | 'timer' | 'interval' | 'disposable' | 'tempfile';

export interface ManagedResourceInfo {
  id: string;
  kind: ResourceKind;
  owner: string;
}

interface ManagedResource extends ManagedResourceInfo {
  dispose: () => Promise<void> | void;
}

export class TimeoutError extends Error {
  readonly reason = 'timeout' as const;
  readonly recoverable = true;

  constructor(
    readonly provider: string,
    readonly timeoutMs: number
  ) {
    super(`${provider} timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

export interface ExternalOpFailure {
  status: 'failed';
  reason: 'timeout' | 'crash' | 'unavailable' | 'cancelled' | 'error';
  provider: string;
  recoverable: boolean;
  message: string;
}

export function toExternalOpFailure(
  err: unknown,
  provider: string,
  recoverable = true
): ExternalOpFailure {
  if (err instanceof TimeoutError) {
    return {
      status: 'failed',
      reason: 'timeout',
      provider: err.provider || provider,
      recoverable: true,
      message: err.message,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    status: 'failed',
    reason: 'error',
    provider,
    recoverable,
    message,
  };
}

/**
 * Bounded wait. Always clear the timer so shutdown does not leak handles.
 * Optional AbortController is aborted when the timeout fires so the callee can stop.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  provider: string,
  abort?: AbortController
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          try {
            abort?.abort();
          } catch {
            // ignore
          }
          reject(new TimeoutError(provider, timeoutMs));
        }, timeoutMs);
        // An awaited deadline must fire even when it is the last active handle.
        // The finally block releases it immediately when the operation settles.
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class AbortError extends Error {
  readonly code = 'ABORT_ERR';
  constructor(message = 'The operation was aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

/** A retained cleanup failure cannot be recovered by reusing the same runtime. */
export class GatewayRestartRequiredError extends AggregateError {
  constructor(errors: unknown[], message: string) {
    super(errors, message);
    this.name = 'GatewayRestartRequiredError';
  }
}

/**
 * Serializes a critical section. Callers queue; there is no OS thread pool.
 * Cancels queue waiting. Once fn starts, it owns cooperative cancellation and cleanup;
 * releasing this lock on abort before fn settles would permit concurrent owners.
 */
export interface QueueObserver { wait(): () => void }

export class Mutex {
  private running = false;
  private readonly waiting = new Set<() => void>();

  get pendingCount(): number { return this.waiting.size; }

  runExclusive<T>(fn: () => Promise<T>, signal?: AbortSignal, observer?: QueueObserver): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(
        new AbortError(signal.reason ? String(signal.reason) : 'The operation was aborted')
      );
    }

    return new Promise<T>((resolve, reject) => {
      const resume = this.running ? observer?.wait() : undefined;
      const cancelled = () => {
        // Set insertion order is FIFO; removal releases the closure immediately.
        if (!this.waiting.delete(execute)) return;
        resume?.();
        signal?.removeEventListener('abort', cancelled);
        reject(new AbortError(signal?.reason ? String(signal.reason) : 'The operation was aborted'));
      };
      const execute = () => {
        this.waiting.delete(execute);
        resume?.();
        signal?.removeEventListener('abort', cancelled);
        this.running = true;
        // Keep asynchronous entry and recheck cancellation before invoking work.
        void Promise.resolve().then(() => {
          if (signal?.aborted) throw new AbortError(signal.reason ? String(signal.reason) : 'The operation was aborted');
          return fn();
        }).then(resolve, reject).finally(() => {
          // An active caller owns the lock until its work AND cleanup settle.
          const next = this.waiting.values().next().value;
          if (next) next();
          else this.running = false;
        });
      };
      this.waiting.add(execute);
      signal?.addEventListener('abort', cancelled, { once: true });
      if (!this.running) execute();
    });
  }
}

function taskkillTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 2000 }, () => resolve());
  });
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}

type OwnedProcess = ChildProcess | {
  pid?: number | null;
  kill?: (sig?: NodeJS.Signals) => boolean;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
};

function hasExited(proc: OwnedProcess): boolean {
  return proc.exitCode != null || proc.signalCode != null;
}

async function waitForProcessExit(proc: OwnedProcess, pid: number): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!hasExited(proc) && processExists(pid)) {
    if (Date.now() >= deadline) throw new Error(`Owned process ${pid} did not exit after termination.`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

/**
 * Kill a child and its descendants.
 * On Windows, `taskkill /T` MUST run while the parent is still alive.
 * Signaling the wrapper first (cmd.exe / npx) orphans grandchildren
 * (Codex #34614, MCP typescript-sdk #2023, python-sdk #850).
 */
export async function killProcessTree(
  proc: OwnedProcess
): Promise<void> {
  // A ChildProcess retains its old PID after exit. That number may now belong to another process.
  if (hasExited(proc)) return;
  const pid = proc.pid;
  if (!pid) {
    try {
      proc.kill?.('SIGTERM');
    } catch {
      // already exited
    }
    return;
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid owned process PID.');
  if (!processExists(pid)) return;

  if (process.platform === 'win32') {
    await taskkillTree(pid);
    if (hasExited(proc)) return;
    try {
      proc.kill?.('SIGKILL');
    } catch {
      // already reaped by taskkill
    }
    await waitForProcessExit(proc, pid);
    return;
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      proc.kill?.('SIGTERM');
    } catch {
      // ignore
    }
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 40);
    timer.unref?.();
  });
  if (hasExited(proc)) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      proc.kill?.('SIGKILL');
    } catch {
      // ignore
    }
  }
  await waitForProcessExit(proc, pid);
}

export interface ResourceCloseResult extends ManagedResourceInfo {
  outcome: 'closed' | 'failed';
  error?: string;
}

/**
 * Single owner for long-lived handles: child processes, timers, adapter close hooks.
 * dispose() is idempotent. Composite tools must not spawn unmanaged processes.
 */
export class ResourceManager {
  private resources = new Map<string, ManagedResource>();
  private seq = 0;
  private disposePromise: Promise<void> | null = null;
  private disposed = false;
  private closeResults: ResourceCloseResult[] = [];
  private omittedCloseResults = 0;
  private readonly lateCleanups = new Set<Promise<void>>();
  private readonly lateFailures: Error[] = [];
  private closeDeadline = Infinity;

  /** Newly acquired resources must be disposed immediately, including late initialization results. */
  seal(): void { this.disposed = true; }

  getCloseReport() {
    return { results: this.closeResults.map(result => ({ ...result })), omitted: this.omittedCloseResults };
  }

  private recordClose(item: ManagedResourceInfo, error?: unknown, failed = false): void {
    if (this.closeResults.length === 100) { this.closeResults.shift(); this.omittedCloseResults++; }
    this.closeResults.push({ id: item.id, kind: item.kind, owner: item.owner,
      outcome: failed ? 'failed' : 'closed',
      ...(failed ? { error: (error instanceof Error ? error.message : String(error)).slice(0, 1024) } : {}) });
  }

  private async drainLateCleanups(): Promise<void> {
    while (this.lateCleanups.size) {
      const pending = Promise.all([...this.lateCleanups]);
      if (Number.isFinite(this.closeDeadline)) await withTimeout(pending, Math.max(1, this.closeDeadline - Date.now()), 'late-resource-cleanup');
      else await pending;
    }
    if (this.lateFailures.length) throw new AggregateError(this.lateFailures, 'Late resource cleanup failed.');
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  childProcessCount(): number {
    let n = 0;
    for (const res of this.resources.values()) {
      if (res.kind === 'process') n++;
    }
    return n;
  }

  list(): ManagedResourceInfo[] {
    return Array.from(this.resources.values()).map(({ id, kind, owner }) => ({ id, kind, owner }));
  }

  register(kind: ResourceKind, owner: string, dispose: () => Promise<void> | void): string {
    if (this.disposed) {
      const item = { id: `${owner}:${kind}:${++this.seq}`, kind, owner };
      const pending = Promise.resolve().then(() => dispose()).then(() => this.recordClose(item), error => {
        this.recordClose(item, error, true);
        if (this.lateFailures.length < 100) this.lateFailures.push(new Error(`${owner}/${kind}: cleanup failed`));
      }).finally(() => this.lateCleanups.delete(pending));
      this.lateCleanups.add(pending);
      return item.id;
    }
    const id = `${owner}:${kind}:${++this.seq}`;
    this.resources.set(id, { id, kind, owner, dispose });
    return id;
  }

  registerProcess(owner: string, proc: ChildProcess): string {
    const id = this.register('process', owner, () => killProcessTree(proc));
    const drop = () => {
      this.unregister(id);
      proc.removeListener('exit', drop);
      proc.removeListener('close', drop);
    };
    if (hasExited(proc)) drop();
    else {
      proc.once('exit', drop);
      proc.once('close', drop);
    }
    return id;
  }

  registerTimer(owner: string, handle: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>, kind: 'timer' | 'interval' = 'timer'): string {
    return this.register(kind, owner, () => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
      clearInterval(handle as ReturnType<typeof setInterval>);
    });
  }

  unregister(id: string): void {
    this.resources.delete(id);
  }

  /**
   * Safe to call twice. Concurrent callers share the same in-flight dispose.
   */
  async dispose(deadline = Infinity): Promise<void> {
    if (this.disposePromise) { await this.disposePromise; await this.drainLateCleanups(); return; }
    this.disposed = true;
    this.closeDeadline = deadline;
    this.disposePromise = this.disposeOnce();
    return this.disposePromise;
  }

  private async disposeOnce(): Promise<void> {
    const items = Array.from(this.resources.values()).reverse();
    const failures: Error[] = [];
    for (const [index, item] of items.entries()) {
      try {
        let invoked = false;
        const pending = Promise.resolve().then(() => {
          // Recheck at invocation, including unregisters during the preceding await/microtask.
          if (this.resources.get(item.id) !== item) return;
          invoked = true;
          return item.dispose();
        });
        if (Number.isFinite(this.closeDeadline))
          await withTimeout(pending, Math.max(1, (this.closeDeadline - Date.now()) / (items.length - index)), `close-${item.owner}`);
        else await pending;
        if (!invoked) continue;
        this.resources.delete(item.id);
        this.recordClose(item);
      } catch (error) {
        this.recordClose(item, error, true);
        if (failures.length < 100) failures.push(new Error(`${item.owner}/${item.kind}: ${(error instanceof Error ? error.message : String(error)).slice(0, 1024)}`));
      }
    }
    try { await this.drainLateCleanups(); } catch (error) { failures.push(error as Error); }
    if (failures.length) throw new AggregateError(failures, 'Resource cleanup failed; inspect getCloseReport().');
  }
}
