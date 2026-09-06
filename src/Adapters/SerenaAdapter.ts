import fs from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { IAdapter, AdapterHealth } from './IAdapter.js';
import { WinCodeConfig } from '../Core/Config.js';
import { CacheManager } from '../Core/Cache.js';

export const SERENA_DEGRADED_LIMITATIONS: string[] = [
  '本地正则扫描仅作为文本检索降级方案，不保证符号身份、重载区分、跨文件引用完整性或安全重命名。',
  '本地正则扫描无法替代完整 Roslyn/TypeScript LSP 语义层面的跨文件重命名与重载解析。',
  '未找到引用不得直接解释为“无影响”或“低风险”。',
];

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

export interface FindSymbolsResult {
  query: string;
  kindFilter?: string;
  totalFound: number;
  symbols: CodeSymbol[];
  source: 'serena-mcp' | 'serena-adapter-fallback';
  analysisCompleteness: 'semantic' | 'degraded';
  limitations: string[];
}

export interface FindReferencesResult {
  symbolName: string;
  totalReferences: number;
  references: SymbolReference[];
  source: 'serena-mcp' | 'serena-adapter-fallback';
  analysisCompleteness: 'semantic' | 'degraded';
  limitations: string[];
}

export class SerenaAdapter implements IAdapter {
  readonly name = 'SerenaAdapter';
  readonly description = 'Semantic code intelligence, symbol search, and reference tracking via Serena MCP';

  private config: WinCodeConfig;
  private cache: CacheManager;
  private serenaClient: Client | null = null;
  private serenaTransport: StdioClientTransport | null = null;
  private isConnectedToSerena = false;
  private serenaTools: Set<string> = new Set();

  constructor(config: WinCodeConfig, cache: CacheManager) {
    this.config = config;
    this.cache = cache;
  }

  async initialize(): Promise<void> {
    await this.dispose();
    const health = await this.checkHealth();
    if (health.available && health.source === 'installed') {
      await this.tryConnectSerena();
    }
  }

  /**
   * Probes whether Serena is available as a command or configured endpoint
   */
  async checkHealth(): Promise<AdapterHealth> {
    if (this.config.adapters.serena.customEndpoint) {
      return {
        available: true,
        source: 'remote',
        details: `Configured remote Serena endpoint: ${this.config.adapters.serena.customEndpoint}`,
      };
    }

    // Check if custom command or 'serena' is on PATH
    const customCmd = this.config.adapters.serena.customCommand;
    if (customCmd) {
      return {
        available: true,
        source: 'installed',
        details: `Custom Serena command configured: ${customCmd}`,
      };
    }

    // Proactively check if 'serena' binary is available in PATH
    try {
      const checkCmd = process.platform === 'win32' ? 'where.exe serena' : 'which serena';
      const stdout = execSync(checkCmd, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500 }).toString();
      if (stdout.trim()) {
        return {
          available: true,
          source: 'installed',
          details: `Found Serena binary in system PATH: ${stdout.trim().split(/\r?\n/)[0]}`,
        };
      }
    } catch {
      // serena not in PATH, proceed to fallback mode
    }

