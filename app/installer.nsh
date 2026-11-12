; Included by electron-builder's NSIS installer (package.json build.nsis.include).
;
; Before installing over polycli, or uninstalling it, close the polycli that runs from
; the install folder, and only that one. electron-builder's own check falls back to
; matching every polycli.exe by name: it would close a portable copy or a dev build,
; and a polycli.exe Windows can't end blocks the install for good.
; Claude sessions are background sessions, so they keep running while polycli is closed.

; A process that is ending has no path any more but still holds its files, so a
; polycli.exe without a path counts as running too (it goes away by itself).
!macro _POLYCLI_RUNNING _RESULT
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "if (Get-CimInstance Win32_Process | ? { if ($$_.ExecutablePath) { $$_.ExecutablePath.StartsWith('$INSTDIR\', 'OrdinalIgnoreCase') } else { $$_.Name -eq '${APP_EXECUTABLE_FILENAME}' } }) { exit 0 } else { exit 1 }"`
  Pop ${_RESULT}
!macroend

; force 0: ask the window to close (polycli saves its state); 1: end the processes.
!macro _POLYCLI_STOP _FORCE
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | ? { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith('$INSTDIR\', 'OrdinalIgnoreCase') } | % { if (${_FORCE}) { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue } else { $$p = Get-Process -Id $$_.ProcessId -ErrorAction SilentlyContinue; if ($$p -and $$p.MainWindowHandle -ne 0) { [void]$$p.CloseMainWindow() } } }"`
  Pop $R9
!macroend

!macro customCheckAppRunning
  !insertmacro _POLYCLI_RUNNING $R0
  ${if} $R0 == 0
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK polycli_stop
    Quit
    polycli_stop:
    DetailPrint "$(appClosing)"
    !insertmacro _POLYCLI_STOP 0
    StrCpy $R1 0
    ; polycli's processes can take a minute to go away after it closes (seen: 50 to
    ; 65 s), and until then their files can't be replaced: wait up to 150 s before asking.
    polycli_wait:
      Sleep 1000
      !insertmacro _POLYCLI_RUNNING $R0
      ${if} $R0 == 0
        IntOp $R1 $R1 + 1
        ${if} $R1 == 15
          !insertmacro _POLYCLI_STOP 1
          DetailPrint `Waiting for "${PRODUCT_NAME}" to close.`
        ${endIf}
        ${if} $R1 < 150
          Goto polycli_wait
        ${endIf}
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY polycli_retry
        Quit
        polycli_retry:
        !insertmacro _POLYCLI_STOP 1
        StrCpy $R1 120
        Goto polycli_wait
      ${endIf}
  ${endIf}
!macroend
