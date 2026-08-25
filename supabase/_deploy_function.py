# -*- coding: utf-8 -*-
"""_deploy_function.py — Edge Function 배포(supabase CLI 없이).

이 PC에는 supabase CLI 가 없다. 그렇다고 함수 소스를 대화·툴 인자로 실어 나르면
75KB 를 사람 손으로 옮기는 셈이라 오탈자 위험이 크다 — 파일을 그대로 올린다.

사용:
    python supabase/_deploy_function.py jeil-gl-draft
    python supabase/_deploy_function.py jeil-gl-draft --verify-jwt     # 기본은 false

비밀값 취급(CLAUDE.md §1.8):
  · .env 는 셸로 읽지 않는다 — etl/_env.py 의 load_env() 로 파싱해 프로세스 환경에만 둔다.
  · 토큰·프로젝트 ref 를 출력하지 않는다. 결과는 상태코드와 함수 슬러그만 찍는다.
"""
import argparse
import io
import json
import os
import re
import sys
import urllib.request
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, os.path.join(ROOT, "10_ERP_DB연계", "etl"))
from _env import load_env  # noqa: E402

API = "https://api.supabase.com"


def project_ref() -> str:
    """SUPABASE_URL(https://<ref>.supabase.co) 에서 프로젝트 ref 를 뽑는다."""
    url = os.environ.get("SUPABASE_URL", "")
    m = re.match(r"https://([a-z0-9]+)\.supabase\.(co|in)", url)
    if not m:
        raise SystemExit("[중단] SUPABASE_URL 형식에서 프로젝트 ref 를 찾지 못했습니다.")
    return m.group(1)


def deploy(slug: str, entry: str, verify_jwt: bool) -> int:
    token = os.environ.get("SUPABASE_ACCESS_TOKEN", "")
    if not token:
        raise SystemExit("[중단] SUPABASE_ACCESS_TOKEN 이 .env 에 없습니다(개인 액세스 토큰, sbp_…).")
    src_dir = os.path.join(HERE, "functions", slug)
    src_path = os.path.join(src_dir, entry)
    if not os.path.isfile(src_path):
        raise SystemExit(f"[중단] 소스를 찾을 수 없습니다: functions/{slug}/{entry}")
    source = io.open(src_path, encoding="utf-8").read()
    print(f"[배포] {slug}/{entry} · {len(source.encode('utf-8')):,} bytes · verify_jwt={str(verify_jwt).lower()}")

    # multipart/form-data 수동 조립 — 외부 의존성 없이(requests 미설치 환경 대비)
    boundary = "----jeilax" + uuid.uuid4().hex
    meta = json.dumps({"entrypoint_path": entry, "name": slug,
                       "verify_jwt": verify_jwt}, ensure_ascii=False)
    parts = []
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n'
                 f'Content-Type: application/json\r\n\r\n{meta}\r\n')
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{entry}"\r\n'
                 f'Content-Type: application/typescript\r\n\r\n{source}\r\n')
    parts.append(f"--{boundary}--\r\n")
    body = "".join(parts).encode("utf-8")

    req = urllib.request.Request(
        f"{API}/v1/projects/{project_ref()}/functions/deploy?slug={slug}",
        data=body, method="POST",
        headers={"Authorization": f"Bearer {token}",
                 "Content-Type": f"multipart/form-data; boundary={boundary}",
                 # 기본 User-Agent(Python-urllib)는 API 앞단 WAF 가 1010 으로 막는다.
                 "User-Agent": "jeilax-deploy/1.0",
                 "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            out = json.loads(r.read().decode("utf-8") or "{}")
        print(f"[완료] {out.get('slug', slug)} · 버전 {out.get('version', '?')} · "
              f"상태 {out.get('status', '?')} · verify_jwt={out.get('verify_jwt')}")
        return 0
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:600]
        print(f"[실패] HTTP {e.code} — {detail}", file=sys.stderr)
        return 1


def main() -> int:
    ap = argparse.ArgumentParser(description="Supabase Edge Function 배포(CLI 없이)")
    ap.add_argument("slug", help="함수 이름(supabase/functions/<slug>/)")
    ap.add_argument("--entry", default="index.ts", help="진입 파일(기본 index.ts)")
    ap.add_argument("--verify-jwt", action="store_true",
                    help="JWT 검증 활성화. 이 저장소 함수들은 Entra 토큰을 자체 검증하므로 기본 false")
    a = ap.parse_args()
    load_env()
    return deploy(a.slug, a.entry, a.verify_jwt)


if __name__ == "__main__":
    sys.exit(main())
