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

  /** A passive snapshot: diagnosing a failed watcher must not restart it or enumerate files. */
  getStatus() {
    return { active: this.watcher !== null, root: this.root, lastError: this.lastError };
  }

  private recordFailure(error: unknown): void {
    this.lastError = { at: new Date().toISOString(), message: (error instanceof Error ? error.message : String(error)).slice(0, 500) };
    console.warn(`[WorkspaceWatch] Watch stopped: ${this.lastError.message}`);
    this.stop();
  }

  get activeRoot(): string | null {
    return this.root;
  }

  start(workspaceRoot: string, onChange: () => void, debounceMs = 150): void {
    this.stop();
    this.root = path.resolve(workspaceRoot);
    this.onChange = onChange;
    this.debounceMs = debounceMs;
    try {
      // Windows short-path aliases can trigger a libuv fs-event assertion.
      // Resolve only the native watch path; retain the caller's workspace identity.
      const watchRoot = fs.realpathSync.native(this.root);
      this.watcher = fs.watch(watchRoot, { recursive: true }, (_event, filename) => {
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
      this.watcher.on('error', error => this.recordFailure(error));
    } catch (error) {
      this.recordFailure(error);
    }
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        // already closed
      }
      this.watcher = null;
    }
    this.root = null;
    this.onChange = null;
  }
}
