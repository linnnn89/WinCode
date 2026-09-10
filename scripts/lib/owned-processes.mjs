import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

/** ParentProcessId survives the parent; reject edges to an older process after PID reuse. */
export function selectOwnedProcesses(all, pid) {
  const created = item => {
    const match = /^\/Date\((\d+)\)\/$/.exec(item.CreationDate ?? '');
    const value = match ? Number(match[1]) : Date.parse(item.CreationDate);
    assert.ok(Number.isFinite(value), `Missing process creation identity: ${item.ProcessId}`);
    return value;
  };
  const root = all.find(item => item.ProcessId === pid);
  if (!root) return [];
  const selected = new Map([[pid, root]]);
  created(root);
  let added;
  do {
    added = false;
    for (const item of all) {
      const parent = selected.get(item.ParentProcessId);
      if (selected.has(item.ProcessId) || !parent) continue;
      if (created(item) < created(parent)) continue;
      selected.set(item.ProcessId, item); added = true;
    }
  } while (added);
  return all.filter(item => selected.has(item.ProcessId));
}

/** 只读记录测试所有进程树；命令只插入正整数 PID，创建时间用于排除 PID 复用。 */
export function ownedProcesses(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const command = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,Name,CommandLine) | ConvertTo-Json -Compress`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], {
    encoding: 'utf8', windowsHide: true, timeout: 20000,
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  const value = JSON.parse(result.stdout || '[]');
  return selectOwnedProcesses(Array.isArray(value) ? value : [value], pid);
}

/** 同时核对 PID 和创建时间；此函数只断言退出，不终止任何进程。 */
export function assertExited(processes) {
  for (const process of processes) {
    const alive = ownedProcesses(process.ProcessId).some(current =>
      current.ProcessId === process.ProcessId && current.CreationDate === process.CreationDate);
    assert.ok(!alive, `Owned process survived: ${process.ProcessId}`);
  }
}

/** 按预先记录的每个进程身份查残留；祖先进程消失后不能再依靠完整父链找到孤儿。 */
export function observedSurvivors(processes) {
  assert.ok(processes.length <= 256);
  const ids = processes.map(process => {
    assert.ok(Number.isSafeInteger(process.ProcessId) && process.ProcessId > 0);
    return process.ProcessId;
  });
  if (!ids.length) return [];
  const command = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $ids = @(${ids.join(',')}); @((Get-CimInstance Win32_Process) | Where-Object { $_.ProcessId -in $ids } | Select-Object ProcessId,ParentProcessId,CreationDate,Name) | ConvertTo-Json -Compress`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  const value = JSON.parse(result.stdout || '[]');
  return (Array.isArray(value) ? value : [value]).filter(current =>
    processes.some(old => old.ProcessId === current.ProcessId && old.CreationDate === current.CreationDate));
}

/** 测试故障后的兜底：持有实际进程句柄再核对创建时间，绝不按名称清理或追逐复用的 PID。 */
export function terminateObserved(process) {
  assert.ok(Number.isSafeInteger(process.ProcessId) && process.ProcessId > 0);
  const timestamp = /^\/Date\((\d+)\)\/$/.exec(process.CreationDate)?.[1];
  assert.ok(timestamp && Number.isSafeInteger(Number(timestamp)), 'Expected the Windows CIM creation timestamp');
  const command = `$ErrorActionPreference = 'Stop'; $p = Get-Process -Id ${process.ProcessId} -ErrorAction SilentlyContinue; if ($p) { try { $handle = $p.SafeHandle; $created = [DateTimeOffset]::new($p.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds(); if ($created -eq ${timestamp}) { $p.Kill(); $p.WaitForExit(3000) | Out-Null; 'terminated' } } finally { $p.Dispose() } }; exit 0`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return result.stdout.trim() === 'terminated';
}
