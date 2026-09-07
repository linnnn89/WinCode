$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class RecordingProbe {
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string cls,string title);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr v);
}
"@
[void][RecordingProbe]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))
$helperPath = Join-Path $PSScriptRoot '../tools/WinCode.UIA.Host/bin/Release/net10.0-windows/win-x64/publish/WinCode.UIA.Host.exe'
function Check-Notice([string]$Action, [bool]$KillEarly) {
 $info = [Diagnostics.ProcessStartInfo]::new($helperPath)
 $info.UseShellExecute=$false; $info.CreateNoWindow=$true
 $info.RedirectStandardInput=$true; $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true
 $before=[RecordingProbe]::GetForegroundWindow()
 $process=[Diagnostics.Process]::Start($info)
 try {
  $class='WinCoding.Recording.'+$process.Id
  $process.StandardInput.WriteLine((@{action=$Action;pid=2147483647;capture='none'}|ConvertTo-Json -Compress))
  $process.StandardInput.Close()
  $seen=$false; $deadline=[DateTime]::UtcNow.AddSeconds(4)
  while(-not $process.HasExited -and [DateTime]::UtcNow -lt $deadline) {
   $handle=[RecordingProbe]::FindWindow($class,'WinCoding Recording')
   if($handle -ne [IntPtr]::Zero -and [RecordingProbe]::IsWindowVisible($handle)) {
    $seen=$true
    if($KillEarly){$process.Kill();break}
   }
   Start-Sleep -Milliseconds 10
  }
  if(-not $process.WaitForExit(2000)){throw 'Helper did not exit'}
  if(($Action -eq 'health') -eq $seen){throw "Unexpected indicator presence for $Action"}
  if([RecordingProbe]::FindWindow($class,'WinCoding Recording') -ne [IntPtr]::Zero){throw 'Orphan indicator remained'}
  $response=$process.StandardOutput.ReadToEnd()
  if(-not $KillEarly) {
   $result=$response|ConvertFrom-Json
   if($result.errorCode -eq 'HOST_ERROR'){throw $result.errorMessage}
  }
  [pscustomobject]@{action=$Action;killed=$KillEarly;indicatorSeen=$seen;removed=$true;foregroundUnchanged=($before -eq [RecordingProbe]::GetForegroundWindow())}
 } finally {if(-not $process.HasExited){$process.Kill();$process.WaitForExit()};$process.Dispose()}
}
# No target applications opened or read. An absent PID exercises the error path after notice display.
@(Check-Notice 'inspect' $false; Check-Notice 'listWindows' $false; Check-Notice 'inspect' $true; Check-Notice 'health' $false)|ConvertTo-Json
