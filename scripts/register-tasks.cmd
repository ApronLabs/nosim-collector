@echo off
REM 작업 스케줄러 등록 (한 번에). 더블클릭 또는 cmd 실행.
REM  NosimSalesCollect : 30분마다 24시간 항상 실행. 매장별 영업일(closingTime cutoff) 기준으로
REM    "현재 영업일"을 매번 재수집(노심 upsert 가 덮어씀). 새벽 마감 매장(월하화 02:00→cutoff 3)은
REM    자정~03:00 에도 현재 영업일=전날 이라 마감 후에도 수집돼 자연히 완전값이 됨. 시간 윈도우 없음.
cd /d "%~dp0.."

echo 매장별 영업일 자동수집 작업 (NosimSalesCollect) 등록...
powershell -ExecutionPolicy Bypass -File "scripts\register-collect-task.ps1" -Time "00:00" -EveryMinutes 30 -ForHours 24

echo.
echo 완료. 작업 목록 확인: 작업 스케줄러(taskschd.msc)
echo 기존 NosimSalesCollectToday / NosimSalesCollectFinalize 작업이 있으면 제거하세요:
echo   Unregister-ScheduledTask -TaskName "NosimSalesCollectToday" -Confirm:$false
echo   Unregister-ScheduledTask -TaskName "NosimSalesCollectFinalize" -Confirm:$false
pause
