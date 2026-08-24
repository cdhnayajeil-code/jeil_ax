<#
  install.ps1 — ERP 서버에 결의전표 릴레이 실행환경을 만든다.

  하는 일: 폴더 생성 → Python 3.12 전용 설치(시스템 PATH 미변경) → pyodbc 설치 → 점검.
  하지 않는 일: .env 작성(비밀값이라 사람이 서버에서 직접), 스크립트 복사, 작업 등록.

  사용:
    .\install.ps1 -PythonInstaller .\python-3.12.10-amd64.exe
    .\install.ps1 -PythonInstaller .\python-3.12.10-amd64.exe -WheelDir E:\ai.jeil\wheels
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$PythonInstaller,
  [string]$Root = "E:\ai.jeil",
  [string]$WheelDir                       # pypi 가 막혔을 때 오프라인 휠 경로
)

$ErrorActionPreference = "Stop"

function Step($m) { Write-Host "`n=== $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "    OK  $m" -ForegroundColor Green }
function Warn($m) { Write-Host "    !   $m" -ForegroundColor Yellow }

if (-not (Test-Path $PythonInstaller)) { throw "설치 파일을 찾을 수 없습니다: $PythonInstaller" }

$py    = Join-Path $Root "python312\python.exe"
$etl   = Join-Path $Root "jeil_ax\10_ERP_DB연계\etl"
$logs  = Join-Path $Root "logs"

Step "폴더 생성"
# _env.py 가 .env 를 '스크립트 기준 두 단계 위'에서 찾는다 — 저장소 구조를 그대로 만든다
New-Item -ItemType Directory -Force -Path $etl, $logs | Out-Null
Ok $etl
Ok $logs

Step "Python 3.12 설치 (전용 경로 · 시스템 PATH 미변경)"
if (Test-Path $py) {
  Ok "이미 설치됨 — 건너뜀: $py"
} else {
  $args = @(
    "/quiet", "InstallAllUsers=1", "PrependPath=0", "Include_launcher=0",
    "Include_test=0", "Include_doc=0", "SimpleInstall=1",
    "TargetDir=$Root\python312"
  )
  $p = Start-Process -FilePath $PythonInstaller -ArgumentList $args -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "Python 설치 실패 (exit $($p.ExitCode))" }
  if (-not (Test-Path $py)) { throw "설치는 됐다는데 $py 가 없습니다" }
  Ok (& $py --version 2>&1)
}

Step "pyodbc 설치 (유일한 외부 패키지)"
& $py -m pip install --upgrade pip --quiet 2>&1 | Out-Null
if ($WheelDir) {
  if (-not (Test-Path $WheelDir)) { throw "휠 경로가 없습니다: $WheelDir" }
  & $py -m pip install --no-index --find-links=$WheelDir pyodbc
} else {
  & $py -m pip install pyodbc
}
if ($LASTEXITCODE -ne 0) {
  throw "pyodbc 설치 실패. pypi 접근이 막혔다면 워크스테이션에서 휠을 받아 -WheelDir 로 넘기세요:`n" +
        "  python -m pip download pyodbc -d .\wheels --only-binary=:all:"
}
Ok "pyodbc"

Step "환경 점검"
$drv = & $py -c "import pyodbc;print('|'.join(d for d in pyodbc.drivers() if 'SQL Server' in d))" 2>&1
if ($LASTEXITCODE -ne 0) { throw "pyodbc import 실패: $drv" }
if ($drv -match "ODBC Driver 1[78] for SQL Server") { Ok "ODBC 드라이버: $drv" }
else { Warn "ODBC Driver 17/18 이 안 보입니다 — 실제 드라이버: $drv" }

Step "다음 할 일"
@"
  1) 스크립트 3개 복사
       gl_apply_demo2.py  _env.py  _erp_conn.py
       →  $etl

  2) .env 작성 (서버에서 직접 · OneDrive 경유 금지)
       →  $Root\jeil_ax\.env
       키: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / ERP_DB_CONN
       작성 후:
         icacls "$Root\jeil_ax\.env" /inheritance:r
         icacls "$Root\jeil_ax\.env" /grant:r "Administrators:(R)" "SYSTEM:(R)"

  3) 검증 (스케줄러 등록 전에 반드시)
       cd "$etl"
       & "$py" gl_apply_demo2.py --list
       & "$py" gl_apply_demo2.py --draft <초안번호> --dry-run
       & "$py" gl_apply_demo2.py --draft <초안번호>

  4) 작업 등록
       .\register_task.ps1 -Account ADMIN
"@ | Write-Host
