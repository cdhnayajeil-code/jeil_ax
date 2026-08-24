@echo off
REM relay.cmd — 작업 스케줄러가 부르는 진입점.
REM   작업 디렉터리를 etl 로 고정한다(_env.py 가 여기 기준으로 .env 를 찾는다).
REM   출력은 월 단위 로그에 append. 종료코드를 그대로 넘겨 스케줄러가 실패를 인지하게 한다.
setlocal

set "ROOT=E:\ai.jeil"
set "PY=%ROOT%\python312\python.exe"
set "ETL=%ROOT%\jeil_ax\10_ERP_DB연계\etl"

if not exist "%PY%"  ( echo [relay] Python 없음: %PY%  & exit /b 9 )
if not exist "%ETL%\gl_apply_demo2.py" ( echo [relay] 스크립트 없음: %ETL% & exit /b 9 )
if not exist "%ROOT%\logs" md "%ROOT%\logs"

for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMM"') do set "YM=%%i"
set "LOG=%ROOT%\logs\relay_%YM%.log"

cd /d "%ETL%" || ( echo [relay] cd 실패: %ETL% & exit /b 9 )

for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format ''yyyy-MM-dd HH:mm:ss''"') do set "TS=%%i"
>>"%LOG%" echo(
>>"%LOG%" echo ===== %TS% =====
"%PY%" gl_apply_demo2.py --queue --max 5 >>"%LOG%" 2>&1
set "RC=%ERRORLEVEL%"
>>"%LOG%" echo [relay] exit=%RC%

exit /b %RC%
