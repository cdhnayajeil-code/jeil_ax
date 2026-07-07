# load_table_dict.py — ERP 테이블 사전 적재 (로컬 메타파일 → erp_ro.table_dict)
# 원천: 사내 OneDrive ERP_DB/erp_chat/data/ (table-index.json + module-*.json)
#   ※ 운영 ERP DB에 접속하지 않는다 — 이미 추출된 로컬 메타 자산만 사용.
# 적재: Supabase RPC public.erp_etl_upsert('table_dict', rows) — service_role 키 필요
# 실행: python load_table_dict.py
import glob
import json
import os
import sys
import urllib.request

from _env import load_env, need

DEFAULT_META_DIR = r"C:\Users\N100282\OneDrive - 제일엠앤에스\최동혁\ERP_DB\erp_chat\data"
CHUNK_BYTES = 180_000  # RPC 호출당 페이로드 상한(대략)


def rpc(url: str, key: str, table: str, rows: list) -> int:
    body = json.dumps({"p_table": table, "p_rows": rows}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        f"{url}/rest/v1/rpc/erp_etl_upsert", data=body, method="POST",
        headers={"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return int(r.read().decode() or 0)


def main():
    load_env()
    url = need("SUPABASE_URL").rstrip("/")
    key = need("SUPABASE_SERVICE_ROLE_KEY")
    meta_dir = os.environ.get("ERP_DB_META_DIR", DEFAULT_META_DIR)
    if not os.path.isdir(meta_dir):
        raise SystemExit(f"메타 폴더 없음: {meta_dir} (ERP_DB_META_DIR 환경변수로 지정 가능)")

    # 1) table-index.json — 전체 테이블 목록 + 키워드
    with open(os.path.join(meta_dir, "table-index.json"), encoding="utf-8") as f:
        index = json.load(f)
    dict_rows = {t: {"table_name": t, "module": None, "row_cnt": None, "columns": None,
                     "keywords": kw if isinstance(kw, list) else []}
                 for t, kw in index.items()}

    # 2) module-*.json — 문서화된 테이블의 모듈·행수·컬럼 상세 병합
    documented = 0
    for path in glob.glob(os.path.join(meta_dir, "module-*.json")):
        with open(path, encoding="utf-8") as f:
            mod = json.load(f)
        for tname, tinfo in (mod.get("tables") or {}).items():
            row = dict_rows.setdefault(tname, {"table_name": tname, "module": None,
                                               "row_cnt": None, "columns": None, "keywords": []})
            row["module"] = tinfo.get("module") or mod.get("module")
            row["row_cnt"] = tinfo.get("rows")
            row["columns"] = tinfo.get("columns")
            documented += 1

    rows = list(dict_rows.values())
    print(f"대상 테이블 {len(rows)}개 (컬럼 문서화 {documented}개) — 적재 시작")

    # 3) 크기 기준 청크 업로드
    total, chunk, size = 0, [], 2
    for r in rows:
        s = len(json.dumps(r, ensure_ascii=False).encode("utf-8"))
        if chunk and size + s > CHUNK_BYTES:
            total += rpc(url, key, "table_dict", chunk)
            print(f"  … {total}/{len(rows)}")
            chunk, size = [], 2
        chunk.append(r)
        size += s + 1
    if chunk:
        total += rpc(url, key, "table_dict", chunk)
    print(f"완료: erp_ro.table_dict {total}행 적재")


if __name__ == "__main__":
    sys.exit(main())
