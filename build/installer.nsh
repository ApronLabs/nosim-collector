; Custom NSIS script for nosim-collector (구 barcode-scanner)
; electron-builder 24.13.2+ "Failed to uninstall old application files" 에러 해결
;
; 원인: 구 버전 언인스톨러를 실행하려다 프로세스 감지/파일 잠금으로 실패
; 해결: UninstallString 레지스트리 값을 삭제하여 구 언인스톨러 실행을 건너뛰고
;       파일을 직접 덮어쓰기(overwrite)로 설치
; 참고: https://github.com/electron-userland/electron-builder/issues/9593

!macro customInit
  ; ── 구 언인스톨러 레지스트리 값 제거 (64비트) ──
  SetRegView 64
  DeleteRegValue HKCU "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  DeleteRegValue HKCU "${UNINSTALL_REGISTRY_KEY}" "QuietUninstallString"
  DeleteRegValue HKLM "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  DeleteRegValue HKLM "${UNINSTALL_REGISTRY_KEY}" "QuietUninstallString"
  ; ── 구 언인스톨러 레지스트리 값 제거 (32비트) ──
  SetRegView 32
  DeleteRegValue HKCU "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  DeleteRegValue HKCU "${UNINSTALL_REGISTRY_KEY}" "QuietUninstallString"
  DeleteRegValue HKLM "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  DeleteRegValue HKLM "${UNINSTALL_REGISTRY_KEY}" "QuietUninstallString"

  ; ── 실행 중인 앱 강제 종료 ──
  nsExec::Exec 'taskkill /f /im "${APP_EXECUTABLE_FILENAME}"'
  Sleep 2000
!macroend

; 현재 사용자 모드 강제 (UAC 불필요)
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; 기존 파일 덮어쓰기 허용
!macro customInstall
  SetOverwrite on
!macroend
