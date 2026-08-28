@echo off
rem ============================================================
rem  StayOps Local Development Runtime (unified local dev entry)
rem
rem  Usage:
rem    start-dev.cmd            preflight -> migration check -> start
rem                             backend+frontend -> readiness -> summary
rem    start-dev.cmd --check    checks only (git/ports/config/files/migration)
rem    start-dev.cmd --migrate  run alembic upgrade head when behind, then start
rem
rem  Notes:
rem    - no PowerShell required (.cmd entry)
rem    - ports 8000/3000 occupied -> FAIL FAST (shows PID, never kills
rem      unknown processes)
rem    - dev DB migration behind -> stop with instructions (CHECK ONLY)
rem    - Ctrl+C stops both Backend and Frontend process trees
rem ============================================================
setlocal
cd /d "%~dp0"

if not exist "backend\.venv\Scripts\python.exe" (
    echo [ERROR] backend\.venv\Scripts\python.exe not found.
    echo         Prepare the backend virtualenv per README first.
    exit /b 1
)

"backend\.venv\Scripts\python.exe" "scripts\dev_runtime.py" %*
set EXITCODE=%ERRORLEVEL%
endlocal & exit /b %EXITCODE%
