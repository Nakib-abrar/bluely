; Custom NSIS hooks for Bluely's installer, included through `nsis.include` in
; electron-builder.yml (the portable target does not use it).

; Uninstall: remove the "Launch at startup" entry (Settings > General).
; Electron's app.setLoginItemSettings writes it to the current user's Run key, plus a matching
; StartupApproved value, under the name src/main/platform/win32/index.ts passes: the
; AppUserModelId, which equals appId (APP_ID here). Left behind, Windows would try to start the
; deleted Bluely.exe at every sign-in and list a broken item in Task Manager > Startup apps.
; Skipped when ${isUpdated}: an update runs the old version's uninstaller first, and the setting
; must survive updates.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${APP_ID}"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "${APP_ID}"
  ${endIf}
!macroend
