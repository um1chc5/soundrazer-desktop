@echo off
rem Launches the app with its own console/stdio redirected to a log file rather than
rem a live console window. Confirmed on a real install: launching python.exe directly
rem from a Start Menu/Desktop shortcut (a fresh, attached console) reliably crashed
rem within a second of opening, silently; the exact same command run with stdout/
rem stderr redirected to a file instead (as this wrapper does) works every time.
rem Root cause not fully understood — this works, so it ships.
setlocal
set "SR_DIR=%~dp0"
set "SR_LOG_DIR=%LOCALAPPDATA%\SoundRazer Desktop"
if not exist "%SR_LOG_DIR%" mkdir "%SR_LOG_DIR%" >nul 2>&1
rem Keep Python's shared per-user site-packages (%APPDATA%\Python) out of the app and
rem every process it starts; setup's packages live in the app data folder instead.
set "PYTHONNOUSERSITE=1"
"%SR_DIR%runtime\python.exe" "%SR_DIR%ui_entrypoint.py" > "%SR_LOG_DIR%\launch.log" 2>&1
