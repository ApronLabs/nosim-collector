<#
  노심 매출 자동수집 — 통합 관리 콘솔 (Windows)

  더블클릭 한 번으로 배포 / 자동수집 켜고끄기 / 테스트 / 상태확인을 메뉴로 처리한다.
  진입점은 repo 루트의 nosim.cmd (이 스크립트를 -Action menu 로 호출).

  파일 인코딩: UTF-8 with BOM. PowerShell 5.1 이 BOM 을 보고 UTF-8 로 디코딩해야
  한글 메시지가 안 깨진다 (BOM 없으면 CP949 로 읽어 깨짐). 작업 이름은 ASCII 고정.

  단독 실행도 가능:
    powershell -ExecutionPolicy Bypass -File scripts\collect-control.ps1 -Action deploy
    powershell -ExecutionPolicy Bypass -File scripts\collect-control.ps1 -Action status
#>
param(
  [ValidateSet('menu', 'deploy', 'on', 'off', 'test', 'dry', 'status', 'reset-cooldown', 'inspect', 'ui-test', 'login-dom')]
  [string]$Action = 'menu'
)

$ErrorActionPreference = 'Stop'
$TaskName = 'NosimSalesCollect'
$OldTaskNames = @('NosimSalesCollectToday', 'NosimSalesCollectFinalize')
$repo = Split-Path -Parent $PSScriptRoot
$script = Join-Path $repo 'scripts\collect-stores.js'

# ─── 출력 헬퍼 (색상 + ASCII 태그. 이모지는 CP949 콘솔에서 깨져서 안 씀) ───
function Write-Title($m) {
  Write-Host ''
  Write-Host ('=' * 52) -ForegroundColor DarkCyan
  Write-Host "  $m" -ForegroundColor White
  Write-Host ('=' * 52) -ForegroundColor DarkCyan
}
function Write-Step($m) { Write-Host "`n>> $m" -ForegroundColor Cyan }
function Write-Ok($m)   { Write-Host "   [OK]  $m" -ForegroundColor Green }
function Write-Note($m) { Write-Host "   [!]   $m" -ForegroundColor Yellow }
function Write-Bad($m)  { Write-Host "   [X]   $m" -ForegroundColor Red }
function Write-Dim($m)  { Write-Host "         $m" -ForegroundColor Gray }

# ─── git 헬퍼 (네이티브 명령은 $LASTEXITCODE 로 성공 판정) ───
function Invoke-Git {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$GitArgs)
  # git 은 정상 진행상황도 stderr 로 쓴다. $ErrorActionPreference='Stop' + 2>&1 이면
  # PS5.1 이 그걸 NativeCommandError 로 throw 하므로, 이 호출 동안만 Continue 로 낮춘다.
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & git @GitArgs 2>&1
    $code = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $old
  }
  return [pscustomobject]@{ Code = $code; Out = (($out | ForEach-Object { "$_" }) -join "`n") }
}
function Get-HeadShort { (Invoke-Git rev-parse --short HEAD).Out.Trim() }
function Get-HeadSubject { (Invoke-Git log -1 --format=%s).Out.Trim() }

function Assert-Tools {
  foreach ($t in @('node', 'git')) {
    if (-not (Get-Command $t -ErrorAction SilentlyContinue)) {
      throw "$t 가 PATH 에 없습니다. Node.js LTS / Git 설치를 먼저 하세요."
    }
  }
}

# ─── 작업 등록 여부 한 줄 상태 ───
function Get-TaskState {
  $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($t) { return $t.State.ToString() } else { return $null }
}

