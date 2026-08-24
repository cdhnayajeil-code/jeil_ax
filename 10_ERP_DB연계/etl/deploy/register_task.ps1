<#
  register_task.ps1 — 결의전표 릴레이를 Windows 작업 스케줄러에 등록한다(1분 주기).

  ⚠ 등록 전에 반드시 README 4단계(--list → --dry-run → 실건 1건)를 통과시킬 것.
    대기 건이 쌓인 상태로 등록하면 1분 안에 전부 ERP로 나간다.

  비밀번호는 대화형으로만 받는다(명령 기록에 남기지 않는다 — CLAUDE.md §1.8 취지).

  사용:
    .\register_task.ps1 -Account ADMIN
    .\register_task.ps1 -Account ADMIN -IntervalMinutes 5
    .\register_task.ps1 -Remove
#>
[CmdletBinding()]
param(
  [string]$Account,
  [string]$Root = "E:\ai.jeil",
  [int]$IntervalMinutes = 1,
  [string]$TaskName = "JEIL_AX_GL_Relay",
  [switch]$Remove
)

$ErrorActionPreference = "Stop"

if ($Remove) {
  schtasks /Delete /TN $TaskName /F
  Write-Host "작업 삭제됨: $TaskName — 종전(수동 실행) 상태로 돌아갔습니다." -ForegroundColor Yellow
  return
}

if (-not $Account) { throw "-Account 를 지정하세요 (예: -Account ADMIN)" }

$relay = Join-Path $Root "relay.cmd"
if (-not (Test-Path $relay)) {
  throw "relay.cmd 가 없습니다: $relay`n  이 폴더의 relay.cmd 를 $Root 로 복사하세요."
}

# 검증을 건너뛰지 않았는지 한 번 확인받는다 — 되돌리기 어려운 동작이라 묻는다
Write-Host ""
Write-Host "  등록 전 확인" -ForegroundColor Cyan
Write-Host "    · --list / --dry-run / 실건 1건 검증을 마쳤습니까?"
Write-Host "    · 지금 전송대기 건이 있다면 등록 즉시 순차 전송됩니다(1회 최대 5건)."
$ans = Read-Host "  계속하려면 'yes' 를 입력하세요"
if ($ans -ne "yes") { Write-Host "취소했습니다." -ForegroundColor Yellow; return }

$pw = Read-Host "  $Account 계정 비밀번호" -AsSecureString
$plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
           [Runtime.InteropServices.Marshal]::SecureStringToBSTR($pw))

try {
  # /RL HIGHEST — ODBC·파일 접근 권한 확보. /F — 기존 작업 덮어쓰기
  schtasks /Create /TN $TaskName /SC MINUTE /MO $IntervalMinutes `
           /RU $Account /RP $plain /RL HIGHEST /F /TR "`"$relay`""
  if ($LASTEXITCODE -ne 0) { throw "작업 등록 실패 (exit $LASTEXITCODE)" }
}
finally {
  # 평문 비밀번호를 메모리에 남기지 않는다
  $plain = $null
  [GC]::Collect()
}

Write-Host ""
Write-Host "등록 완료: $TaskName ($IntervalMinutes 분 주기)" -ForegroundColor Green
Write-Host @"

  상태 확인
    Get-ScheduledTask $TaskName | Get-ScheduledTaskInfo      # LastTaskResult 0 = 정상
    Get-Content $Root\logs\relay_`$(Get-Date -Format yyyyMM).log -Tail 30

  즉시 1회 실행
    Start-ScheduledTask $TaskName

  중지 / 해제
    Disable-ScheduledTask $TaskName
    .\register_task.ps1 -Remove
"@
