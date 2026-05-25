@echo off
REM Electron 바이너리 세팅 (사무실 네트워크가 npm 자동 다운로드를 막을 때).
REM 더블클릭 또는 cmd 에서 실행. 받아둔 zip 자동 재활용 + 위치 정리 + path.txt 생성.
cd /d "%~dp0.."
powershell -ExecutionPolicy Bypass -File "scripts\setup-electron-win.ps1" %*
echo.
pause
