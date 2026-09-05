@echo off
set NO_ANIMATIONS=1
where wt >nul 2>nul
if "%ERRORLEVEL%"=="0" (
    wt --title Codewhale cmd /k "%~dp0codewhale.exe"
) else (
    "%~dp0codewhale.exe"
)
