import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { runGit } from './GitClient.js';
import { checkOperation, rethrowOperationError, type OperationContext } from './OperationContext.js';

export interface FingerprintOptions {
  fresh?: boolean;
  /** Only a successful live status probe supplies an observation for this request. */
  onGitStatus?: (isClean: boolean) => void;
}

/** 文本缓存的有界变更提示及短时复用；它不是 Roslyn 编译输入快照，也不证明全仓内容相同。 */
export class WorkspaceFingerprint {
  private fpMemo = new Map<string, { value: string; expiresAt: number; cheap: string }>();
  private fpInflight = new Map<string, { shared?: Promise<string> }>();
  private watchGeneration = new Map<string, number>();
  constructor(private fingerprintMemoMs: number) {}

  /** 切换缓存根时清空该实例的全部观察；调用方先排空业务请求。 */
  reset(): void { this.fpMemo.clear(); this.fpInflight.clear(); this.watchGeneration.clear(); }

  /**
   * Workspace fingerprint with a few-second memo and single-flight.
   * Memo is skipped when the cheap probe (git HEAD/index mtime, watch
   * generation) changed — so uncommitted writes are not stuck for 2.5s.
   * Pass { fresh: true } after a known write to bypass memo entirely.
   */
  async computeWorkspaceFingerprint(
    workspaceRoot: string,
    options?: FingerprintOptions,
    operation?: OperationContext
  ): Promise<string> {
    const resolvedRoot = path.resolve(workspaceRoot);
    const cheap = await this.cheapChangeProbe(resolvedRoot, operation);
    checkOperation(operation);
    if (options?.fresh) {
      this.invalidateFingerprint(resolvedRoot);
    } else {
      const memo = this.fpMemo.get(resolvedRoot);
      if (memo && memo.expiresAt > Date.now() && memo.cheap === cheap) {
        return memo.value;
      }
      const shared = this.fpInflight.get(resolvedRoot)?.shared;
      if (shared && !operation) return shared;
    }

    const pending = this.computeWorkspaceFingerprintUncached(resolvedRoot, operation, options?.onGitStatus);
    // A cancelled caller owns its computation. Invalidation or a newer observer revokes the right to publish a memo.
    const observation = { shared: operation ? undefined : pending };
    this.fpInflight.set(resolvedRoot, observation);
    try {
      const value = await pending;
      checkOperation(operation);
      if (this.fpInflight.get(resolvedRoot) === observation)
        this.fpMemo.set(resolvedRoot, { value, cheap, expiresAt: Date.now() + this.fingerprintMemoMs });
      return value;
    } finally {
      if (this.fpInflight.get(resolvedRoot) === observation) this.fpInflight.delete(resolvedRoot);
    }
  }

  /**
   * Called from WorkspaceWatch. Drops memo so the next MCP call rescans.
   */
  noteFilesystemChange(workspaceRoot: string): void {
    const resolved = path.resolve(workspaceRoot);
    this.watchGeneration.set(resolved, (this.watchGeneration.get(resolved) ?? 0) + 1);
    this.invalidateFingerprint(resolved);
  }

  invalidateFingerprint(workspaceRoot?: string): void {
    if (!workspaceRoot) {
      this.fpMemo.clear();
      this.fpInflight.clear();
      return;
    }
    const resolved = path.resolve(workspaceRoot);
    this.fpMemo.delete(resolved);
    this.fpInflight.delete(resolved);
  }

  private async cheapChangeProbe(resolvedRoot: string, operation?: OperationContext): Promise<string> {
    const gen = this.watchGeneration.get(resolvedRoot) ?? 0;
    const candidates = [
      path.join(resolvedRoot, '.git', 'HEAD'),
      path.join(resolvedRoot, '.git', 'index'),
      path.join(resolvedRoot, 'package.json'),
    ];
    const parts = [`watch:${gen}`];
    for (const file of candidates) {
      checkOperation(operation);
      try {
        const s = await fs.stat(file);
        parts.push(`${path.basename(file)}:${s.mtimeMs}:${s.size}`);
      } catch {
        parts.push(`${path.basename(file)}:missing`);
      }
    }
    return parts.join('|');
  }

