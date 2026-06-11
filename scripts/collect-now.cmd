@echo off
chcp 65001 >nul
REM 매장별 매출 수동 수집 (더블클릭 또는 CLI). 인자는 그대로 전달.
REM 백필/날짜지정 같은 인자 수집은 이 파일, 일상 운영은 repo 루트 nosim.cmd 메뉴 권장.
REM 예) collect-now.cmd                  -> 현재 영업일 전체 매장
REM     collect-now.cmd --dry-run        -> 로그인+계정조회만
REM     collect-now.cmd --targetDate=2026-05-24
cd /d "%~dp0.."
node "scripts\collect-stores.js" %*
echo.
pause
