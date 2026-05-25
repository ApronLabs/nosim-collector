@echo off
REM 매장별 매출 수동 수집 (더블클릭 또는 CLI). 인자는 그대로 전달.
REM 예) collect-now.cmd                  -> KST 어제 전체 매장
REM     collect-now.cmd --dry-run        -> 로그인+계정조회만
REM     collect-now.cmd --targetDate=2026-05-24
cd /d "%~dp0.."
node "scripts\collect-stores.js" %*
echo.
pause
