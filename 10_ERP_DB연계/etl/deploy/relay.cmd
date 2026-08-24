@echo off
chcp 65001 >nul
REM ===========================================================================
REM  relay.cmd - GL relay entry point for Windows Task Scheduler.
REM
REM  ASCII ONLY - including paths. cmd.exe reads batch files in the current
REM  code page and multi-byte characters break parsing (verified 2026-08-24).
REM  Korean documentation lives in README.md and the change runbook.
REM
REM  Default  : gl_relay.exe          (single EXE, no Python on the server)
REM  Fallback : python312\python.exe + pysrc\etl\gl_apply_demo2.py
REM  Either way .env sits at %ROOT%\.env  - do not move it.
REM
REM  Exit code is propagated so the scheduler can see failures.
REM  NOTE: %ERRORLEVEL% inside a parenthesised block expands at parse time
REM        (always 0), so we branch with labels instead of if/else blocks.
REM ===========================================================================
setlocal

REM -- Deployment root. Change this one line when the server changes.
REM    Overridable via the GL_RELAY_ROOT environment variable (used for tests).
if not defined GL_RELAY_ROOT set "GL_RELAY_ROOT=E:\ai.jeil\relay"
set "ROOT=%GL_RELAY_ROOT%"

set "EXE=%ROOT%\gl_relay.exe"
set "PY=%ROOT%\python312\python.exe"
set "ETL=%ROOT%\pysrc\etl"

if not exist "%ROOT%\logs" md "%ROOT%\logs"
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMM"') do set "YM=%%i"
set "LOG=%ROOT%\logs\relay_%YM%.log"
REM  format string must contain no spaces - a quoted format with a space fails
REM  to bind as a parameter inside for/f (verified 2026-08-24, empty timestamp)
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd_HH:mm:ss"') do set "TS=%%i"

>>"%LOG%" echo(
>>"%LOG%" echo ===== %TS% =====

if exist "%EXE%" goto :run_exe
goto :run_py

:run_exe
cd /d "%ROOT%" || goto :err_cd
"%EXE%" --queue --max 5 >>"%LOG%" 2>&1
goto :done

:run_py
if not exist "%PY%" goto :err_missing
if not exist "%ETL%\gl_apply_demo2.py" goto :err_missing
cd /d "%ETL%" || goto :err_cd
"%PY%" gl_apply_demo2.py --queue --max 5 >>"%LOG%" 2>&1
goto :done

:err_missing
>>"%LOG%" echo [relay] runner not found: %EXE% / %PY%
exit /b 9

:err_cd
>>"%LOG%" echo [relay] cannot change directory
exit /b 9

:done
set "RC=%ERRORLEVEL%"
>>"%LOG%" echo [relay] exit=%RC%
exit /b %RC%
