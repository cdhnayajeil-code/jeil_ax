# -*- coding: utf-8 -*-
r"""ERP(운영 MSSQL) 접속 문자열 확보 — 읽기 전용 ETL 전용.

우선순위:
  ① 환경변수 ERP_DB_CONN (서버 배치 배포용 — .env 또는 서버 환경변수)
  ② %USERPROFILE%\.erp\ DPAPI 저장소 (관리자 PC용 폴백, ERP_DB 보안규칙 2026-06-12)
       .db      : IP / ID (평문, 포트·비밀번호 없음)
       pw.xml   : DPAPI 암호화 비밀번호 (Export-Clixml)
       port.xml : DPAPI 암호화 포트 (없으면 기본포트)

보안규칙: 비밀번호·IP·ID를 print/log 하지 않는다. .env에 평문 비밀번호를 넣지 않는다.
로그/문서에서 서버 지칭은 별칭 "ERP운영DB"만 사용한다.
"""
import os
import re
import subprocess

DATABASE = "JEILMNS"


def _cred_dir() -> str:
    return os.path.join(os.environ["USERPROFILE"], ".erp")


def _parse_db_file() -> dict:
    path = os.path.join(_cred_dir(), ".db")
    info = {}
    with open(path, "r", encoding="utf-8-sig") as f:
        for line in f:
            m = re.match(r"\s*([^=:]+?)\s*[=:]\s*(.+?)\s*$", line)
            if m:
                info[m.group(1).strip().upper()] = m.group(2).strip()
    if "IP" not in info or "ID" not in info:
        raise RuntimeError(r".erp\.db 에 IP/ID 누락")
    return info


def _decrypt_clixml(filename: str) -> str:
    """DPAPI 암호화 xml을 PowerShell로 복호화해 stdout 파이프로만 수신."""
    path = os.path.join(_cred_dir(), filename)
    if not os.path.exists(path):
        return ""
    ps = (
        "$s = Import-Clixml -Path '{}';"
        "[Console]::Out.Write([System.Net.NetworkCredential]::new('', $s).Password)"
    ).format(path.replace("'", "''"))
    r = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
        capture_output=True, text=True, timeout=30,
    )
    if r.returncode != 0:
        raise RuntimeError(f"{filename} 복호화 실패 (DPAPI)")
    return r.stdout.strip()


def _pick_driver() -> str:
    import pyodbc
    drivers = [d for d in pyodbc.drivers() if "SQL Server" in d]
    for want in ("ODBC Driver 18 for SQL Server", "ODBC Driver 17 for SQL Server"):
        if want in drivers:
            return want
    if drivers:
        return drivers[-1]
    raise RuntimeError("SQL Server ODBC 드라이버가 없습니다")


def erp_conn_str() -> str:
    """접속 문자열 반환. 호출 측에서 print/log 금지."""
    env = os.environ.get("ERP_DB_CONN", "")
    if env:
        return env
    cred_db = os.path.join(_cred_dir(), ".db")
    if not os.path.exists(cred_db):
        raise SystemExit(
            "ERP_DB_CONN 이 없고 %USERPROFILE%\\.erp\\ 저장소도 없습니다 — "
            "서버 배포 시 환경변수, 관리자 PC에서는 .erp 저장소를 준비하세요"
        )
    info = _parse_db_file()
    pw = _decrypt_clixml("pw.xml")
    if not pw:
        raise SystemExit("pw.xml 없음 — 보안규칙에 따라 사용자가 직접 생성 필요")
    port = _decrypt_clixml("port.xml")
    server = f"{info['IP']},{port}" if port else info["IP"]
    return (
        f"DRIVER={{{_pick_driver()}}};"
        f"SERVER={server};DATABASE={DATABASE};"
        f"UID={info['ID']};PWD={pw};"
        "TrustServerCertificate=yes;"
    )
