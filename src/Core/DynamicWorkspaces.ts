import path from 'node:path';
import { getDefaultConfig } from './Config.js';
import { resolveWorkspaceDirectory } from './FileSystemBoundary.js';
import { checkOperation, rethrowOperationError } from './OperationContext.js';
import { AbortError, Mutex } from './ResourceManager.js';
import type { RequestLease } from './RequestAdmission.js';
import { ToolRouter } from './ToolRouter.js';

export function absoluteWorkspace(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || value.includes('\0') || !path.isAbsolute(value)
    || (process.platform === 'win32' && (path.parse(value).root.length < 2 || /^[\\/]{2}[?.][\\/]/.test(value)))) {
    throw new Error('Expected a fully qualified absolute workspace directory.');
  }
  return path.resolve(value);
}

interface Entry {
  router: ToolRouter;
  ready: Promise<void>;
  state: 'opening' | 'ready' | 'retiring' | 'failed';
  cleanupError?: unknown;
  users: number;
}

export interface WorkspaceUse {
  router: ToolRouter;
  ready?: Promise<void>;
  release(): void;
}

export class WorkspaceSelectionError extends Error {
  constructor(readonly errorCode: 'INVALID_ARGUMENT' | 'WORKSPACE_BUSY' | 'WORKSPACE_RECOVERY_REQUIRED', message: string) { super(message); }
}

/** The map owns workspace resources. A request owns its selection through finalization, including any queue waits. */
export class DynamicWorkspaces {
  private readonly entries = new Map<string, Entry>();
  private readonly cold = new Mutex();
  private readonly capacity = 4;
  private closing = false;

  constructor(private readonly primary: ToolRouter) {}

  private createRouter(root: string): ToolRouter {
    const config = this.primary.config;
    const { cacheDir, trashDir } = getDefaultConfig(root);
    return new ToolRouter({ ...config, workspaceRoot: root, workspaceRootSource: 'request', cacheDir, trashDir,
      adapters: { ...config.adapters, roslyn: undefined } }, this.primary);
  }

  // Selecting and pinning an entry is synchronous. An idle victim is marked before its first asynchronous cleanup.
  private select(root: string, passive: boolean): WorkspaceUse | undefined {
    const entry = this.entries.get(root);
    if (!entry) return passive ? { router: this.createRouter(root), release() {} } : undefined;
    if (entry.state === 'retiring') return undefined;
    if (entry.state === 'failed' && !passive)
      throw new WorkspaceSelectionError('WORKSPACE_RECOVERY_REQUIRED', `Workspace cleanup failed for ${root}: ${String(entry.cleanupError)}`);
    this.entries.delete(root);
    this.entries.set(root, entry);
    entry.users++;
    return { router: entry.router, ready: passive ? undefined : entry.ready, release: () => { entry.users--; } };
  }

  private checkActive(lease: RequestLease): void {
    checkOperation(lease.operation);
    if (this.closing) throw new AbortError('Dynamic workspaces are shutting down.');
  }

  async acquire(root: string, lease: RequestLease, passive: boolean, rootsToConfirm?: Iterable<string>): Promise<WorkspaceUse> {
    let physical: string;
    try {
      physical = await resolveWorkspaceDirectory(root, lease.operation);
      if (rootsToConfirm) for (const alternate of rootsToConfirm) {
        if (await resolveWorkspaceDirectory(alternate, lease.operation) !== physical)
          throw new Error('Absolute paths and workspace selectors must identify the same project.');
      }
    } catch (error) {
      rethrowOperationError(error, lease.operation);
      throw new WorkspaceSelectionError('INVALID_ARGUMENT', error instanceof Error ? error.message : String(error));
    }
    this.checkActive(lease);
    if (this.primary.config.workspaceRootSource === 'argument') {
      const matches = await this.primary.workspace.matchesConfiguredRoot(root, physical, lease.operation);
      this.checkActive(lease);
      if (matches) return { router: this.primary, release() {} };
    }
    const hit = this.select(physical, passive);
    if (hit) return hit;
    // Only cold selections wait for the reserved slot. Hits on other roots keep using their own routers.
    return this.cold.runExclusive(async () => {
      this.checkActive(lease);
      const shared = this.select(physical, passive);
      if (shared) return shared;
      while (this.entries.size >= this.capacity) {
        const idle = [...this.entries].find(([, entry]) => !entry.users && entry.state === 'ready');
        if (!idle) {
          if ([...this.entries.values()].every(entry => entry.state === 'failed'))
            throw new WorkspaceSelectionError('WORKSPACE_RECOVERY_REQUIRED', 'All dynamic workspace slots have unconfirmed cleanup. Restart the gateway.');
          throw new WorkspaceSelectionError('WORKSPACE_BUSY', 'No idle dynamic workspace slot is available. Retry after a project request completes.');
        }
        const [key, victim] = idle;
        victim.state = 'retiring';
        try { await victim.router.dispose(); this.entries.delete(key); }
        catch (error) { victim.state = 'failed'; victim.cleanupError = error; }
        this.checkActive(lease);
      }
      const router = this.createRouter(physical);
      const created: Entry = { router, ready: router.initialize(), state: 'opening', users: 0 };
      this.entries.set(physical, created);
      void created.ready.then(() => { created.state = 'ready'; }, error => {
        if (error instanceof AggregateError) { created.state = 'failed'; created.cleanupError = error; }
        else this.entries.delete(physical);
      });
      return this.select(physical, passive)!;
    }, lease.signal, lease.queue);
  }

  async dispose(): Promise<void> {
    this.closing = true;
    await this.cold.runExclusive(async () => {
      const results = await Promise.allSettled([...this.entries.values()].map(entry => entry.router.dispose()));
      const failures = results.filter(result => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Dynamic workspace cleanup failed.');
      this.entries.clear();
    });
  }
}