# ─── 배포: git pull (+ 필요시 npm install) ───
function Invoke-Deploy {
  Write-Title '배포 — 최신 코드 받기'
  Assert-Tools
  Set-Location $repo

  $dirty = (Invoke-Git status --porcelain).Out.Trim()
  if ($dirty) {
    Write-Note '로컬에 저장 안 된 변경이 있습니다:'
    $dirty.Split("`n") | ForEach-Object { Write-Dim $_ }
    Write-Note 'config 를 직접 고쳤다면 pull 전에 정리가 필요할 수 있습니다. 그대로 진행합니다.'
  }

  $before = Get-HeadShort
  Write-Step '현재 버전'
  Write-Dim "$before  $(Get-HeadSubject)"

  Write-Step '원격 변경 확인'
  $f = Invoke-Git fetch origin --quiet
  if ($f.Code -ne 0) { Write-Bad "git fetch 실패: $($f.Out)"; return }
  $behind = (Invoke-Git rev-list --count 'HEAD..origin/main').Out.Trim()
  if ($behind -eq '0') { Write-Ok '이미 최신입니다. 받을 변경 없음.'; return }
  Write-Dim "새 커밋 $behind 개"

  # package.json/lock 변경 → npm install 필요
  $pkgChanged = (Invoke-Git diff --name-only 'HEAD..origin/main').Out -match 'package(-lock)?\.json'

  Write-Step 'git pull'
  $p = Invoke-Git pull origin main --quiet
  if ($p.Code -ne 0) {
    Write-Bad 'git pull 실패:'
    $p.Out.Split("`n") | ForEach-Object { Write-Dim $_ }
    Write-Note '로컬 변경 충돌이면: 작업한 config 백업 후 git checkout -- . 로 되돌리고 다시 배포.'
    return
  }
  Write-Ok "코드 갱신: $before -> $(Get-HeadShort)"
  Write-Dim (Get-HeadSubject)

  if ($pkgChanged) {
    Write-Step '의존성 변경 감지 — npm install'
    npm install
    if ($LASTEXITCODE -ne 0) { Write-Bad 'npm install 실패 — 위 메시지를 확인하세요.'; return }
    Write-Ok '의존성 설치 완료'
  }
  else {
    Write-Dim '의존성 변경 없음 — npm install 생략'
  }
  Write-Ok '배포 완료'
  if (Get-TaskState) { Write-Dim '자동수집이 켜져 있어 다음 30분 틱부터 새 코드로 수집합니다.' }
  else { Write-Note '자동수집이 꺼져 있습니다. 메뉴 [2] 로 켜세요.' }
}

# ─── 자동수집 켜기: 구작업 정리 + 등록 ───
function Invoke-On {
  Write-Title '자동수집 켜기 — 30분마다 자동 실행 등록'
  Assert-Tools
  foreach ($old in $OldTaskNames) {
    if (Get-ScheduledTask -TaskName $old -ErrorAction SilentlyContinue) {
      Unregister-ScheduledTask -TaskName $old -Confirm:$false -ErrorAction SilentlyContinue
      Write-Dim "구버전 작업 제거: $old"
    }
  }
  & (Join-Path $PSScriptRoot 'register-collect-task.ps1') -Time '00:00' -EveryMinutes 30 -ForHours 24
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Write-Ok '자동수집 켜짐 — 30분마다 현재 영업일을 자동 수집합니다.'
    Write-Dim '전제: PC 자동로그인 + 절전/화면잠금 끔 (쿠팡 --show 창이 떠야 함).'
  }
  else { Write-Bad '등록 실패 — 위 메시지를 확인하세요.' }
}

# ─── 자동수집 끄기 ───
function Invoke-Off {
  Write-Title '자동수집 끄기 — 자동 실행 해제'
  if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
    Write-Dim '등록된 자동수집 작업이 없습니다 (이미 꺼짐).'
    return
  }
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Ok '자동수집 해제 완료 — 더 이상 자동으로 돌지 않습니다.'
  Write-Dim '다시 켜려면 메뉴 [2]. 수동 수집은 메뉴 [4] 로 가능합니다.'
}

