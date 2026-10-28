; Unweave.exe — starts the app without a console window.
;
; Built by Unweave.nsis (it runs makensis on this file first); not run on its own.
;
; It runs exactly what app\launch.bat runs — the configuration confirmed working on
; a real install (see the shortcut notes in Unweave.nsis): runtime\python.exe on
; ui_entrypoint.py with stdout/stderr redirected to launch.log. Only the window
; differs: nsExec starts the command with its console hidden, so Python still has a
; real console and valid stdio (unlike pythonw.exe, whose stdio is None), and the
; FFmpeg / yt-dlp / separation subprocesses share that hidden console instead of
; each flashing a window of their own.

Unicode true
!ifndef VERSION
  !define VERSION "0.0.0"
!endif

Name "Unweave"
OutFile "build\Unweave.exe"
Icon "..\assets\icon.ico"
SilentInstall silent
RequestExecutionLevel user
ShowInstDetails nevershow

; Shown as the process name in Task Manager.
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "Unweave"
VIAddVersionKey "FileDescription" "Unweave"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "CompanyName" "um1chc5"
VIAddVersionKey "LegalCopyright" "MIT License"

Section
  ReadEnvStr $0 LOCALAPPDATA
  CreateDirectory "$0\Unweave"
  ; Same as launch.bat: keep the shared per-user site-packages out of the app.
  System::Call 'kernel32::SetEnvironmentVariable(t "PYTHONNOUSERSITE", t "1")'
  ; Waits while the app runs, so Task Manager shows Unweave for the whole session.
  nsExec::Exec '"$SYSDIR\cmd.exe" /c ""$EXEDIR\runtime\python.exe" "$EXEDIR\ui_entrypoint.py" > "$0\Unweave\launch.log" 2>&1"'
  Pop $1
SectionEnd
