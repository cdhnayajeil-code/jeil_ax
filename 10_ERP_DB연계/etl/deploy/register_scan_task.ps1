<#
  register_scan_task.ps1 — 기안서 스캔본 목록 갱신(proposal_scan --nightly)을 **이 PC 의 예약작업**으로 등록한다.

  왜 러너(jeil_runner)가 아니라 별도 예약작업인가
    · 문서중앙화(Destiny) 보호 드라이브는 **로그인된(잠기지 않은) 사무용 PC 의 탐색기**에만 열린다.
      ERP 서버 러너는 Destiny 가 없어 이 작업을 못 한다(runner_core.detect_capabilities 의 proposal_scan=False).
    · 사무용 PC 에 러너를 통째로 띄우면 기본 작업(결의전표 ERP 전송·데이터 업데이트 요청 처리)까지 켜져
      ERP 서버 러너와 **중복 처리**된다. 그래서 이 작업 하나만 따로 돈다.
    · (러너에도 작업 종류 proposal_scan 이 들어가 있다 — Destiny PC 에 러너를 둘 때는 러너에서 켜고 이 작업은 지운다.)

  동작
    · 30분마다 `pythonw proposal_scan.py --nightly --log <저장소>\logs\proposal_scan.log`
    · 모듈이 스스로 판단: 이번 밤(20:00 KST 이후) 이미 갱신했으면 건너뜀 · 화면 잠금/로그오프면 건너뜀 →
      **밤 20시 이후 PC 가 켜져 있고 잠기지 않은 첫 회차**에 1회, 밤새 잠겨 있었으면 다음 날 아침 첫 회차에 따라잡는다.
    · 파일은 열지도 옮기지도 않는다 — 파일명·크기·수정일만(2026-09-29 관리자 결정).

  권한
    · 현재 로그인 사용자 · **일반 권한(상승 없음)** · 대화형 로그온 — 비밀번호를 받지 않는다.
    · 로그인되어 있을 때만 돈다(문서중앙화 특성상 그래야만 한다).

  사용(일반 PowerShell)
    .\register_scan_task.ps1                  # 등록(이미 있으면 갱신)
    .\register_scan_task.ps1 -Remove          # 삭제
    .\register_scan_task.ps1 -RunNow          # 등록 후 한 번 바로 실행
#>
[CmdletBinding()]
param(
  [string]$TaskName = "JEIL_AX_ProposalScan",
  [int]$EveryMinutes = 30,
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
$repo = Split-Path -Parent (Split-Path -Parent $etl)      # 저장소 루트(.env·logs)
$script = Join-Path $etl "proposal_scan.py"
if (-not (Test-Path -LiteralPath $script)) { throw "proposal_scan.py 가 없습니다: $script" }
if (-not (Test-Path -LiteralPath (Join-Path $repo ".env"))) { throw ".env 가 없습니다: $repo\.env" }
$envText = Get-Content -LiteralPath (Join-Path $repo ".env") -Encoding UTF8 | Where-Object { $_ -match '^\s*PROPOSAL_SCAN_DIR\s*=' }
if (-not $envText) { throw ".env 에 PROPOSAL_SCAN_DIR(기안서 스캔본 폴더)가 없습니다" }

$py = (Get-Command python -ErrorAction Stop).Source
$pyw = Join-Path (Split-Path -Parent $py) "pythonw.exe"
if (-not (Test-Path -LiteralPath $pyw)) { throw "pythonw.exe 가 없습니다: $pyw" }
$log = Join-Path $repo "logs\proposal_scan.log"

$action = New-ScheduledTaskAction -Execute $pyw -WorkingDirectory $etl `
  -Argument ('"{0}" --nightly --log "{1}"' -f $script, $log)
# 로그온 시 + 매일 00:00 부터 N분 간격(하루 동안 반복 → 매일 다시 시작)
$t1 = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$t2 = New-ScheduledTaskTrigger -Daily -At 00:00
$t2.Repetition = (New-ScheduledTaskTrigger -Once -At 00:00 -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes) -RepetitionDuration (New-TimeSpan -Days 1)).Repetition
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($t1, $t2) -Principal $principal -Settings $settings `
  -Description "JEIL AX — 기안서 스캔본 목록(문서중앙화) → 중간DB. 파일명·존재 여부만, 밤 20시 이후 1회(proposal_scan --nightly). 등록 스크립트: 10_ERP_DB연계\etl\deploy\register_scan_task.ps1" `
  -Force | Out-Null
Write-Host "예약작업 등록: $TaskName · $EveryMinutes 분 간격 · 로그 $log" -ForegroundColor Green
if ($RunNow) { Start-ScheduledTask -TaskName $TaskName; Write-Host "한 번 실행했습니다 — 결과는 로그를 보세요." }
