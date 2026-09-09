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
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  runExclusive<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(
        new AbortError(signal.reason ? String(signal.reason) : 'The operation was aborted')
      );
    }

    let onAbort: (() => void) | undefined;
    let skipped = false;

    const previousTail = this.tail;

    const execute = async (): Promise<T> => {
      if (onAbort && signal) {
        signal.removeEventListener('abort', onAbort);
      }
      if (skipped || signal?.aborted) {
        throw new AbortError(signal?.reason ? String(signal.reason) : 'The operation was aborted');
      }
      return fn();
    };

    const run = previousTail.then(execute, execute);
    this.tail = run.then(
      () => undefined,
      () => undefined
    );

    if (!signal) {
      return run;
    }

    const abortPromise = new Promise<T>((_, reject) => {
      onAbort = () => {
        skipped = true;
        reject(
          new AbortError(signal.reason ? String(signal.reason) : 'The operation was aborted')
        );
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });

    return Promise.race([run, abortPromise]).finally(() => {
      if (onAbort && signal) {
        signal.removeEventListener('abort', onAbort);
      }
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

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 2000;
  while (processExists(pid)) {
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
  proc: ChildProcess | { pid?: number | null; kill?: (sig?: NodeJS.Signals) => boolean }
): Promise<void> {
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
    try {
      proc.kill?.('SIGKILL');
    } catch {
      // already reaped by taskkill
    }
    await waitForProcessExit(pid);
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
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      proc.kill?.('SIGKILL');
    } catch {
      // ignore
    }
  }
  await waitForProcessExit(pid);
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
    while (this.lateCleanups.size) await Promise.all([...this.lateCleanups]);
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
    const drop = () => this.unregister(id);
    proc.once('exit', drop);
    proc.once('close', drop);
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
  async dispose(): Promise<void> {
    if (this.disposePromise) { await this.disposePromise; await this.drainLateCleanups(); return; }
    this.disposed = true;
    this.disposePromise = this.disposeOnce();
    return this.disposePromise;
  }

  private async disposeOnce(): Promise<void> {
    const items = Array.from(this.resources.values()).reverse();
    const failures: Error[] = [];
    for (const item of items) {
      try {
        await item.dispose();
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