# ─── 테스트 수집 (실제 / dry-run) ───
function Invoke-Test {
  param([switch]$Dry)
  if ($Dry) { Write-Title '점검 (dry-run) — 로그인/계정조회만, 수집 안 함' }
  else { Write-Title '지금 수집 — 현재 영업일 1회' }
  Assert-Tools
  Set-Location $repo
  if (-not (Test-Path $script)) { Write-Bad "수집 스크립트 없음: $script"; return }
  $node = (Get-Command node).Source
  $nargs = @($script)
  if ($Dry) {
    $nargs += '--dry-run'
  }
  else {
    # 수동 실행은 쿨다운/간격을 무시하고 즉시 수집 (지터도 생략)
    $nargs += '--force'
    Write-Dim '수동 실행: 쿨다운/간격 무시하고 지금 바로 수집합니다.'
  }
  & $node @nargs
  Write-Host ''
  if ($LASTEXITCODE -eq 0) { Write-Ok '완료' } else { Write-Note "일부 매장 실패 (exit $LASTEXITCODE) — 위 로그 확인" }
  $today = (Get-Date).ToString('yyyy-MM-dd')
  Write-Dim "상세 로그: collect-logs\collect-$today.log"
}

# ─── 상태 보기 ───
function Invoke-Status {
  Write-Title '상태 보기'
  Set-Location $repo

  Write-Step '자동수집 작업'
  $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($t) {
    $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
    Write-Ok "켜짐 (상태: $($t.State))"
    if ($info) {
      Write-Dim "마지막 실행: $($info.LastRunTime)   결과코드: $($info.LastTaskResult) (0=정상)"
      Write-Dim "다음 실행:   $($info.NextRunTime)"
    }
  }
  else { Write-Note '꺼짐 (작업 미등록) — 메뉴 [2] 로 켜세요.' }

  Write-Step '코드 버전'
  if (Get-Command git -ErrorAction SilentlyContinue) {
    Invoke-Git fetch origin --quiet | Out-Null
    Write-Dim "현재: $(Get-HeadShort)  $(Get-HeadSubject)"
    $behind = (Invoke-Git rev-list --count 'HEAD..origin/main').Out.Trim()
    if ($behind -and $behind -ne '0') { Write-Note "원격보다 $behind 커밋 뒤처짐 — 메뉴 [1] 배포 권장" }
    else { Write-Ok '최신' }
  }
  else { Write-Dim 'git 없음 — 버전 확인 생략' }

  Write-Step '오늘 수집 로그 (마지막 25줄)'
  $today = (Get-Date).ToString('yyyy-MM-dd')
  $logFile = Join-Path $repo "collect-logs\collect-$today.log"
  if (Test-Path $logFile) { Get-Content $logFile -Tail 25 | ForEach-Object { Write-Dim $_ } }
  else { Write-Dim '오늘 로그 없음 (아직 수집 안 함 / 날짜 바뀜)' }

  Write-Step '쿠팡 쿨다운 상태'
  $cd = Join-Path $env:USERPROFILE '.collect-stores-cooldown.json'
  if (Test-Path $cd) {
    $raw = (Get-Content $cd -Raw).Trim()
    if ($raw -and $raw -ne '{}') {
      Write-Note '쿨다운/간격 대기 중인 항목이 있습니다:'
      $raw.Split("`n") | ForEach-Object { Write-Dim $_ }
    }
    else { Write-Ok '쿨다운 없음 (정상)' }
  }
  else { Write-Ok '쿨다운 없음 (정상)' }
}

# ─── 쿠팡 쿨다운 초기화 ───
function Invoke-ResetCooldown {
  Write-Title '쿠팡 쿨다운 초기화'
  $cd = Join-Path $env:USERPROFILE '.collect-stores-cooldown.json'
  if (Test-Path $cd) {
    Remove-Item $cd -Force
    Write-Ok '쿨다운 파일 삭제 — 다음 수집에서 쿠팡을 즉시 재시도합니다.'
  }
  else { Write-Dim '쿨다운 파일 없음 — 이미 초기 상태입니다.' }
  Write-Note '주의: 방금 차단(throttle) 당한 직후면 초기화해도 다시 막힙니다. 40분 쉰 뒤 시도하세요.'
}

