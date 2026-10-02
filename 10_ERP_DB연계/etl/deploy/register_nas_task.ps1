<#
  register_nas_task.ps1 — 사내 NAS 적재(nas_worker --nightly)를 **이 PC 의 예약작업**으로 등록한다.

  왜 러너(jeil_runner)가 아니라 별도 예약작업인가
    · NAS 공유 폴더는 **사내망의 로그인된 PC** 에서만 열린다. ERP 서버(사외 IDC) 러너는 NAS 가 안 보여
      이 작업을 못 한다(runner_core.detect_capabilities 의 nas=False).
    · 사무용 PC 에 러너를 통째로 띄우면 기본 작업(결의전표 ERP 전송·데이터 업데이트 요청 처리)까지 켜져
      ERP 서버 러너와 **중복 처리**된다 — 결의전표 전송은 운영 ERP 대상이라 특히 안 된다(D-113).
      그래서 이 작업 하나만 따로 돈다(register_scan_task.ps1 과 같은 이유).
    · 러너의 작업 종류 nas_sync 는 **화면이 남긴 요청을 집는 일**만 한다. 요청을 매일 만들어 주는 것이 없으므로
      「매일 자동」은 이 예약작업이 맡는다. NAS 컨테이너로 옮기면 이 작업은 지운다.

  동작
    · 30분마다 `pythonw nas_worker.py --nightly --log <저장소>\logs\nas_worker.log`
    · 모듈이 스스로 판단: 그날 이미 성공했으면 화면 요청만 확인하고 끝 · NAS 가 안 보이거나 실패하면
      표시를 남기지 않아 다음 회차에 다시 한다 → **그날 PC 가 켜지고 NAS 가 보이는 첫 회차**에 1회.
    · 내보내는 것: 대화기록 등 증분 4종 + ERP 스냅샷 9종(허용 목록 = DB `etl_meta.nas_export_source`).

  권한
    · 현재 로그인 사용자 · 일반 권한(상승 없음) · 대화형 로그온 — 비밀번호를 받지 않는다.
    · 로그인되어 있을 때만 돈다(NAS 공유 자격증명이 로그인 세션에 묶여 있다).

  NAS 경로는 여기에 적지 않는다 — `<저장소>\.claude\nas.path`(1줄) 에서 읽는다(CLAUDE.md §1.1).

  사용(일반 PowerShell)
    .\register_nas_task.ps1                  # 등록(이미 있으면 갱신)
    .\register_nas_task.ps1 -Remove          # 삭제
    .\register_nas_task.ps1 -RunNow          # 등록 후 한 번 바로 실행
#>
[CmdletBinding()]
param(
  [string]$TaskName = "JEIL_AX_NasExport",
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
$repo = Split-Path -Parent (Split-Path -Parent $etl)      # 저장소 루트(.env·logs·.claude)
$script = Join-Path $etl "nas_worker.py"
if (-not (Test-Path -LiteralPath $script)) { throw "nas_worker.py 가 없습니다: $script" }
if (-not (Test-Path -LiteralPath (Join-Path $repo ".env"))) { throw ".env 가 없습니다: $repo\.env" }
if (-not (Test-Path -LiteralPath (Join-Path $repo ".claude\nas.path"))) {
  throw ".claude\nas.path 가 없습니다 — NAS 적재 폴더 절대경로를 한 줄로 적어 주세요"
}

$py = (Get-Command python -ErrorAction Stop).Source
$pyw = Join-Path (Split-Path -Parent $py) "pythonw.exe"
if (-not (Test-Path -LiteralPath $pyw)) { throw "pythonw.exe 가 없습니다: $pyw" }
$log = Join-Path $repo "logs\nas_worker.log"

$action = New-ScheduledTaskAction -Execute $pyw -WorkingDirectory $etl `
  -Argument ('"{0}" --nightly --log "{1}"' -f $script, $log)
# 로그온 시 + 매일 00:00 부터 N분 간격(하루 동안 반복 → 매일 다시 시작)
$t1 = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$t2 = New-ScheduledTaskTrigger -Daily -At 00:00
$t2.Repetition = (New-ScheduledTaskTrigger -Once -At 00:00 -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes) -RepetitionDuration (New-TimeSpan -Days 1)).Repetition
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 60) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($t1, $t2) -Principal $principal -Settings $settings `
  -Description "JEIL AX — 대화기록·ERP 스냅샷을 사내 NAS 로 하루 1회 내보낸다(nas_worker --nightly). 등록 스크립트: 10_ERP_DB연계\etl\deploy\register_nas_task.ps1" `
  -Force | Out-Null
Write-Host "예약작업 등록: $TaskName · $EveryMinutes 분 간격(하루 1회만 실제 적재) · 로그 $log" -ForegroundColor Green
if ($RunNow) { Start-ScheduledTask -TaskName $TaskName; Write-Host "한 번 실행했습니다 — 결과는 로그를 보세요." }