    return {
      available: true,
      source: 'fallback',
      details: 'Serena adapter operating in WinCode built-in intelligent symbol analysis mode (fallback)',
    };
  }

  /**
   * Attempts to establish an MCP stdio connection to Serena
   */
  private async tryConnectSerena(): Promise<boolean> {
    await this.dispose();

    let transport: StdioClientTransport | null = null;
    let client: Client | null = null;

    try {
      const cmd = this.config.adapters.serena.customCommand || 'serena';
      transport = new StdioClientTransport({
        command: 'cmd',
        args: ['/c', cmd],
      });

      client = new Client(
        { name: 'wincode-serena-adapter', version: '0.1.0' },
        { capabilities: {} }
      );

      await client.connect(transport);
      const toolsList = await client.listTools();

      this.serenaTools.clear();
      for (const t of toolsList.tools) {
        this.serenaTools.add(t.name);
      }
      this.serenaTransport = transport;
      this.serenaClient = client;
      this.isConnectedToSerena = true;
      console.error(`[SerenaAdapter] Connected to upstream Serena MCP server with ${toolsList.tools.length} tools.`);
      return true;
    } catch (err) {
      if (client) {
        try {
          await client.close();
        } catch {}
      }
      if (transport) {
        try {
          await transport.close();
        } catch {}
      }
      this.serenaClient = null;
      this.serenaTransport = null;
      this.isConnectedToSerena = false;
      this.serenaTools.clear();
      return false;
    }
  }

  /**
   * Phase 4: wincode_find_code_symbol
   * Queries Serena (or fallback parser) and maps results to standard CodeSymbol[]
   */
  async findSymbols(query: string, kindFilter?: string): Promise<CodeSymbol[]> {
    const res = await this.findSymbolsDetailed(query, kindFilter);
    return res.symbols;
  }

  async findSymbolsDetailed(query: string, kindFilter?: string): Promise<FindSymbolsResult> {
    const cacheKey = `serena_symbols_${query}_${kindFilter || 'all'}_${this.config.workspaceRoot}`;
    const fingerprint = await this.cache.computeWorkspaceFingerprint(this.config.workspaceRoot);

    const cached = await this.cache.get<FindSymbolsResult>(cacheKey, fingerprint);
    if (cached) return cached;

    let symbols: CodeSymbol[] = [];
    let source: 'serena-mcp' | 'serena-adapter-fallback' = 'serena-adapter-fallback';

    const serenaToolName = ['find_symbol', 'find_symbols', 'get_symbols_overview'].find((t) =>
      this.serenaTools.has(t)
    );

    if (this.isConnectedToSerena && this.serenaClient && serenaToolName) {
      try {
        const serenaRes = await this.serenaClient.callTool({
          name: serenaToolName,
          arguments: {
            name_path_pattern: query,
            name_path: query,
            relative_path: '',
          },
        });

        const rawText = (serenaRes.content as any[])?.[0]?.text;
        const isExplicitError =
          serenaRes.isError ||
          (typeof rawText === 'string' &&
            (rawText.startsWith('Error:') || rawText.includes('没有激活项目') || rawText.includes('No active project')));

        if (isExplicitError) {
          console.warn(`[SerenaAdapter] Serena MCP ${serenaToolName} returned error:`, rawText);
        } else if (rawText) {
          symbols = this.mapSerenaSymbols(rawText, query, kindFilter);
          source = 'serena-mcp';
        }
      } catch (err) {
        console.warn('[SerenaAdapter] Serena MCP call failed, falling back to local indexing:', err);
      }
    }

    if (symbols.length === 0 && source === 'serena-adapter-fallback') {
      symbols = await this.scanSymbolsLocally(query, kindFilter);
    }

    const analysisCompleteness: 'semantic' | 'degraded' =
      source === 'serena-mcp' ? 'semantic' : 'degraded';
    const limitations =
      source === 'serena-mcp' ? [] : [...SERENA_DEGRADED_LIMITATIONS];

    const result: FindSymbolsResult = {
      query,
      kindFilter,
      totalFound: symbols.length,
      symbols,
      source,
      analysisCompleteness,
      limitations,
    };

    await this.cache.set(cacheKey, result, { fingerprint, ttlMs: 1000 * 60 * 5 });
    return result;
  }

  /**
   * Phase 4: wincode_find_references
   * Queries Serena (or fallback scanner) for all usage and call sites of a symbol
   */
  async findReferences(symbolName: string, relativePath?: string): Promise<SymbolReference[]> {
    const res = await this.findReferencesDetailed(symbolName, relativePath);
    return res.references;
  }

  async findReferencesDetailed(symbolName: string, relativePath?: string): Promise<FindReferencesResult> {
    const cacheKey = `serena_refs_${symbolName}_${relativePath || 'auto'}_${this.config.workspaceRoot}`;
    const fingerprint = await this.cache.computeWorkspaceFingerprint(this.config.workspaceRoot);

    const cached = await this.cache.get<FindReferencesResult>(cacheKey, fingerprint);
    if (cached) return cached;

    let refs: SymbolReference[] = [];
    let source: 'serena-mcp' | 'serena-adapter-fallback' = 'serena-adapter-fallback';

    const refToolName = ['find_referencing_symbols', 'find_references', 'get_references'].find((t) =>
      this.serenaTools.has(t)
    );

    if (this.isConnectedToSerena && this.serenaClient && refToolName) {
      try {
        let targetRelPath = relativePath;
        let targetNamePath = symbolName;

        // Serena's find_referencing_symbols requires relative_path.
        // If not supplied, resolve symbol definition first to determine defining file & name_path.
        if (!targetRelPath) {
          const found = await this.findSymbols(symbolName);
          const matched = found.find((s) => s.name === symbolName) || found[0];
          if (matched?.file) {
            targetRelPath = matched.file;
            if (matched.containerName) {
              targetNamePath = `${matched.containerName}/${matched.name}`;
            }
          }
        }

        if (targetRelPath) {
          const serenaRes = await this.serenaClient.callTool({
            name: refToolName,
            arguments: {
              name_path: targetNamePath,
              relative_path: targetRelPath,
            },
          });

          const rawText = (serenaRes.content as any[])?.[0]?.text;
          const isExplicitError =
            serenaRes.isError ||
            (typeof rawText === 'string' &&
              (rawText.startsWith('Error:') || rawText.includes('没有激活项目') || rawText.includes('No active project')));

          if (isExplicitError) {
            console.warn(`[SerenaAdapter] Serena MCP ${refToolName} returned error:`, rawText);
          } else if (rawText) {
            refs = this.mapSerenaReferences(rawText, symbolName);
            source = 'serena-mcp';
          }
        } else {
          console.warn(
            `[SerenaAdapter] Could not determine relative_path for symbol '${symbolName}', skipping Serena upstream and falling back to local scanner.`
          );
        }
      } catch (err) {
        console.warn('[SerenaAdapter] Serena MCP call failed, falling back to local reference scanner:', err);
      }
    }

    if (refs.length === 0 && source === 'serena-adapter-fallback') {
      refs = await this.scanReferencesLocally(symbolName);
    }

    const analysisCompleteness: 'semantic' | 'degraded' =
      source === 'serena-mcp' ? 'semantic' : 'degraded';
    const limitations =
      source === 'serena-mcp' ? [] : [...SERENA_DEGRADED_LIMITATIONS];

    const result: FindReferencesResult = {
      symbolName,
      totalReferences: refs.length,
      references: refs,
      source,
      analysisCompleteness,
      limitations,
    };

    await this.cache.set(cacheKey, result, { fingerprint, ttlMs: 1000 * 60 * 5 });
    return result;
  }

  /**
   * Maps Serena MCP response formats to WinCode CodeSymbol schema
   */
  public mapSerenaSymbols(rawText: string, query: string, kindFilter?: string): CodeSymbol[] {
    const symbols: CodeSymbol[] = [];
    try {
      const parsed = JSON.parse(rawText);
      const rawList: any[] = [];

      if (Array.isArray(parsed)) {
        rawList.push(...parsed);
      } else if (parsed && typeof parsed === 'object') {
        if (Array.isArray(parsed.symbols)) {
          rawList.push(...parsed.symbols);
        } else {
          // Support grouped structures like { "Class": [...], "Method": [...] }
          for (const val of Object.values(parsed)) {
            if (Array.isArray(val)) {
              rawList.push(...val);
            } else if (val && typeof val === 'object') {
              rawList.push(val);
            }
          }
        }
      }

      for (const item of rawList) {
        if (!item || typeof item !== 'object') continue;

        // Parse name & containerName from item.name_path or item.name
        let symbolName = item.name;
        let containerName = item.containerName;

        if (!symbolName && item.name_path) {
          const parts = String(item.name_path).split('/');
          const rawName = parts.pop() || '';
          symbolName = rawName.replace(/\[\d+\]$/, '');
          if (parts.length > 0) {
            containerName = parts.join('/');
          }
        }
        symbolName = symbolName || query;

        // Parse file / relative_path
        const file =
          item.relative_path ||
          item.file ||
          item.path ||
          item.location?.uri ||
          item.location?.relative_path ||
          '';

        // Parse line / body_location
        const line =
          item.body_location?.start_line ||
          item.line ||
          item.location?.range?.start?.line ||
          item.body_location?.start ||
          1;

        // Parse kind
        const kind = (item.kind || 'class').toLowerCase();

        // Parse signature / info
        const signature =
          item.signature ||
          item.preview ||
          (typeof item.info === 'string' ? item.info : item.info?.description) ||
          undefined;

        symbols.push({
          name: symbolName,
          kind: kind as any,
          file,
          line: typeof line === 'number' ? line : parseInt(String(line), 10) || 1,
          signature,
          containerName,
        });
      }
    } catch {
      // If plaintext output from Serena, parse line by line
      const lines = rawText.split(/\r?\n/);
      for (const l of lines) {
        const match = l.match(/(?:Symbol|Function|Class|Method):\s*([A-Za-z0-9_]+)\s+in\s+([^\s:]+):(\d+)/i);
        if (match) {
          symbols.push({
            name: match[1],
            kind: 'class',
            file: match[2],
            line: parseInt(match[3], 10),
            signature: l.trim(),
          });
        }
      }
    }

    if (kindFilter) {
      return symbols.filter((s) => s.kind.toLowerCase() === kindFilter.toLowerCase());
    }
    return symbols;
  }

  /**
   * Maps Serena MCP response formats to WinCode SymbolReference schema
   */
  public mapSerenaReferences(rawText: string, symbolName: string): SymbolReference[] {
    const refs: SymbolReference[] = [];
    try {
      const parsed = JSON.parse(rawText);

      const collectRefs = (node: any, currentPath = '') => {
        if (!node) return;

        if (Array.isArray(node)) {
          for (const item of node) {
            collectRefs(item, currentPath);
          }
          return;
        }

        if (typeof node === 'object') {
          // Detect if this object itself represents a reference leaf node
          const hasRefSignal =
            node.content_around_reference !== undefined ||
            node.body_location !== undefined ||
            node.reference_line !== undefined ||
            node.snippet !== undefined ||
            node.line_content !== undefined ||
            (node.preview !== undefined && (node.file || node.relative_path || currentPath));

          if (hasRefSignal) {
            const file = node.relative_path || node.file || node.path || currentPath || '';
            const line =
              node.reference_line ||
              node.body_location?.start_line ||
              node.line ||
              node.location?.range?.start?.line ||
              1;
            const preview =
              node.content_around_reference ||
              node.preview ||
              node.snippet ||
              node.line_content ||
              (node.name_path ? `Reference in ${node.name_path}` : '');

            refs.push({
              symbolName,
              file,
              line: typeof line === 'number' ? line : parseInt(String(line), 10) || 1,
              preview: String(preview).trim(),
            });
            return;
          }

          if (Array.isArray(node.references)) {
            collectRefs(node.references, currentPath);
            return;
          }

          for (const [key, value] of Object.entries(node)) {
            // Check if key is a file path (has extension or path separator)
            const isPathLike =
              !currentPath && (key.includes('/') || key.includes('\\') || /\.[a-zA-Z0-9]+$/i.test(key));
            const nextPath = isPathLike ? key : currentPath;
            collectRefs(value, nextPath);
          }
        }
      };

      collectRefs(parsed);
    } catch {
      // Plain text fallback parsing
      const lines = rawText.split(/\r?\n/);
      for (const l of lines) {
        const match = l.match(/([^\s:]+):(\d+):\s*(.*)/);
        if (match) {
          refs.push({
            symbolName,
            file: match[1],
            line: parseInt(match[2], 10),
            preview: match[3].trim(),
          });
        }
      }
    }
    return refs;
  }

  /**
   * Resilient built-in multi-language symbol indexer (C#, TypeScript/JS, Python)
   */
  private async scanSymbolsLocally(query: string, kindFilter?: string): Promise<CodeSymbol[]> {
    const root = this.config.workspaceRoot;
    const results: CodeSymbol[] = [];
    const lowerQuery = query.toLowerCase();

    const ignoredDirs = new Set(['node_modules', 'bin', 'obj', 'dist', '.git', '.vs', 'trash', '.cache', '.deps', '.packages', '.dotnet', '.dotnet_cli_home']);

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
    const ignoredDirs = new Set(['node_modules', 'bin', 'obj', 'dist', '.git', '.vs', 'trash', '.cache', '.deps', '.packages', '.dotnet', '.dotnet_cli_home']);

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
          const codeExts = ['.cs', '.ts', '.tsx', '.js', '.jsx', '.py', '.xaml', '.xml', '.csproj', '.sln'];
          if (codeExts.includes(ext)) {
            const relPath = path.relative(root, fullPath);
            try {
              const content = await fs.readFile(fullPath, 'utf-8');
              const lines = content.split(/\r?\n/);

              for (let i = 0; i < lines.length; i++) {
                const trimmed = lines[i].trim();
                // Exclude pure comments and documentation lines
                if (
                  trimmed.startsWith('//') ||
                  trimmed.startsWith('///') ||
                  trimmed.startsWith('*') ||
                  trimmed.startsWith('/*') ||
                  trimmed.startsWith('#') ||
                  trimmed.startsWith('<!--')
                ) {
                  continue;
                }

                // Exclude declaration line of the symbol itself
                const isDeclaration =
                  /^(?:export\s+)?(?:public|private|protected|internal\s+)?(?:static\s+|abstract\s+|sealed\s+|partial\s+)?(?:class|interface|struct|enum)\s+/i.test(trimmed) &&
                  (trimmed.includes(`class ${symbolName}`) ||
                    trimmed.includes(`interface ${symbolName}`) ||
                    trimmed.includes(`struct ${symbolName}`) ||
                    trimmed.includes(`enum ${symbolName}`));
                if (isDeclaration) {
                  continue;
                }

                if (regex.test(lines[i])) {
                  refs.push({
                    symbolName,
                    file: relPath,
                    line: i + 1,
                    preview: trimmed,
                  });
                  if (refs.length >= 200) return;
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

  async dispose(): Promise<void> {
    if (this.serenaClient) {
      try {
        await this.serenaClient.close();
      } catch {}
      this.serenaClient = null;
    }
    if (this.serenaTransport) {
      try {
        await this.serenaTransport.close();
      } catch {}
      this.serenaTransport = null;
    }
    this.isConnectedToSerena = false;
    this.serenaTools.clear();
  }
}