# ─── 쿠팡 화면 진단 (개발용) — UI-구동 수집 설계 위해 주문페이지 DOM/XHR 덤프 ───
function Invoke-InspectCoupang {
  Write-Title '쿠팡 화면 진단 (개발용)'
  Assert-Tools
  Set-Location $repo
  Write-Dim '평소처럼 수집하면서 쿠팡 주문페이지의 버튼/날짜/페이지네이션 구조를 떠서 파일에 기록합니다.'
  Write-Dim '쿠팡 창이 뜨면 (세션 만료 시) 로그인해 주세요. 수집 자체는 정상 진행됩니다.'
  $node = (Get-Command node).Source
  & $node 'scripts\collect-stores.js' '--inspect-coupang' '--force'
  Write-Host ''
  $f = Join-Path $repo 'scripts\coupang-inspect.txt'
  if (Test-Path $f) {
    Write-Ok "진단 파일 생성됨: $f"
    Write-Note '이 파일(scripts\coupang-inspect.txt) 내용을 개발자(클로드)에게 그대로 붙여주세요.'
  }
  else { Write-Bad '진단 파일이 안 생겼습니다 — 쿠팡 수집이 로그인 단계에서 멈췄을 수 있어요.' }
}

# ─── 쿠팡 UI-구동 수집 1회 테스트 ───
function Invoke-UiTest {
  Write-Title '쿠팡 UI-구동 수집 테스트 (1회)'
  Assert-Tools
  Set-Location $repo
  Write-Dim '쿠팡을 페이지 자체 조회 + 실제 다음버튼 클릭(가장 사람다움)으로 1회 수집합니다.'
  Write-Dim '쿠팡 창이 뜨면 (세션 만료 시) 로그인해 주세요. 화면이 바뀌어 실패하면 명확한 에러가 뜹니다.'
  $node = (Get-Command node).Source
  & $node 'scripts\collect-stores.js' '--ui-drive' '--force'
  Write-Host ''
  if ($LASTEXITCODE -eq 0) {
    Write-Ok '완료 — DB에 쿠팡 매출이 들어왔는지 확인해 주세요(개발자에게 결과 공유).'
    Write-Dim '상시 적용하려면 scripts\collect-stores.config.json 의 coupangUiDrive 를 true 로.'
  }
  else { Write-Note "실패(exit $LASTEXITCODE) — 위 빨간 메시지 확인. 자동수집은 기존 방식 유지(config 안 바꿨으면)." }
}

# ─── 쿠팡 로그인화면 DOM 수집 (개발용) — '로그인 상태 유지' 체크박스 셀렉터 확정용 ───
function Invoke-LoginDom {
  Write-Title '쿠팡 로그인화면 DOM 수집 (개발용)'
  Assert-Tools
  Set-Location $repo
  Write-Dim '임시 빈 세션으로 로그인 페이지만 띄워 체크박스 구조를 떠냅니다.'
  Write-Dim '지금 살아있는 쿠팡 세션은 안 건드립니다. 로그인은 하지 않습니다(창만 잠깐 뜸).'
  $node = (Get-Command node).Source
  & $node 'scripts\collect-stores.js' '--inspect-login'
  Write-Host ''
  $f = Join-Path $repo 'scripts\coupang-inspect.txt'
  if (Test-Path $f) {
    Write-Ok "생성됨: $f"
    Write-Note '이 파일의 맨 끝 LOGIN-INSPECT 섹션을 개발자(클로드)에게 그대로 붙여주세요.'
  }
  else { Write-Bad '진단 파일이 안 생겼습니다 — 위 메시지를 확인하세요.' }
}

