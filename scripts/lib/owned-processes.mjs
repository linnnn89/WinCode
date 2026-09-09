import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

/** 只读记录测试所有进程树；命令只插入正整数 PID，创建时间用于排除 PID 复用。 */
export function ownedProcesses(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const command = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $all = @(Get-CimInstance Win32_Process); $ids = @(${pid}); do { $more = @($all | Where-Object { $_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids }); $ids += @($more | ForEach-Object { $_.ProcessId }) } while ($more.Count -gt 0); @($all | Where-Object { $_.ProcessId -in $ids } | Select-Object ProcessId,ParentProcessId,CreationDate,Name,CommandLine) | ConvertTo-Json -Compress`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], {
    encoding: 'utf8', windowsHide: true, timeout: 20000,
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  const value = JSON.parse(result.stdout || '[]');
  return Array.isArray(value) ? value : [value];
}

/** 同时核对 PID 和创建时间；此函数只断言退出，不终止任何进程。 */
export function assertExited(processes) {
  for (const process of processes) {
    const alive = ownedProcesses(process.ProcessId).some(current =>
      current.ProcessId === process.ProcessId && current.CreationDate === process.CreationDate);
    assert.ok(!alive, `Owned process survived: ${process.ProcessId}`);
  }
}
