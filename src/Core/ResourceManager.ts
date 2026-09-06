import { ChildProcess, exec } from 'node:child_process';

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
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Serializes a critical section. Callers queue; there is no OS thread pool.
 */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

/**
 * Kill a child and, on Windows, its process tree. npx/cmd spawn grandchildren
 * that SIGTERM on the parent does not reach (MCP python-sdk #850 class of bug).
 */
export async function killProcessTree(proc: ChildProcess | { pid?: number | null; kill?: (sig?: NodeJS.Signals) => boolean }): Promise<void> {
  const pid = proc.pid;
  try {
    proc.kill?.('SIGTERM');
  } catch {
    // already exited
  }

  if (pid && process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      exec(`taskkill /pid ${pid} /T /F`, { windowsHide: true }, () => resolve());
    });
    return;
  }

  if (pid) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // ignore
      }
    }
  }
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
      void Promise.resolve().then(() => dispose()).catch(() => {});
      return `dropped_${kind}`;
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
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.disposePromise = this.disposeOnce();
    try {
      await this.disposePromise;
    } finally {
      this.disposePromise = Promise.resolve();
    }
  }

  private async disposeOnce(): Promise<void> {
    const items = Array.from(this.resources.values()).reverse();
    this.resources.clear();
    for (const item of items) {
      try {
        await item.dispose();
      } catch {
        // never fail shutdown because one handle is already gone
      }
    }
  }
}