# ─── 메뉴 루프 ───
function Show-Menu {
  while ($true) {
    Clear-Host
    $state = Get-TaskState
    $onoff = if ($state) { "켜짐 ($state)" } else { '꺼짐' }
    Write-Host ''
    Write-Host ('=' * 52) -ForegroundColor DarkCyan
    Write-Host '   노심 매출 자동수집 — 관리 콘솔' -ForegroundColor White
    Write-Host ('=' * 52) -ForegroundColor DarkCyan
    $col = if ($state) { 'Green' } else { 'Yellow' }
    Write-Host "   자동수집: " -NoNewline; Write-Host $onoff -ForegroundColor $col
    Write-Host ('-' * 52) -ForegroundColor DarkGray
    Write-Host '   1)  배포           ' -NoNewline -ForegroundColor White; Write-Host '최신 코드 받기 (git pull)' -ForegroundColor Gray
    Write-Host '   2)  자동수집 켜기  ' -NoNewline -ForegroundColor White; Write-Host '30분마다 자동 실행 등록' -ForegroundColor Gray
    Write-Host '   3)  자동수집 끄기  ' -NoNewline -ForegroundColor White; Write-Host '자동 실행 해제' -ForegroundColor Gray
    Write-Host '   4)  지금 수집      ' -NoNewline -ForegroundColor White; Write-Host '현재 영업일 1회 (테스트)' -ForegroundColor Gray
    Write-Host '   5)  점검만         ' -NoNewline -ForegroundColor White; Write-Host '로그인/계정조회만 (dry-run)' -ForegroundColor Gray
    Write-Host '   6)  상태 보기      ' -NoNewline -ForegroundColor White; Write-Host '작업/버전/로그/쿨다운' -ForegroundColor Gray
    Write-Host '   7)  쿠팡 쿨다운 초기화' -ForegroundColor White
    Write-Host '   8)  쿠팡 화면 진단   ' -NoNewline -ForegroundColor White; Write-Host '(개발용) 주문페이지 구조 떠서 파일로' -ForegroundColor Gray
    Write-Host '   9)  쿠팡 UI수집 테스트' -NoNewline -ForegroundColor White; Write-Host ' 페이지 자체조회+다음클릭으로 1회 수집' -ForegroundColor Gray
    Write-Host '  10)  쿠팡 로그인화면 DOM' -NoNewline -ForegroundColor White; Write-Host ' (개발용) 로그인 체크박스 구조만 수집' -ForegroundColor Gray
    Write-Host '   0)  종료' -ForegroundColor White
    Write-Host ('-' * 52) -ForegroundColor DarkGray
    $choice = Read-Host '   번호 선택'

    try {
      switch ($choice.Trim()) {
        '1' { Invoke-Deploy }
        '2' { Invoke-On }
        '3' { Invoke-Off }
        '4' { Invoke-Test }
        '5' { Invoke-Test -Dry }
        '6' { Invoke-Status }
        '7' { Invoke-ResetCooldown }
        '8' { Invoke-InspectCoupang }
        '9' { Invoke-UiTest }
        '10' { Invoke-LoginDom }
        '0' { return }
        default { Write-Note '1~10 또는 0 을 입력하세요.' }
      }
    }
    catch {
      Write-Bad $_.Exception.Message
    }
    Write-Host ''
    Read-Host '   계속하려면 Enter' | Out-Null
  }
}

# ─── 엔트리 ───
try {
  switch ($Action) {
    'menu'           { Show-Menu }
    'deploy'         { Invoke-Deploy }
    'on'             { Invoke-On }
    'off'            { Invoke-Off }
    'test'           { Invoke-Test }
    'dry'            { Invoke-Test -Dry }
    'status'         { Invoke-Status }
    'reset-cooldown' { Invoke-ResetCooldown }
    'inspect'        { Invoke-InspectCoupang }
    'ui-test'        { Invoke-UiTest }
    'login-dom'      { Invoke-LoginDom }
  }
}
catch {
  Write-Bad $_.Exception.Message
  exit 1
}
