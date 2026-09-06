import fs from 'node:fs/promises';
import path from 'node:path';
import { IAdapter, AdapterHealth } from './IAdapter.js';
import { WinCodeConfig } from '../Core/Config.js';
import { CacheManager } from '../Core/Cache.js';

export interface CodeSymbol {
  name: string;
  kind: 'class' | 'interface' | 'method' | 'function' | 'property' | 'enum' | 'struct' | 'type';
  file: string;
  line: number;
  signature?: string;
  containerName?: string;
}

export interface SymbolReference {
  symbolName: string;
  file: string;
  line: number;
  preview: string;
}

export class SerenaAdapter implements IAdapter {
  readonly name = 'SerenaAdapter';
  readonly description = 'Semantic code intelligence, symbol search, and reference tracking';

  private config: WinCodeConfig;
  private cache: CacheManager;
  private isSerenaProcessAvailable = false;

  constructor(config: WinCodeConfig, cache: CacheManager) {
    this.config = config;
    this.cache = cache;
  }

  async initialize(): Promise<void> {
    const health = await this.checkHealth();
    this.isSerenaProcessAvailable = health.source === 'installed' || health.source === 'remote';
  }

  async checkHealth(): Promise<AdapterHealth> {
    if (this.config.adapters.serena.customEndpoint) {
      return {
        available: true,
        source: 'remote',
        details: `Configured remote Serena endpoint: ${this.config.adapters.serena.customEndpoint}`,
      };
    }

    return {
      available: true,
      source: 'fallback',
      details: 'Serena adapter operating in WinCode built-in intelligent symbol analysis mode',
    };
  }

  /**
   * Finds code symbols matching a query name across the workspace
   */
  async findSymbols(query: string, kindFilter?: string): Promise<CodeSymbol[]> {
    const cacheKey = `serena_symbols_${query}_${kindFilter || 'all'}`;
    const fingerprint = await this.cache.computeWorkspaceFingerprint(this.config.workspaceRoot);

    const cached = await this.cache.get<CodeSymbol[]>(cacheKey, fingerprint);
    if (cached) return cached;

    const symbols = await this.scanSymbolsLocally(query, kindFilter);
    await this.cache.set(cacheKey, symbols, { fingerprint, ttlMs: 1000 * 60 * 5 });
    return symbols;
  }

  /**
   * Finds references / usages of a given symbol name across files
   */
  async findReferences(symbolName: string): Promise<SymbolReference[]> {
    const cacheKey = `serena_refs_${symbolName}`;
    const fingerprint = await this.cache.computeWorkspaceFingerprint(this.config.workspaceRoot);

    const cached = await this.cache.get<SymbolReference[]>(cacheKey, fingerprint);
    if (cached) return cached;

    const refs = await this.scanReferencesLocally(symbolName);
    await this.cache.set(cacheKey, refs, { fingerprint, ttlMs: 1000 * 60 * 5 });
    return refs;
  }

  /**
   * High-speed built-in symbol parser supporting C#, TypeScript/JavaScript, and Python
   */
  private async scanSymbolsLocally(query: string, kindFilter?: string): Promise<CodeSymbol[]> {
    const root = this.config.workspaceRoot;
    const results: CodeSymbol[] = [];
    const lowerQuery = query.toLowerCase();

    const ignoredDirs = new Set(['node_modules', 'bin', 'obj', 'dist', '.git', '.vs', 'trash', '.cache', '.deps']);

    const walk = async (dir: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (ignoredDirs.has(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (['.cs', '.ts', '.js', '.py'].includes(ext)) {
            const relPath = path.relative(root, fullPath);
            try {
              const content = await fs.readFile(fullPath, 'utf-8');
              const fileSymbols = this.parseFileSymbols(content, relPath, ext);

              for (const sym of fileSymbols) {
                if (sym.name.toLowerCase().includes(lowerQuery)) {
                  if (!kindFilter || sym.kind.toLowerCase() === kindFilter.toLowerCase()) {
                    results.push(sym);
                  }
                }
              }
            } catch {
              // Ignore unreadable
            }
          }
        }
      }
    };

    await walk(root);
    return results;
  }

