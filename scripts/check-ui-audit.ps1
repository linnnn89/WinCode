param(
    [switch]$Desktop,
    [string]$Directory
)
$ErrorActionPreference = 'Stop'
# Read-only size check. No cleanup command, scheduler, admin rights or client settings changes.
$helper = Join-Path $PSScriptRoot '../tools/WinCode.UIA.Host/bin/Release/net10.0-windows/win-x64/publish/WinCode.UIA.Host.exe'
if (-not (Test-Path -LiteralPath $helper)) { throw 'Build the WinCode UIA Host first.' }
$helperArgs = @('--audit-check')
if ($Directory) { $helperArgs += @('--audit-directory', [IO.Path]::GetFullPath($Directory)) }
if ($Desktop) { $helperArgs += '--desktop-notice' }
& $helper @helperArgs
if ($LASTEXITCODE -ne 0) { throw "Audit checker exited with code $LASTEXITCODE" }
