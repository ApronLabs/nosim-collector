# 매장별 매출 자동 수집 — Windows 작업 스케줄러 등록
#
# 매일 정해진 시각에 node scripts\collect-stores.js 를 "로그온한 사용자 세션"에서 실행.
# coupangeats(--show) 창과 baemin 캡차가 화면에 떠야 하므로 반드시 Interactive 세션이어야 함
# (LogonType Interactive). 따라서 이 PC 는 자동 로그인 + 화면 켜둠(절전 OFF) 상태여야 한다.
#
# 사용 (관리자 PowerShell 불필요, 본인 작업만 등록):
#   powershell -ExecutionPolicy Bypass -File scripts\register-collect-task.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\register-collect-task.ps1 -Time "11:00"
#
# 해제:
#   Unregister-ScheduledTask -TaskName "노심-매출자동수집" -Confirm:$false

param(
  [string]$Time = "11:00",
  [string]$TaskName = "노심-매출자동수집"
)

$ErrorActionPreference = "Stop"

# scripts\ 의 부모 = repo 루트
$repo   = Split-Path -Parent $PSScriptRoot
$script = Join-Path $repo "scripts\collect-stores.js"

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { throw "node 를 PATH 에서 찾을 수 없습니다. Node.js LTS 를 먼저 설치하세요." }
$node = $nodeCmd.Source

if (-not (Test-Path $script)) { throw "수집 스크립트를 찾을 수 없습니다: $script" }

$action  = New-ScheduledTaskAction -Execute $node -Argument "`"$script`"" -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At $Time
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
  -MultipleInstances IgnoreNew
# Interactive: 로그온한 사용자의 데스크톱 세션에서 실행 → 창/캡차가 보임
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName `
  -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

Write-Host "[OK] 작업 '$TaskName' 등록 완료" -ForegroundColor Green
Write-Host "     매일 $Time, 로그온 사용자($env:USERNAME) 세션에서 실행" -ForegroundColor Green
Write-Host "     node:   $node"
Write-Host "     script: $script"
Write-Host ""
Write-Host "지금 한 번 테스트하려면: Start-ScheduledTask -TaskName `"$TaskName`""
