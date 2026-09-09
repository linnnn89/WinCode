import fs from 'node:fs/promises';
import path from 'node:path';
import { checkOperation, rethrowOperationError, type OperationContext } from './OperationContext.js';

/** 扫描完成仅指文本扫描范围，不代表语义引用完整。 */
export interface LocalScanResult<T> { items: T[]; complete: boolean; truncated: boolean; error?: string; }

/** 保留原有全局预算、路径边界、编码检查和取消传播；不同目录共用同一个扫描预算。 */
export async function scanLocalFiles<T>(root: string, timeoutMs: number, extensions: string[], maxResults: number,
  extract: (content: string, relPath: string, ext: string) => Iterable<T>, relativePath?: string, operation?: OperationContext
): Promise<LocalScanResult<T>> {
  const items: T[] = [];
  const reasons = new Set<string>();
  const deadline = Date.now() + timeoutMs;
  const fileLimit = 256 * 1024;
  const totalLimit = 8 * 1024 * 1024;
  let bytesRead = 0;
  let entriesVisited = 0;
  let stopped = false;
  let truncated = false;
  const ignoredDirs = new Set(['node_modules', 'bin', 'obj', 'dist', '.git', '.vs', 'trash', '.cache', '.deps', '.packages', '.dotnet', '.dotnet_cli_home']);
  const mark = (reason: string, bounded = false, stop = false): void => {
    reasons.add(reason);
    truncated ||= bounded;
    stopped ||= stop;
  };
  const canContinue = (): boolean => {
    checkOperation(operation);
    if (Date.now() >= deadline) mark('deadline', true, true);
    return !stopped;
  };
  const isInside = (candidate: string, base: string): boolean => {
    const rel = path.relative(base, candidate);
    return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  };
  let realRoot: string;
  try { realRoot = await fs.realpath(root); }
  catch { return { items, complete: false, truncated: false, error: 'Local scan: read-error' }; }

  const read = async (fullPath: string): Promise<void> => {
    if (!canContinue()) return;
    const ext = path.extname(fullPath).toLowerCase();
    if (!extensions.includes(ext)) return;
    try {
      // Also guards a scoped path whose intermediate directory is a junction.
      const actualPath = await fs.realpath(fullPath);
      if (!isInside(actualPath, realRoot)) { mark('invalid-scope'); return; }
      if (!canContinue()) return;
      const handle = await fs.open(actualPath, 'r');
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) { mark('read-error'); return; }
        if (stat.size > fileLimit) { mark('file-byte-limit', true); return; }
        const remaining = totalLimit - bytesRead;
        if (remaining <= 0) { mark('total-byte-limit', true, true); return; }
        // One extra byte detects a file growing after stat, without an unbounded readFile.
        const buffer = Buffer.alloc(Math.min(fileLimit + 1, remaining));
        let used = 0;
        let eof = false;
        while (used < buffer.length && canContinue()) {
          const chunk = await handle.read(buffer, used, buffer.length - used, null);
          bytesRead += chunk.bytesRead;
          used += chunk.bytesRead;
          if (chunk.bytesRead === 0) { eof = true; break; }
        }
        if (!canContinue()) return;
        if (used > fileLimit) { mark('file-byte-limit', true); return; }
        if (!eof && used === remaining) { mark('total-byte-limit', true, true); return; }
        let content: string;
        try {
          content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, used));
          if (content.includes('\0')) { mark('encoding'); return; }
        } catch { mark('encoding'); return; }
        for (const item of extract(content, path.relative(root, fullPath), ext)) {
          if (!canContinue()) break;
          items.push(item);
          if (items.length >= maxResults) { mark('result-limit', true, true); break; }
        }
      } finally { await handle.close(); }
    } catch (error) { rethrowOperationError(error, operation); mark('read-error'); }
  };
  const walk = async (dir: string): Promise<void> => {
    if (!canContinue()) return;
    try {
      // Stream directory entries so an enormous directory does not allocate an unbounded array.
      const handle = await fs.opendir(dir);
      for await (const entry of handle) {
        if (!canContinue()) break;
        if (++entriesVisited > 5000) { mark('entry-limit', true, true); break; }
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory() && !ignoredDirs.has(entry.name)) await walk(fullPath);
        else if (entry.isFile()) await read(fullPath);
        else if (entry.isSymbolicLink()) mark('symlink-skipped');
      }
    } catch (error) { rethrowOperationError(error, operation); mark('read-error'); }
  };
  if (relativePath) {
    const scopedPath = path.resolve(root, relativePath);
    if (path.isAbsolute(relativePath) || !isInside(scopedPath, root)) mark('invalid-scope');
    else await read(scopedPath);
  } else await walk(root);
  return { items, complete: reasons.size === 0, truncated,
    error: reasons.size ? `Local scan: ${[...reasons].join(', ')}` : undefined };
}
