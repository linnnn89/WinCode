import { AbortError, TimeoutError, type QueueObserver } from './ResourceManager.js';
import type { OperationContext } from './OperationContext.js';

export const ADMISSION_LIMITS = Object.freeze({ business: 32, status: 4, argumentBytes: 64 * 1024 });
export type RequestLane = 'business' | 'status';
const counters = () => ({ accepted: 0, completed: 0, rejected: 0, cancelled: 0, timedOut: 0,
  peakActive: 0, waitMs: 0, executionMs: 0, maxWaitMs: 0 });

export class ServerBusyError extends Error {
  constructor(readonly lane: RequestLane, readonly admission: ReturnType<RequestAdmission['snapshot']>) {
    super(`WinCode ${lane} request capacity is full; this call has not started. Retry later without automatic replay.`);
    this.name = 'ServerBusyError';
  }
}

export class RequestLease {
  readonly signal: AbortSignal;
  readonly deadline: number;
  readonly queue: QueueObserver;
  readonly startedAt = performance.now();
  workStarted = false;
  private waits = 0;
  private waitingAt = 0;
  private waitedMs = 0;
  private released = false;
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(readonly lane: RequestLane, parent: AbortSignal, budgetMs: number,
    private readonly finish: (lease: RequestLease, waitMs: number, elapsedMs: number, error?: unknown) => void) {
    const timeout = new AbortController();
    this.signal = AbortSignal.any([parent, timeout.signal]);
    this.deadline = Date.now() + budgetMs;
    this.timer = setTimeout(() => timeout.abort(new TimeoutError('request', budgetMs)), budgetMs);
    this.queue = { wait: () => this.wait() };
  }

  get waiting(): boolean { return this.waits > 0; }
  get operation(): OperationContext { return { signal: this.signal, deadline: this.deadline, queue: this.queue }; }
  wait(): () => void {
    if (this.released) return () => {};
    if (this.waits++ === 0) this.waitingAt = performance.now();
    let resumed = false;
    return () => {
      if (resumed || this.released) return;
      resumed = true;
      if (--this.waits === 0) this.waitedMs += performance.now() - this.waitingAt;
    };
  }
  release(error?: unknown): void {
    if (this.released) return;
    if (this.waits) this.waitedMs += performance.now() - this.waitingAt;
    this.released = true;
    clearTimeout(this.timer);
    this.finish(this, this.waitedMs, performance.now() - this.startedAt, error);
  }
}

interface SharedWait {
  settled: boolean;
  failed: boolean;
  error?: unknown;
  waiters: Set<() => void>;
}

/** Counts unfinished MCP calls once, including waits inside existing adapter mutexes. */
export class RequestAdmission {
  private readonly leases = new Set<RequestLease>();
  private readonly bySignal = new WeakMap<AbortSignal, RequestLease>();
  private readonly totals = { business: counters(), status: counters() };
  private readonly shared = new WeakMap<Promise<unknown>, SharedWait>();
  private sharedWaiters = 0;

  get pendingCount(): number { return this.leases.size; }
  operation(signal?: AbortSignal): OperationContext | undefined { return signal ? this.bySignal.get(signal)?.operation : undefined; }

  acquire(lane: RequestLane, parent: AbortSignal, budgetMs: number): RequestLease {
    if (parent.aborted) throw new AbortError('Tool call cancelled before admission.');
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new Error('Request timeout must be finite and positive.');
    const active = [...this.leases].filter(lease => lease.lane === lane).length;
    if (active >= ADMISSION_LIMITS[lane]) {
      this.totals[lane].rejected++;
      throw new ServerBusyError(lane, this.snapshot());
    }
    const lease = new RequestLease(lane, parent, budgetMs, (finished, waitMs, elapsedMs, error) => {
      this.leases.delete(finished); this.bySignal.delete(finished.signal);
      const total = this.totals[lane];
      total.completed++; total.waitMs += waitMs; total.executionMs += Math.max(0, elapsedMs - waitMs);
      total.maxWaitMs = Math.max(total.maxWaitMs, waitMs);
      // A deadline check or shorter adapter budget may fail before the lease timer runs.
      if (error instanceof TimeoutError || finished.signal.reason instanceof TimeoutError) total.timedOut++;
      else if (finished.signal.aborted) total.cancelled++;
    });
    this.leases.add(lease); this.bySignal.set(lease.signal, lease);
    this.totals[lane].accepted++; this.totals[lane].peakActive = Math.max(this.totals[lane].peakActive, active + 1);
    return lease;
  }

  snapshot() {
    const lane = (name: RequestLane) => {
      const active = [...this.leases].filter(lease => lease.lane === name);
      const waiting = active.filter(lease => lease.waiting).length;
      return { limit: ADMISSION_LIMITS[name], active: active.length, executing: active.length - waiting,
        waiting, ...this.totals[name] };
    };
    return { maxArgumentBytes: ADMISSION_LIMITS.argumentBytes, business: lane('business'), status: lane('status'), sharedWaiters: this.sharedWaiters };
  }

  /** One reaction per shared startup promise; cancelled calls remove their actual waiter. */
  async waitFor(promise: Promise<unknown>, lease: RequestLease): Promise<void> {
    let state = this.shared.get(promise);
    if (!state) {
      state = { settled: false, failed: false, waiters: new Set() };
      this.shared.set(promise, state);
      const observed = state;
      const settle = (failed: boolean, error?: unknown) => {
        observed.settled = true; observed.failed = failed; observed.error = error;
        for (const complete of [...observed.waiters]) complete();
      };
      void promise.then(() => settle(false), error => settle(true, error));
    }
    if (lease.signal.aborted) throw new AbortError('Tool call cancelled while waiting for startup.');
    if (state.settled) { if (state.failed) throw state.error; return; }
    const observed = state;
    const resume = lease.wait();
    await new Promise<void>((resolve, reject) => {
      const complete = () => {
        if (!observed.waiters.delete(complete)) return;
        this.sharedWaiters--; lease.signal.removeEventListener('abort', complete); resume();
        if (lease.signal.aborted) reject(new AbortError('Tool call cancelled while waiting for startup.'));
        else if (observed.failed) reject(observed.error);
        else resolve();
      };
      observed.waiters.add(complete); this.sharedWaiters++;
      lease.signal.addEventListener('abort', complete, { once: true });
    });
  }
}
