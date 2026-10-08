<#
  register_gw_board_task.ps1 — 사내규정 게시판 수집(gw_board_collect.py --nightly)을 **이 PC 의 예약작업**으로 등록한다. (REQ-0124)

  왜 러너(jeil_runner)가 아니라 별도 예약작업인가 (register_nas_task.ps1 · register_ledger_task.ps1 과 같은 이유)
    · 그룹웨어 화면 자동화(Playwright)는 **서버 EXE 에 번들되지 않는다**(deploy/build_exe.py exclude) → ERP 서버 러너는 못 한다
      (runner_core.detect_capabilities 의 gw_board=False → 사유만 남기고 끝).
    · NAS 문서 루트(00_전사공유/사내규정)는 사내망의 로그인된 PC 에서만 보인다.
    · 사무용 PC 에 러너를 통째로 띄우면 결의전표 운영 전송(relay_queue)까지 켜져 ERP 서버 러너와 **중복 처리**된다(D-113).
      그래서 이 작업 하나만 따로 돈다. (러너에도 작업 종류 gw_board 가 있다 — 러너를 두는 PC 에서는 러너에서 켜고 이 작업은 지운다.)

  왜 06:30 1회인가
    · 그룹웨어는 같은 계정의 중복 로그인을 막는다(시크릿키 강제 로그인은 **사람 세션을 끊는다**). 수집기는 강제 로그인을 하지 않고
      시크릿키 칸이 뜨면 그 회차를 건너뛴다 → 사람이 쓰지 않는 이른 아침 1회가 가장 안전하다. 전용 수집 계정(결정 J2)이 생기면
      .env.local 의 gw id/pw 만 바꾸면 된다(스크립트 무변경).
    · -Retry 를 주면 09:30·12:30·15:30 에도 한 번씩 더 시도한다 — 모듈이 「오늘 이미 완주」면 바로 끝나므로 중복 수집은 없다.

  동작
    · `pythonw gw_board_collect.py --nightly --log <저장소>\logs\gw_board.log`
    · 모듈이 스스로 판단: 그날 이미 완주했으면 건너뜀 · NAS 문서 루트가 안 보이면 미룸 · 실패가 있으면 표시를 남기지 않아
      다음 회차/다음날 다시 한다. 게시판·선택자는 DB reg_source(없으면 etl\gw_board_profile.default.json)에서 읽는다.
    · 06:30 에 PC 가 꺼져 있었으면 켜진 뒤 첫 기회에 따라잡는다(StartWhenAvailable). **로그온 트리거는 두지 않는다**(사람이 그룹웨어를
      쓰기 시작하는 시각과 겹친다).

  권한
    · 현재 로그인 사용자 · 일반 권한(상승 없음) · 대화형 로그온 — 비밀번호를 받지 않는다. 로그인되어 있을 때만 돈다(NAS 자격증명).
    · 그룹웨어 자격증명은 <저장소>\.env.local 의 gw url / gw id / gw pw — 이 스크립트는 **키 이름만** 확인하고 값은 출력하지 않는다.

  사용(일반 PowerShell)
    .\register_gw_board_task.ps1                  # 등록(이미 있으면 갱신)
    .\register_gw_board_task.ps1 -At 06:30        # 시각 변경
    .\register_gw_board_task.ps1 -Retry           # 3시간 간격 재시도 3회 추가(09:30·12:30·15:30)
    .\register_gw_board_task.ps1 -Remove          # 삭제
    .\register_gw_board_task.ps1 -RunNow          # 등록 후 한 번 바로 실행(그날 이미 완주했으면 바로 끝난다)
#>
[CmdletBinding()]
param(
  [string]$TaskName = "JEIL_AX_GwBoard",
  [string]$At = "06:30",
  [switch]$Retry,
  [switch]$Remove,
  [switch]$RunNow
)
$ErrorActionPreference = "Stop"

if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "예약작업 삭제됨: $TaskName" -ForegroundColor Yellow
  return
}

