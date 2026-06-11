@echo off
REM ============================================================
REM  노심 매출 자동수집 - 관리 콘솔 (더블클릭 진입점)
REM
REM  이 파일 하나만 더블클릭하면 메뉴가 뜬다:
REM    배포(git pull) / 자동수집 켜고끄기 / 지금 수집 / 점검 / 상태
REM
REM  chcp 65001 = 콘솔을 UTF-8 로 바꿔 한글 로그가 안 깨지게 한다.
REM ============================================================
chcp 65001 >nul
title 노심 매출 수집 관리
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\collect-control.ps1" -Action menu
