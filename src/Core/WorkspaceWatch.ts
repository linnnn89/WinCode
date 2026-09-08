import fs from 'node:fs';
import path from 'node:path';

const IGNORED = new Set([
  'node_modules',
  'bin',
  'obj',
  'dist',
  'build',
  '.git',
  '.vs',
  'trash',
  '.cache',
  '.deps',
  '.packages',
  'TestResults',
]);

/**
 * Debounced recursive watch used to drop fingerprint memo when files change.
 * Matches the LSP pattern: do not rescan on every MCP call, but do not wait
 * for a multi-second TTL after a real write either.
 */
export class WorkspaceWatch {
  private watcher: fs.FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private root: string | null = null;
  private debounceMs = 150;
  private onChange: (() => void) | null = null;
  private lastError: { at: string; message: string } | null = null;
  private closing: Promise<void> = Promise.resolve();

  /** A passive snapshot: diagnosing a failed watcher must not restart it or enumerate files. */
  getStatus() {
    return { active: this.watcher !== null, root: this.root, lastError: this.lastError };
  }

  private recordFailure(error: unknown): void {
    this.lastError = { at: new Date().toISOString(), message: (error instanceof Error ? error.message : String(error)).slice(0, 500) };
    console.warn(`[WorkspaceWatch] Watch stopped: ${this.lastError.message}`);
    void this.stop().catch(() => {}); // Failure is retained in closing for the owner to await.
  }

  get activeRoot(): string | null {
    return this.root;
  }

  start(workspaceRoot: string, onChange: () => void, debounceMs = 150): void {
    void this.stop().catch(() => {});
    this.root = path.resolve(workspaceRoot);
    this.onChange = onChange;
    this.debounceMs = debounceMs;
    try {
      // Windows short-path aliases can trigger a libuv fs-event assertion.
      // Resolve only the native watch path; retain the caller's workspace identity.
      const watchRoot = fs.realpathSync.native(this.root);
      const watcher = fs.watch(watchRoot, { recursive: true }, (_event, filename) => {
        if (this.watcher !== watcher) return;
        if (!filename) return;
        const parts = String(filename).split(/[\\/]/);
        if (parts.some((p) => IGNORED.has(p))) return;
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = null;
          this.onChange?.();
        }, this.debounceMs);
        this.debounceTimer.unref?.();
      });
      this.watcher = watcher;
      watcher.on('error', error => {
        if (this.watcher === watcher) this.recordFailure(error);
      });
    } catch (error) {
      this.recordFailure(error);
    }
  }

  /** Detach immediately; completion waits for every watcher this instance closed. */
  stop(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      const watcher = this.watcher;
      this.watcher = null;
      const closed = new Promise<void>((resolve, reject) => {
        const finish = (error?: unknown) => {
          clearTimeout(deadline);
          watcher.removeListener('close', onClose);
          if (error) reject(error); else resolve();
        };
        const onClose = () => finish();
        const deadline = setTimeout(() => finish(new Error('Workspace watcher close was not confirmed within 2000ms.')), 2000);
        watcher.once('close', onClose);
        try { watcher.close(); } catch (error) { finish(error); }
      });
      this.closing = Promise.allSettled([this.closing, closed]).then(results => {
        const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failures.length === 1) throw failures[0].reason;
        if (failures.length > 1) throw new AggregateError(failures.map(result => result.reason), 'Workspace watcher close failed.');
      });
      // Retain the rejection for explicit stop callers, without unhandled rejection
      // when replacing a watcher through the synchronous start API.
      void this.closing.catch(error => {
        this.lastError = { at: new Date().toISOString(), message: String(error).slice(0, 500) };
      });
    }
    this.root = null;
    this.onChange = null;
    return this.closing;
  }
}
