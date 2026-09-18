<#
  register_runner_task.ps1 — 트레이 스케줄 러너(jeil_runner.exe)를 **로그온 시 자동 시작**으로 등록한다.

  러너는 창·트레이 아이콘이 있는 프로그램이라 "로그온 여부와 관계없이" 돌릴 수 없다.
  대신 이 스크립트로 등록하면 서버가 재부팅된 뒤 관리자가 로그인하는 순간 자동으로 뜬다.
  (RDP 는 「연결 끊기」로 나가면 계속 돈다. 「로그오프」하면 함께 종료된다.)

  ⚠ 관리자 권한 PowerShell 에서 실행한다 — 상승(-RunLevel Highest) 작업 등록에 필요하고,
    러너가 .env(Administrators 읽기 전용)를 읽으려면 상승 실행이어야 한다.

  ⚠ 권한 점검(허용 목록 방식) — 상승 권한으로 도는 EXE·설정·내역을 일반 사용자가 바꾸거나,
    폴더째 이름을 바꿔 가짜 EXE 를 끼워 넣을 수 있으면 권한 상승 통로가 된다. 아래를 모두 확인하고
    하나라도 걸리면 등록하지 않는다.
      · 실행 루트와 그 안의 파일·폴더(logs 아래 실행 로그 제외): 쓰기 계열 권한은
        Administrators · SYSTEM · TrustedInstaller · 등록하는 관리자 본인만. 소유자도 이 중 하나.
      · 실행 루트의 상위 폴더들(드라이브 루트 제외): 일반 사용자에게 「삭제」(이름 바꾸기) 권한이 없어야 한다.
      · 상위 폴더의 부모: 일반 사용자에게 「하위 폴더·파일 삭제」 권한이 없어야 한다.
    잠그는 법(README C-2):
      icacls E:\ai.jeil\relay /inheritance:r /grant:r "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F"

  비밀번호를 받지 않는다 — 대화형(Interactive) 로그온 유형이라 필요 없다.

  사용:
    .\register_runner_task.ps1                       # 현재 로그인 계정으로 등록 (루트 E:\ai.jeil\relay)
    .\register_runner_task.ps1 -Root D:\ax\relay
    .\register_runner_task.ps1 -CheckOnly            # 등록하지 않고 권한 점검만
    .\register_runner_task.ps1 -Remove
#>
[CmdletBinding()]
param(
  [string]$Root = "E:\ai.jeil\relay",
  [string]$TaskName = "JEIL_AX_Runner",
  [switch]$Remove,
  [switch]$CheckOnly,
  [switch]$SkipAclCheck
)

$ErrorActionPreference = "Stop"

if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "작업 삭제됨: $TaskName — 러너를 손으로 띄우는 상태로 돌아갔습니다(실행 중인 러너는 그대로)." -ForegroundColor Yellow
  return
}

$me = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "관리자 권한 PowerShell 에서 실행하세요(시작 메뉴 → PowerShell 우클릭 → 관리자 권한으로 실행)."
}
$Root = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\')
$exe = Join-Path $Root "jeil_runner.exe"
if (-not (Test-Path -LiteralPath $exe)) { throw "jeil_runner.exe 가 없습니다: $exe`n  전달 폴더의 jeil_runner.exe 를 $Root 로 복사하세요." }
if (-not (Test-Path -LiteralPath (Join-Path $Root ".env"))) { throw ".env 가 없습니다: $Root\.env — 러너는 같은 폴더의 .env 를 읽습니다." }

