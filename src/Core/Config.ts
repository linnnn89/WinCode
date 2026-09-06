import path from 'node:path';
import os from 'node:os';

export interface WinCodeConfig {
  workspaceRoot: string;
  cacheDir: string;
  trashDir: string;
  maxTokensPerContext: number;
  adapters: {
    repomix: {
      useCli: boolean;
      customCliPath?: string;
    };
    serena: {
      enabled: boolean;
      customEndpoint?: string;
      customCommand?: string;
    };
  };
  windows: {
    preferDotNetTools: boolean;
    dotNetSdkPath?: string;
  };
}

export function getDefaultConfig(workspaceRoot?: string): WinCodeConfig {
  const root = workspaceRoot ? path.resolve(workspaceRoot) : process.cwd();
  return {
    workspaceRoot: root,
    cacheDir: path.join(root, '.cache', 'wincode'),
    trashDir: path.join(root, 'trash'),
    maxTokensPerContext: 128000,
    adapters: {
      repomix: {
        useCli: true,
      },
      serena: {
        enabled: true,
      },
    },
    windows: {
      preferDotNetTools: process.platform === 'win32',
    },
  };
}
