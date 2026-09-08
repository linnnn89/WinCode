import path from 'node:path';

export const WINCODE_VERSION = '0.11.3';

/**
 * Bounded waits for every external process/RPC. None of these may be Infinity.
 * MCP spec: implementations SHOULD establish timeouts for all sent requests.
 */
export interface WinCodeTimeouts {
  gitMs: number;
  dotnetMs: number;
  commandProbeMs: number;
  serenaConnectMs: number;
  serenaCallMs: number;
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

export interface WinCodeConfig {
  workspaceRoot: string;
  cacheDir: string;
  trashDir: string;
  maxTokensPerContext: number;
  timeouts: WinCodeTimeouts;
  cacheLimits: WinCodeCacheLimits;
  adapters: {
    repomix: {
      useCli: boolean;
      customCliPath?: string;
    };
    serena: {
      enabled: boolean;
      customEndpoint?: string;
      customCommand?: string;
      /** Extra argv when customCommand is an executable (e.g. node + mock script). */
      customArgs?: string[];
    };
    flaui: {
      enabled: boolean;
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
    serenaConnectMs: 8_000,
    serenaCallMs: 15_000,
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
      serena: {
        enabled: true,
      },
      flaui: {
        enabled: true,
      },
    },
    windows: {
      preferDotNetTools: process.platform === 'win32',
    },
  };
}