$mySid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
# 허용: Administrators · SYSTEM · TrustedInstaller · 등록하는 관리자 본인
$okSids = @('S-1-5-32-544', 'S-1-5-18', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464', $mySid)
# 쓰기 계열 비트: WriteData·AppendData·WriteEA·DeleteChild·WriteAttributes·Delete·WriteDAC·WriteOwner + GENERIC_ALL·GENERIC_WRITE
$writeBits  = [long]0x500D0156
$deleteBits = [long]0x10010000     # DELETE + GENERIC_ALL
$delChildBits = [long]0x10000040   # FILE_DELETE_CHILD + GENERIC_ALL

function Get-Sid($ace) {
  try { return $ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { return "$($ace.IdentityReference)" }
}

function Test-Object([string]$Path, [long]$Bits, [string]$What, [switch]$CheckOwner) {
  $found = @()
  $acl = Get-Acl -LiteralPath $Path
  if ($CheckOwner) {
    try { $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value } catch { $owner = "$($acl.Owner)" }
    if ($okSids -notcontains $owner) { $found += "$Path — 소유자가 관리자 계열이 아님: $($acl.Owner)" }
  }
  foreach ($ace in $acl.Access) {
    if ($ace.AccessControlType -ne 'Allow') { continue }
    # 상속 전용 ACE 는 이 개체 자신에게 적용되지 않는다(자식은 따로 검사한다)
    if ($ace.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) { continue }
    if ((([long]$ace.FileSystemRights) -band $Bits) -eq 0) { continue }
    $sid = Get-Sid $ace
    if ($okSids -contains $sid) { continue }
    $found += "$Path — $What : $($ace.IdentityReference) ($($ace.FileSystemRights))"
  }
  return $found
}

if (-not $SkipAclCheck) {
  $problems = @()
  # 1) 실행 루트 + 안의 파일·폴더(실행 로그는 제외 — 러너가 계속 만든다. logs 폴더 자체는 검사)
  $problems += Test-Object $Root $writeBits "쓰기" -CheckOwner
  $items = Get-ChildItem -LiteralPath $Root -Force -Recurse -ErrorAction SilentlyContinue |
           Where-Object { $_.FullName -notlike (Join-Path $Root 'logs\runner\runs\*') }
  foreach ($it in $items) { $problems += Test-Object $it.FullName $writeBits "쓰기" -CheckOwner }
  # 2) 상위 폴더: 폴더째 이름 바꾸기(삭제 권한) · 부모의 하위 삭제 권한
  $dir = Split-Path -Parent $Root
  $child = $Root
  while ($dir -and ($dir.TrimEnd('\') -ne (Split-Path -Qualifier $Root))) {
    $problems += Test-Object $child $deleteBits "삭제(이름 바꾸기)"
    $problems += Test-Object $dir $delChildBits "하위 삭제"
    $child = $dir
    $dir = Split-Path -Parent $dir
  }
  if ($child -ne $Root) { $problems += Test-Object $child $deleteBits "삭제(이름 바꾸기)" }
  $drive = (Split-Path -Qualifier $Root) + '\'
  $problems += Test-Object $drive $delChildBits "하위 삭제"

  $problems = @($problems | Where-Object { $_ } | Sort-Object -Unique)
  if ($problems.Count -gt 0) {
    Write-Host "권한 점검 실패 — 상승 권한으로 도는 러너를 일반 사용자가 바꿔치기할 수 있어 등록하지 않습니다." -ForegroundColor Red
    $problems | ForEach-Object { Write-Host "  · $_" }
    Write-Host ""
    Write-Host "  잠그기(관리자 PowerShell):" -ForegroundColor Cyan
    Write-Host "    icacls `"$Root`" /inheritance:r /grant:r `"*S-1-5-32-544:(OI)(CI)F`" `"*S-1-5-18:(OI)(CI)F`" /T"
    Write-Host "    takeown /F `"$Root`" /A /R /D Y        # 소유자를 Administrators 로"
    Write-Host "  상위 폴더에 일반 사용자 삭제·수정 권한이 있으면(볼륨 기본값 Authenticated Users 수정 등) 그 폴더의 상속을 끊고"
    Write-Host "  일반 사용자에게 읽기·실행만 남기세요. 판단이 어려우면 실행 루트를 관리자 전용 경로(예: C:\ProgramData\JEIL_AX\relay)로 옮기세요."
    Write-Host "  (확인 후에도 등록하려면 -SkipAclCheck — 권장하지 않음)"
    return
  }
  Write-Host "권한 점검 통과 — $Root" -ForegroundColor Green
}

if ($CheckOnly) { return }

$user = "$env:USERDOMAIN\$env:USERNAME"
$action    = New-ScheduledTaskAction -Execute $exe -WorkingDirectory $Root
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
               -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Force | Out-Null

Write-Host ""
Write-Host "등록 완료: $TaskName — $user 로그온 시 $exe 자동 시작" -ForegroundColor Green
Write-Host @"

  지금 바로 띄우기        Start-ScheduledTask $TaskName
  상태 확인               Get-ScheduledTask $TaskName | Get-ScheduledTaskInfo
  러너 로그               Get-Content $Root\logs\runner\runner_`$(Get-Date -Format yyyyMM).log -Tail 30 -Encoding UTF8
  해제                    .\register_runner_task.ps1 -Remove

  주의: 러너는 로그인 세션 안에서만 삽니다. RDP 는 「연결 끊기」로 나가고 「로그오프」하지 마세요.
        러너는 이 PC 에 하나만 뜹니다 — 다른 관리자 세션에서 또 실행하면 「이미 실행 중」으로 끝납니다.
"@