  private async computeWorkspaceFingerprintUncached(resolvedRoot: string, operation?: OperationContext,
    onGitStatus?: FingerprintOptions['onGitStatus']): Promise<string> {
    try {
      const gitPath = path.join(resolvedRoot, '.git');
      const hasGit = await fs.stat(gitPath).catch(() => null);
      checkOperation(operation);

      if (hasGit) {
        try {
          const [headRes, statusRes] = await Promise.allSettled([
            runGit(resolvedRoot, ['rev-parse', 'HEAD'], 3000, operation),
            runGit(resolvedRoot, ['status', '--porcelain=v1', '-z'], 5000, operation),
          ]);
          checkOperation(operation);
          if (statusRes.status === 'rejected') throw statusRes.reason;
          const headCommit = headRes.status === 'fulfilled' ? headRes.value.stdout.trim() : '';
          const gitStatusRaw = statusRes.value.stdout;

          let branchRef = '';
          if (!headCommit) {
            try {
              const headContent = await fs.readFile(path.join(resolvedRoot, '.git', 'HEAD'), 'utf-8');
              branchRef = headContent.trim();
            } catch {
              // ignore
            }
          }

          const rawEntries = gitStatusRaw.split('\0');
          const parsedItems: { statusType: string; relPath: string; origPath?: string }[] = [];
          for (let i = 0; i < rawEntries.length; i++) {
            const entry = rawEntries[i];
            if (!entry || entry.length < 3) continue;
            const statusType = entry.substring(0, 2);
            const pathPart = entry.substring(3);
            if (statusType.includes('R') || statusType.includes('C')) {
              // In git status -z porcelain, R/C outputs: "XY NEW_PATH\0OLD_PATH\0"
              const origPath = rawEntries[++i] || '';
              parsedItems.push({ statusType, relPath: pathPart, origPath });
            } else {
              parsedItems.push({ statusType, relPath: pathPart });
            }
          }

          const itemsToStat = parsedItems.slice(0, 100);
          checkOperation(operation);

          const fileStats = await Promise.all(
            itemsToStat.map(async ({ statusType, relPath, origPath }) => {
              const fullPath = path.resolve(resolvedRoot, relPath);
              const pathKey = origPath ? `${relPath}<-${origPath}` : relPath;
              try {
                const stat = await fs.stat(fullPath);
                return `${statusType}:${pathKey}:${stat.mtimeMs}:${stat.size}`;
              } catch {
                return `${statusType}:${pathKey}:deleted`;
              }
            })
          );

          const payload = [headCommit || branchRef || 'no-head', parsedItems.length.toString(), ...fileStats].join('|');
          onGitStatus?.(gitStatusRaw.length === 0);
          return crypto.createHash('sha1').update(payload).digest('hex');
        } catch (error) {
          rethrowOperationError(error, operation);
          try {
            const gitHeadPath = path.join(resolvedRoot, '.git', 'HEAD');
            const gitHead = await fs.readFile(gitHeadPath, 'utf-8').catch(() => null);
            checkOperation(operation);
            if (gitHead) {
              let commitRef = gitHead.trim();
              const match = commitRef.match(/ref:\s*refs\/heads\/([^\r\n]+)/);
              if (match) {
                const branchPath = path.join(resolvedRoot, '.git', 'refs', 'heads', match[1]);
                const branchCommit = await fs.readFile(branchPath, 'utf-8').catch(() => null);
                if (branchCommit) {
                  commitRef = branchCommit.trim();
                }
              }
              let indexStat = '';
              checkOperation(operation);
              try {
                const s = await fs.stat(path.join(resolvedRoot, '.git', 'index'));
                indexStat = `${s.mtimeMs}:${s.size}`;
              } catch {
                // ignore
              }

              const dirFp = await this.computeDirectoryFingerprintFallback(resolvedRoot, operation);
              return crypto.createHash('sha1').update(`${commitRef}|${indexStat}|${dirFp}`).digest('hex');
            }
          } catch (error) {
            rethrowOperationError(error, operation);
          }
        }
      }

      return await this.computeDirectoryFingerprintFallback(resolvedRoot, operation);
    } catch (error) {
      rethrowOperationError(error, operation);
      return `ts_${Date.now()}`;
    }
  }

  private async computeDirectoryFingerprintFallback(dirPath: string, operation?: OperationContext): Promise<string> {
    const maxFiles = 100, maxDepth = 3;
    const ignoredDirs = new Set(['node_modules', 'bin', 'obj', 'dist', '.git', '.vs', 'trash', '.deps', '.packages']);
    const stats: string[] = [];

    const walk = async (currentDir: string, depth: number) => {
      checkOperation(operation);
      if (depth > maxDepth || stats.length >= maxFiles) return;
      try {
        const entries = await fs.readdir(currentDir, { withFileTypes: true });
        for (const entry of entries) {
          checkOperation(operation);
          if (stats.length >= maxFiles) break;
          if (entry.isDirectory()) {
            if (!ignoredDirs.has(entry.name) && !entry.name.startsWith('.')) {
              await walk(path.join(currentDir, entry.name), depth + 1);
            }
          } else if (entry.isFile()) {
            try {
              const s = await fs.stat(path.join(currentDir, entry.name));
              stats.push(`${entry.name}:${s.mtimeMs}:${s.size}`);
            } catch {
              stats.push(entry.name);
            }
          }
        }
      } catch (error) {
        rethrowOperationError(error, operation);
      }
    };

    await walk(dirPath, 0);
    return crypto.createHash('sha1').update(stats.join('|')).digest('hex');
  }

}
