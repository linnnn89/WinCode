/** Opt-in, request-local diagnostics. Durations are inclusive; nested phases must not be added. */
export class OperationMetrics {
  readonly counters: Record<string, number> = {};
  readonly phases: Record<string, { calls: number; elapsedMs: number }> = {};

  count(name: string, amount = 1): void {
    this.counters[name] = (this.counters[name] ?? 0) + amount;
  }

  start(name: string): () => void {
    const started = performance.now();
    return () => {
      const phase = this.phases[name] ??= { calls: 0, elapsedMs: 0 };
      phase.calls++;
      phase.elapsedMs += performance.now() - started;
    };
  }
}

export function measureOperation<T>(metrics: OperationMetrics | undefined, name: string, run: () => Promise<T>): Promise<T> {
  if (!metrics) return run();
  const end = metrics.start(name);
  return (async () => { try { return await run(); } finally { end(); } })();
}
