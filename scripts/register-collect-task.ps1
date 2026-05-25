# Register the daily sales-collection Windows Scheduled Task.
#
# NOTE: This script is intentionally ASCII-only. Windows PowerShell 5.1 reads
# BOM-less .ps1 files using the system ANSI code page (e.g. CP949 on Korean
# Windows), which corrupts non-ASCII string literals. A corrupted (Korean)
# task name caused registration to fail with HRESULT 0x8007007B
# (ERROR_INVALID_NAME). Keep names/messages ASCII to stay safe.
#
# Runs `node scripts\collect-stores.js` daily in the logged-on INTERACTIVE
# session (so the coupangeats --show window and baemin captcha can render).
# The PC must therefore auto-login and stay awake (sleep/lock off).
#
# Usage (no admin needed - registers the current user's own task):
#   powershell -ExecutionPolicy Bypass -File scripts\register-collect-task.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\register-collect-task.ps1 -Time "11:00"
#
# Remove:
#   Unregister-ScheduledTask -TaskName "NosimSalesCollect" -Confirm:$false

param(
  [string]$Time = "11:00",
  [string]$TaskName = "NosimSalesCollect"
)

$ErrorActionPreference = "Stop"

# parent of scripts\ = repo root
$repo   = Split-Path -Parent $PSScriptRoot
$script = Join-Path $repo "scripts\collect-stores.js"

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { throw "node not found on PATH. Install Node.js LTS first." }
$node = $nodeCmd.Source

if (-not (Test-Path $script)) { throw "collect script not found: $script" }

$action  = New-ScheduledTaskAction -Execute $node -Argument "`"$script`"" -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At $Time
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
  -MultipleInstances IgnoreNew
# Interactive: run in the logged-on user's desktop session so windows/captcha show
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName `
  -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

Write-Host "[OK] Scheduled task '$TaskName' registered" -ForegroundColor Green
Write-Host "     Daily at $Time, in logged-on user ($env:USERNAME) session" -ForegroundColor Green
Write-Host "     node:   $node"
Write-Host "     script: $script"
Write-Host ""
Write-Host "Test now:  Start-ScheduledTask -TaskName `"$TaskName`""
