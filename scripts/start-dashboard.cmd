@echo off
REM 수집 현황 상황판 (대시보드 모드) 실행.
REM .env 의 노심 계정으로 자동 로그인 → 매장선택 없이 바로 상황판.
REM 더블클릭 또는 시작프로그램(shell:startup)에 바로가기로 등록하면 부팅 시 자동 실행.
cd /d "%~dp0.."
npm run dashboard
