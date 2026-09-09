import path from 'node:path';

export const WINCODE_VERSION = '0.13.2';

/**
 * Bounded waits for every external process/RPC. None of these may be Infinity.
 * MCP spec: implementations SHOULD establish timeouts for all sent requests.
 */
export interface WinCodeTimeouts {
  gitMs: number;
  dotnetMs: number;
  commandProbeMs: number;
  repomixHealthMs: number;
  repomixPackMs: number;
  fileScanMs: number;
  shutdownMs: number;
  healthProbeMs: number;
  flauiInspectMs: number;
}

export interface WinCodeCacheLimits {
  maxMemoryEntries: number;
  maxDiskEntries: number;
  maxMemoryBytes: number;
  maxDiskBytes: number;
  /** Skip memory+disk cache when a single value exceeds this. */
  maxEntryBytes: number;
  /** Reuse a fingerprint for this many ms to avoid repeating git status / walks. */
  fingerprintMemoMs: number;
}

/** 显式选择直接 Roslyn；入口与单配置随当前工作区解释，不会自动 restore 或回退到 Serena。 */
export interface RoslynConfig {
  enabled: boolean;
  allowProjectEvaluation: boolean;
  /** 工作区内入口 csproj 的相对路径；工作区切换后使用新根中的同一路径。 */
  project: string;
  configuration: string;
  targetFramework: string;
  /** 已安装可执行文件与已构建 Host 的绝对路径；不运行下载器或 shell 包装器。 */
  dotnetPath: string;
  hostPath: string;
  loadTimeoutMs?: number;
  queryTimeoutMs?: number;
  /** 额外构建输入的工作区相对文件路径；最多 32 项，JSON 最长 4096，不支持目录、通配符或根外路径。 */
  additionalInputs?: readonly string[];
}

export interface WinCodeConfig {
  workspaceRoot: string;
  cacheDir: string;
  trashDir: string;
  maxTokensPerContext: number;
  timeouts: WinCodeTimeouts;
  cacheLimits: WinCodeCacheLimits;
  adapters: {
    roslyn?: RoslynConfig;
    repomix: {
      useCli: boolean;
      /** Absolute installed JavaScript CLI entry (.js/.cjs/.mjs), never a shell wrapper. */
      customCliPath?: string;
    };
    flaui: {
      enabled: boolean;
      hostMode?: 'release' | 'development';
      customHostPath?: string;
      timeoutMs?: number;
      maxDepth?: number;
      maxNodes?: number;
    };
  };
  windows: {
    preferDotNetTools: boolean;
    dotNetSdkPath?: string;
  };
}

export function getDefaultTimeouts(): WinCodeTimeouts {
  return {
    gitMs: 5_000,
    dotnetMs: 5_000,
    commandProbeMs: 1_500,
    repomixHealthMs: 3_000,
    repomixPackMs: 30_000,
    fileScanMs: 20_000,
    shutdownMs: 8_000,
    healthProbeMs: 3_000,
    flauiInspectMs: 10_000,
  };
}

export function getDefaultCacheLimits(): WinCodeCacheLimits {
  return {
    maxMemoryEntries: 500,
    maxDiskEntries: 500,
    maxMemoryBytes: 32 * 1024 * 1024,
    maxDiskBytes: 128 * 1024 * 1024,
    maxEntryBytes: 2 * 1024 * 1024,
    fingerprintMemoMs: 2_500,
  };
}

export function getDefaultConfig(workspaceRoot?: string): WinCodeConfig {
  const root = workspaceRoot ? path.resolve(workspaceRoot) : process.cwd();
  const cacheLimits = getDefaultCacheLimits();
  return {
    workspaceRoot: root,
    cacheDir: path.join(root, '.cache', 'wincode'),
    trashDir: path.join(root, 'trash'),
    maxTokensPerContext: 128000,
    timeouts: getDefaultTimeouts(),
    cacheLimits,
    adapters: {
      repomix: {
        useCli: true,
      },
      flaui: {
        enabled: true,
        hostMode: 'release',
      },
    },
    windows: {
      preferDotNetTools: process.platform === 'win32',
    },
  };
}
