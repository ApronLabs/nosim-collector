@echo off
REM 작업 스케줄러 2개 등록 (한 번에). 더블클릭 또는 cmd 실행.
REM  1) NosimSalesCollect      : 어제치 백필 — 11:00부터 30분 간격 6시간, 미수집만 재시도
REM  2) NosimSalesCollectToday : 당일 실시간 — 10:00부터 30분 간격 18시간(→다음날 04:00), 항상 재수집(중복은 노심 upsert 가 방지)
cd /d "%~dp0.."

echo [1/2] 어제 백필 작업 (NosimSalesCollect) 등록...
powershell -ExecutionPolicy Bypass -File "scripts\register-collect-task.ps1"

echo.
echo [2/2] 당일 실시간 작업 (NosimSalesCollectToday) 등록...
powershell -ExecutionPolicy Bypass -File "scripts\register-collect-task.ps1" -TaskName "NosimSalesCollectToday" -ExtraArgs "--today" -Time "10:00" -EveryMinutes 30 -ForHours 18

echo.
echo 완료. 작업 목록 확인: 작업 스케줄러(taskschd.msc)
pause
