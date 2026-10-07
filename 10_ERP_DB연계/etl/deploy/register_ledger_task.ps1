<#
  register_ledger_task.ps1 — 구매 기안서 대장 적재(proposal_ledger.py)를 **이 PC 의 예약작업**으로 등록한다.

  왜 러너(jeil_runner)가 아니라 별도 예약작업인가 (register_scan_task.ps1 과 같은 이유)
    · 대장은 구매팀 Teams 채널의 엑셀이라 **그 채널이 동기화된 사무용 PC** 에서만 보인다.
      ERP 서버 러너에는 그 파일이 없다(runner_core.detect_capabilities 의 proposal_ledger=False → 작업이 사유를 남기고 끝난다).
    · 사무용 PC 에 러너를 통째로 띄우면 결의전표 운영 전송(relay_queue)까지 켜져 ERP 서버 러너와 **중복 처리**된다.
      그래서 이 작업 하나만 따로 돈다. (러너에도 작업 종류 proposal_ledger 가 있다 — 러너를 두는 PC 에서는 러너에서 켜고 이 작업은 지운다.)
    · 2026-09-22 이후 적재가 멈춘 이유가 이것이다 — 러너 작업은 기본 꺼짐이고, 사무용 PC 에는 러너가 아니라 etl_watch 만 돌았다.

  동작
    · 매일 07:30 `pythonw proposal_ledger.py --log <저장소>\logs\proposal_ledger.log` — 대장 **전량 교체** 적재(지워진 행도 따라감).
      대장 경로는 `.env` 의 PROPOSAL_LEDGER_XLSX(이 스크립트가 있는지만 확인하고 값은 출력하지 않는다).
    · 07:30 에 PC 가 꺼져 있었으면 켜진 뒤 첫 기회에 따라잡는다(StartWhenAvailable). 로그온 시에도 한 번 돈다.
    · 엑셀은 읽기만 한다(zipfile+xml · 외부 라이브러리 없음). 파일이 열려 있어도 읽힌다(OneDrive 동기 사본).

  권한
    · 현재 로그인 사용자 · **일반 권한(상승 없음)** · 대화형 로그온 — 비밀번호를 받지 않는다. 로그인되어 있을 때만 돈다(OneDrive 동기는 사용자 세션에서 돈다).

  사용(일반 PowerShell)
    .\register_ledger_task.ps1                  # 등록(이미 있으면 갱신)
    .\register_ledger_task.ps1 -At 07:30        # 시각 변경
    .\register_ledger_task.ps1 -Remove          # 삭제
    .\register_ledger_task.ps1 -RunNow          # 등록 후 한 번 바로 실행(같은 날 다시 돌아도 같은 결과 — 전량 교체)
#>
[CmdletBinding()]
param(
  [string]$TaskName = "JEIL_AX_ProposalLedger",
  [string]$At = "07:30",
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
$script = Join-Path $etl "proposal_ledger.py"
if (-not (Test-Path -LiteralPath $script)) { throw "proposal_ledger.py 가 없습니다: $script" }
if (-not (Test-Path -LiteralPath (Join-Path $repo ".env"))) { throw ".env 가 없습니다: $repo\.env" }
$envText = Get-Content -LiteralPath (Join-Path $repo ".env") -Encoding UTF8 | Where-Object { $_ -match '^\s*PROPOSAL_LEDGER_XLSX\s*=' }
if (-not $envText) { throw ".env 에 PROPOSAL_LEDGER_XLSX(대장 엑셀 경로)가 없습니다 — 값은 적지 말고 키 이름만 확인한다" }

$py = (Get-Command python -ErrorAction Stop).Source
$pyw = Join-Path (Split-Path -Parent $py) "pythonw.exe"
if (-not (Test-Path -LiteralPath $pyw)) { throw "pythonw.exe 가 없습니다: $pyw" }
$log = Join-Path $repo "logs\proposal_ledger.log"

$action = New-ScheduledTaskAction -Execute $pyw -WorkingDirectory $etl `
  -Argument ('"{0}" --log "{1}"' -f $script, $log)
$t1 = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$t2 = New-ScheduledTaskTrigger -Daily -At $At
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($t1, $t2) -Principal $principal -Settings $settings `
  -Description "JEIL AX — 구매 기안서 대장(Teams 엑셀) → 중간DB public.pur_proposal 전량 교체 적재, 매일 $At + 로그온 시. 등록 스크립트: 10_ERP_DB연계\etl\deploy\register_ledger_task.ps1" `
  -Force | Out-Null
Write-Host "예약작업 등록: $TaskName · 매일 $At + 로그온 시 · 로그 $log" -ForegroundColor Green
if ($RunNow) { Start-ScheduledTask -TaskName $TaskName; Write-Host "한 번 실행했습니다 — 결과는 로그를 보세요." }