  private parseFileSymbols(content: string, relPath: string, ext: string): CodeSymbol[] {
    const symbols: CodeSymbol[] = [];
    const lines = content.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const lineNum = i + 1;

      // C# symbol patterns
      if (ext === '.cs') {
        const classMatch = trimmed.match(/(?:public|private|protected|internal)?\s*(?:static|abstract|sealed|partial)?\s*class\s+([A-Za-z0-9_]+)/);
        if (classMatch) {
          symbols.push({ name: classMatch[1], kind: 'class', file: relPath, line: lineNum, signature: trimmed });
          continue;
        }

        const structMatch = trimmed.match(/(?:public|private|protected|internal)?\s*(?:readonly|ref)?\s*struct\s+([A-Za-z0-9_]+)/);
        if (structMatch) {
          symbols.push({ name: structMatch[1], kind: 'struct', file: relPath, line: lineNum, signature: trimmed });
          continue;
        }

        const enumMatch = trimmed.match(/(?:public|private|protected|internal)?\s*enum\s+([A-Za-z0-9_]+)/);
        if (enumMatch) {
          symbols.push({ name: enumMatch[1], kind: 'enum', file: relPath, line: lineNum, signature: trimmed });
          continue;
        }

        const interfaceMatch = trimmed.match(/(?:public|private|protected|internal)?\s*interface\s+([A-Za-z0-9_]+)/);
        if (interfaceMatch) {
          symbols.push({ name: interfaceMatch[1], kind: 'interface', file: relPath, line: lineNum, signature: trimmed });
          continue;
        }

        const methodMatch = trimmed.match(/(?:public|private|protected|internal)\s+(?:async\s+)?(?:static\s+|virtual\s+|override\s+|sealed\s+)?([A-Za-z0-9_<>?, \[\]]+)\s+([A-Za-z0-9_]+)\s*\(/);
        if (methodMatch && !['if', 'for', 'while', 'switch', 'using', 'catch'].includes(methodMatch[2])) {
          symbols.push({ name: methodMatch[2], kind: 'method', file: relPath, line: lineNum, signature: trimmed });
          continue;
        }
      }

      // TypeScript / JavaScript symbol patterns
      if (ext === '.ts' || ext === '.js') {
        const classMatch = trimmed.match(/(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_]+)/);
        if (classMatch) {
          symbols.push({ name: classMatch[1], kind: 'class', file: relPath, line: lineNum, signature: trimmed });
          continue;
        }

        const interfaceMatch = trimmed.match(/(?:export\s+)?interface\s+([A-Za-z0-9_]+)/);
        if (interfaceMatch) {
          symbols.push({ name: interfaceMatch[1], kind: 'interface', file: relPath, line: lineNum, signature: trimmed });
          continue;
        }

        const enumMatch = trimmed.match(/(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z0-9_]+)/);
        if (enumMatch) {
          symbols.push({ name: enumMatch[1], kind: 'enum', file: relPath, line: lineNum, signature: trimmed });
          continue;
        }

        const typeMatch = trimmed.match(/(?:export\s+)?type\s+([A-Za-z0-9_]+)\s*=/);
        if (typeMatch) {
          symbols.push({ name: typeMatch[1], kind: 'type', file: relPath, line: lineNum, signature: trimmed });
          continue;
        }

        const funcMatch = trimmed.match(/(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/);
        if (funcMatch) {
          symbols.push({ name: funcMatch[1], kind: 'function', file: relPath, line: lineNum, signature: trimmed });
          continue;
        }

        const arrowFuncMatch = trimmed.match(/(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::\s*[^=]+)?\s*=>/);
        if (arrowFuncMatch) {
          symbols.push({ name: arrowFuncMatch[1], kind: 'function', file: relPath, line: lineNum, signature: trimmed });
          continue;
        }

        const classMethodMatch = trimmed.match(/^(?:public|private|protected)?\s*(?:static\s+)?(?:async\s+)?([A-Za-z0-9_]+)\s*\([^)]*\)\s*(?::\s*[^;{]+)?\s*\{/);
        if (classMethodMatch && !['if', 'for', 'while', 'switch', 'constructor', 'catch'].includes(classMethodMatch[1])) {
          symbols.push({ name: classMethodMatch[1], kind: 'method', file: relPath, line: lineNum, signature: trimmed });
          continue;
        }
      }

      // Python symbol patterns
      if (ext === '.py') {
        const classMatch = trimmed.match(/^class\s+([A-Za-z0-9_]+)/);
        if (classMatch) {
          symbols.push({ name: classMatch[1], kind: 'class', file: relPath, line: lineNum, signature: trimmed });
          continue;
        }

        const defMatch = trimmed.match(/^(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*\(/);
        if (defMatch) {
          symbols.push({ name: defMatch[1], kind: 'function', file: relPath, line: lineNum, signature: trimmed });
          continue;
        }
      }
    }

    return symbols;
  }

  private async scanReferencesLocally(symbolName: string): Promise<SymbolReference[]> {
    const root = this.config.workspaceRoot;
    const refs: SymbolReference[] = [];
    const ignoredDirs = new Set(['node_modules', 'bin', 'obj', 'dist', '.git', '.vs', 'trash', '.cache', '.deps']);

    const regex = new RegExp(`\\b${symbolName}\\b`);

    const walk = async (dir: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (ignoredDirs.has(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (['.cs', '.ts', '.js', '.py', '.xaml', '.xml', '.json', '.md'].includes(ext)) {
            const relPath = path.relative(root, fullPath);
            try {
              const content = await fs.readFile(fullPath, 'utf-8');
              const lines = content.split(/\r?\n/);

              for (let i = 0; i < lines.length; i++) {
                if (regex.test(lines[i])) {
                  refs.push({
                    symbolName,
                    file: relPath,
                    line: i + 1,
                    preview: lines[i].trim(),
                  });
                  if (refs.length >= 200) return; // Cap at 200 references to prevent bloating
                }
              }
            } catch {
              // Ignore unreadable
            }
          }
        }
      }
    };

    await walk(root);
    return refs;
  }

  async dispose(): Promise<void> {}
}
