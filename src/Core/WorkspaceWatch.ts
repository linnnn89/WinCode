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

  get activeRoot(): string | null {
    return this.root;
  }

  start(workspaceRoot: string, onChange: () => void, debounceMs = 150): void {
    this.stop();
    this.root = path.resolve(workspaceRoot);
    this.onChange = onChange;
    this.debounceMs = debounceMs;
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (_event, filename) => {
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
      this.watcher.on('error', () => {
        this.stop();
      });
    } catch {
      this.watcher = null;
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
