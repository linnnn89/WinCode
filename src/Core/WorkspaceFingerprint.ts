import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { gitRootIsTrusted, runGit } from './GitClient.js';
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
  constructor(private fingerprintMemoMs: number, private readonly trustedGitRoots: readonly string[] = []) {}

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
    checkOperation(operation);
    const gitDir = path.join(resolvedRoot, '.git');
    const git = gitRootIsTrusted(resolvedRoot, this.trustedGitRoots) ? await fs.lstat(gitDir).catch(() => null) : null;
    const candidates = git?.isDirectory() ? [path.join(gitDir, 'HEAD'), path.join(gitDir, 'index')] : [];
    candidates.push(path.join(resolvedRoot, 'package.json'));
    const parts = [`watch:${gen}`];
    for (const file of candidates) {
      checkOperation(operation);
      try {
        const s = await fs.lstat(file);
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
      if (!gitRootIsTrusted(resolvedRoot, this.trustedGitRoots))
        return await this.computeDirectoryFingerprintFallback(resolvedRoot, operation);
      const gitPath = path.join(resolvedRoot, '.git');
      const git = await fs.lstat(gitPath).catch(() => null);
      checkOperation(operation);

      if (git?.isDirectory() || git?.isFile()) {
        try {
          const [headRes, statusRes] = await Promise.allSettled([
            runGit(resolvedRoot, this.trustedGitRoots, ['rev-parse', 'HEAD'], 3000, operation),
            runGit(resolvedRoot, this.trustedGitRoots, ['status', '--porcelain=v1', '-z'], 5000, operation),
          ]);
          checkOperation(operation);
          const headCommit = headRes.status === 'fulfilled' ? headRes.value.stdout.trim() : '';
          if (statusRes.status === 'rejected') {
            rethrowOperationError(statusRes.reason, operation);
            const directory = await this.computeDirectoryFingerprintFallback(resolvedRoot, operation);
            return headCommit ? crypto.createHash('sha1').update(headCommit + '|' + directory).digest('hex') : directory;
          }
          const gitStatusRaw = statusRes.value.stdout;

          let branchRef = '';
          if (!headCommit) {
            try {
              branchRef = (await runGit(resolvedRoot, this.trustedGitRoots, ['symbolic-ref', '--quiet', 'HEAD'], 3000, operation)).stdout.trim();
            } catch (error) { rethrowOperationError(error, operation); }
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
                const stat = await fs.lstat(fullPath);
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
        }
      }

      return await this.computeDirectoryFingerprintFallback(resolvedRoot, operation);
    } catch (error) {
      rethrowOperationError(error, operation);
      return `ts_${Date.now()}`;
    }
  }

  private async computeDirectoryFingerprintFallback(dirPath: string, operation?: OperationContext): Promise<string> {
    const maxFiles = 100, maxDepth = 3, maxEntries = 1000;
    const ignoredDirs = new Set(['node_modules', 'bin', 'obj', 'dist', '.git', '.vs', 'trash', '.deps', '.packages']);
    const stats: string[] = [];
    let examined = 0;

    // Sample files in the project root before descending so one large subtree cannot crowd them out.
    const folders = [{ currentDir: dirPath, depth: 0 }];
    for (let index = 0; index < folders.length && examined < maxEntries && stats.length < maxFiles; index++) {
      checkOperation(operation);
      const { currentDir, depth } = folders[index];
      let directory;
      try {
        directory = await fs.opendir(currentDir, { bufferSize: 16 });
        while (examined < maxEntries && stats.length < maxFiles) {
          checkOperation(operation);
          const entry = await directory.read();
          if (!entry) break;
          examined++;
          checkOperation(operation);
          if (entry.isDirectory()) {
            if (depth < maxDepth && !ignoredDirs.has(entry.name) && !entry.name.startsWith('.'))
              folders.push({ currentDir: path.join(currentDir, entry.name), depth: depth + 1 });
          } else if (entry.isFile()) {
            try {
              const file = path.join(currentDir, entry.name);
              const s = await fs.lstat(file);
              stats.push(`${path.relative(dirPath, file)}:${s.mtimeMs}:${s.size}`);
            } catch {
              stats.push(entry.name);
            }
          }
        }
      } catch (error) {
        rethrowOperationError(error, operation);
      } finally { await directory?.close(); }
    }
    // An entry ceiling can leave every source file outside the sample. Do not reuse an older disk
    // result on a new observation when the directory scan reached that ceiling.
    if (examined >= maxEntries) stats.push(crypto.randomUUID());
    return crypto.createHash('sha1').update(stats.sort().join('|')).digest('hex');
  }

}
