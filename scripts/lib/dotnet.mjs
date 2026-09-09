import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * 统一构建与验收脚本的 SDK 选择。显式 WINCODE_DOTNET_PATH 优先，其次项目内固定版本，
 * 最后使用现有 DOTNET_HOST_PATH / PATH。只探测已安装程序，绝不下载或放宽 global.json。
 */
export function resolveDotnet(root, inherited = process.env) {
  const expected = JSON.parse(fs.readFileSync(path.join(root, 'global.json'), 'utf8')).sdk?.version;
  if (typeof expected !== 'string' || !/^\d+\.\d+\.\d+$/.test(expected)) {
    throw new Error('global.json must declare an exact stable SDK version.');
  }
  const executable = process.platform === 'win32' ? 'dotnet.exe' : 'dotnet';
  const local = path.join(root, '.deps', `dotnet-${expected}`, executable);
  const explicit = inherited.WINCODE_DOTNET_PATH;
  let dotnet;
  if (explicit !== undefined) {
    if (!explicit || !path.isAbsolute(explicit)) throw new Error('WINCODE_DOTNET_PATH must be an absolute installed dotnet path.');
    dotnet = explicit;
  } else if (fs.existsSync(local)) {
    dotnet = local;
  } else if (inherited.DOTNET_HOST_PATH) {
    dotnet = inherited.DOTNET_HOST_PATH;
  } else {
    dotnet = (inherited.PATH ?? inherited.Path ?? '').split(path.delimiter)
      .map(directory => path.join(directory.replace(/^"|"$/g, ''), executable))
      .find(candidate => path.isAbsolute(candidate) && fs.existsSync(candidate));
  }
  if (!dotnet || !path.isAbsolute(dotnet) || !fs.statSync(dotnet, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Installed .NET SDK ${expected} not found; set WINCODE_DOTNET_PATH to its dotnet executable.`);
  }
  dotnet = path.resolve(dotnet);
  const env = { ...inherited, DOTNET_ROOT: path.dirname(dotnet), DOTNET_HOST_PATH: dotnet,
    PATH: `${path.dirname(dotnet)}${path.delimiter}${inherited.PATH ?? inherited.Path ?? ''}`,
    DOTNET_CLI_HOME: inherited.DOTNET_CLI_HOME ?? path.join(root, '.deps/dotnet-cli-home'),
    NUGET_PACKAGES: inherited.NUGET_PACKAGES ?? path.join(root, '.deps/nuget-packages'),
    NUGET_HTTP_CACHE_PATH: inherited.NUGET_HTTP_CACHE_PATH ?? path.join(root, '.deps/nuget-http-cache'),
    DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' };
  // Windows 环境变量不区分大小写；只保留一个 PATH，避免子进程选回另一套 SDK。
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH' && key !== 'PATH') delete env[key];
  const result = spawnSync(dotnet, ['--version'], {
    cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 65536,
  });
  if (result.error || result.status !== 0 || result.stdout.trim() !== expected) {
    throw new Error(`Selected dotnet cannot provide SDK ${expected}: ${result.error?.message || result.stderr || result.stdout}`);
  }
  return { dotnet, env, sdkVersion: expected };
}

/** 执行有界 SDK 命令；失败保留原因，不自动安装依赖或换 SDK 重试。 */
export function runDotnet(toolchain, args, cwd, timeout = 180000) {
  const result = spawnSync(toolchain.dotnet, args, {
    cwd, env: toolchain.env, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`dotnet ${args[0]} failed: ${result.error ?? ''}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  }
  return result.stdout;
}