$etl = Split-Path -Parent $PSScriptRoot                  # …\10_ERP_DB연계\etl
$repo = Split-Path -Parent (Split-Path -Parent $etl)      # 저장소 루트(.env·.env.local·.claude·logs)
$script = Join-Path $etl "gw_board_collect.py"
if (-not (Test-Path -LiteralPath $script)) { throw "gw_board_collect.py 가 없습니다: $script" }

# ── 사전 점검(값은 출력하지 않는다 · 키 이름·존재 여부만) ──────────────────────────
if (-not (Test-Path -LiteralPath (Join-Path $repo ".env"))) { throw ".env 가 없습니다: $repo\.env" }
$envText = Get-Content -LiteralPath (Join-Path $repo ".env") -Encoding UTF8
foreach ($k in @("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY")) {
  if (-not ($envText | Where-Object { $_ -match "^\s*$k\s*=" })) { throw ".env 에 $k 가 없습니다 — 값은 적지 말고 키 이름만 확인한다" }
}
$local = Join-Path $repo ".env.local"
if (-not (Test-Path -LiteralPath $local)) { throw ".env.local 이 없습니다(그룹웨어 자격증명 · gw url / gw id / gw pw)" }
$localText = Get-Content -LiteralPath $local -Encoding UTF8
foreach ($k in @("url", "id", "pw")) {
  if (-not ($localText | Where-Object { $_ -match "^\s*gw[ ._-]?$k\s*[:=]" })) { throw ".env.local 에 gw $k 가 없습니다(키 이름만 확인)" }
}
$docsPath = Join-Path $repo ".claude\nas_docs.path"
if (-not (Test-Path -LiteralPath $docsPath) -and -not $env:NAS_DOCS_ROOT) {
  throw "NAS 문서 루트가 정해져 있지 않습니다 — $docsPath(절대경로 1줄) 또는 환경변수 NAS_DOCS_ROOT"
}

$py = (Get-Command python -ErrorAction Stop).Source
$pyw = Join-Path (Split-Path -Parent $py) "pythonw.exe"
if (-not (Test-Path -LiteralPath $pyw)) { throw "pythonw.exe 가 없습니다: $pyw" }
& $py -c "import playwright" 2>$null
if ($LASTEXITCODE -ne 0) { throw "playwright 가 설치돼 있지 않습니다 — pip install playwright; python -m playwright install chromium" }
& $py -c "import olefile" 2>$null
if ($LASTEXITCODE -ne 0) { Write-Warning "olefile 이 없어 구형 .hwp 첨부는 「읽지 못함」으로 남습니다 — pip install olefile" }
$pwCache = Join-Path $env:LOCALAPPDATA "ms-playwright"
if (-not (Test-Path -LiteralPath $pwCache)) { Write-Warning "Playwright 브라우저 캐시($pwCache)가 없습니다 — python -m playwright install chromium" }

$log = Join-Path $repo "logs\gw_board.log"
$action = New-ScheduledTaskAction -Execute $pyw -WorkingDirectory $etl `
  -Argument ('"{0}" --nightly --log "{1}"' -f $script, $log)
$triggers = @(New-ScheduledTaskTrigger -Daily -At $At)
if ($Retry) {
  $base = [datetime]::ParseExact($At, "HH:mm", $null)
  foreach ($h in 3, 6, 9) { $triggers += New-ScheduledTaskTrigger -Daily -At ($base.AddHours($h).ToString("HH:mm")) }
}
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 90) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Principal $principal -Settings $settings `
  -Description "JEIL AX — 사내규정 게시판 수집(그룹웨어 → NAS 00_전사공유/사내규정 정본 미러 + 중간DB public.reg_*), 매일 $At$(if ($Retry) { ' + 3시간 간격 재시도 3회' }). 등록 스크립트: 10_ERP_DB연계\etl\deploy\register_gw_board_task.ps1 (REQ-0124)" `
  -Force | Out-Null
Write-Host "예약작업 등록: $TaskName · 매일 $At$(if ($Retry) { ' (+09:30·12:30·15:30 재시도)' }) · 로그 $log" -ForegroundColor Green
if ($RunNow) { Start-ScheduledTask -TaskName $TaskName; Write-Host "한 번 실행했습니다 — 결과는 로그를 보세요." }
