# seed_role_standard.py — 부서 표준 ERP role 세트 시드 (REQ-0057)
#
# 이상권한(별도/무관) 판정의 기준선인 `public.dept_role_standard` 를 채운다.
# 원천은 사내 OneDrive 엑셀 「부서별 역할 권한정보.xlsx」 시트 `부서별 역할코드`(부서|역할코드|역할명).
#
# 일회성 스크립트가 아니다 — 조직개편(20271…)마다, 권한 기준 재정비마다 다시 돌린다.
# 그래서 jeil_runner.py CLI_TOOLS 에 등록해 단일 EXE 로 배포한다(CLAUDE.md §17.2).
#
# 파이프라인 (사람 검토가 중간에 들어간다)
#   ① --extract   xlsx → seed/dept_role_excel.csv            (판단 없음, 원문 그대로)
#   ② (사람)      seed/dept_map_legacy.csv 를 채운다          ← ★ 매핑 정본, git 커밋
#   ③ --plan      ①+② + 현행 조직 대조 → seed/dept_role_standard.csv · seed/unmapped.csv
#   ④ --apply     ③의 CSV → RPC erp_role_standard_seed       (기본 dry-run, --commit 필요)
#   ⑤ --majority  기준 없는 부서에 다수결 후보 생성            → seed/dept_role_majority.csv
#
# 의존성 0 — openpyxl 이 이 환경에 없어서 xlsx 를 zipfile+xml 로 직접 읽는다.
# 러너 EXE 에 무거운 의존성을 더하지 않는 이점도 있다.
#
# 엑셀 경로는 저장소에 절대경로를 적지 않는다(CLAUDE.md §1) — .env 키 ROLE_SEED_XLSX 또는 --xlsx.

import argparse
import csv
import json
import os
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

from _env import load_env, need, env_root
from etl_run import rpc

NS_MAIN = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
NS_REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
NS_PKGREL = "{http://schemas.openxmlformats.org/package/2006/relationships}"

SEED_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "seed")
F_EXCEL = os.path.join(SEED_DIR, "dept_role_excel.csv")
F_MAP = os.path.join(SEED_DIR, "dept_map_legacy.csv")
F_PLAN = os.path.join(SEED_DIR, "dept_role_standard.csv")
F_UNMAPPED = os.path.join(SEED_DIR, "unmapped.csv")
F_MAJORITY = os.path.join(SEED_DIR, "dept_role_majority.csv")

SHEET_NAME = "부서별 역할코드"


# ── xlsx 최소 리더 (zipfile + xml) ─────────────────────────────────────────

def _col_index(ref: str) -> int:
    """'B7' → 1 (0-based 열 번호)."""
    letters = re.match(r"([A-Z]+)", ref or "A").group(1)
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def read_sheet(xlsx_path: str, sheet_name: str):
    """지정 시트를 행 리스트(list[list[str]])로 읽는다. 병합·서식은 무시."""
    with zipfile.ZipFile(xlsx_path) as z:
        # 공유 문자열
        shared = []
        if "xl/sharedStrings.xml" in z.namelist():
            root = ET.fromstring(z.read("xl/sharedStrings.xml"))
            for si in root.findall(f"{NS_MAIN}si"):
                shared.append("".join(t.text or "" for t in si.iter(f"{NS_MAIN}t")))

        # 시트 이름 → rId → 파일 경로
        wb = ET.fromstring(z.read("xl/workbook.xml"))
        rid = None
        names = []
        for sh in wb.iter(f"{NS_MAIN}sheet"):
            names.append(sh.get("name"))
            if sh.get("name") == sheet_name:
                rid = sh.get(f"{NS_REL}id")
        if not rid:
            raise SystemExit(f"시트 '{sheet_name}' 를 찾지 못했습니다. 있는 시트: {names}")

        rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
        target = None
        for rel in rels.iter(f"{NS_PKGREL}Relationship"):
            if rel.get("Id") == rid:
                target = rel.get("Target")
        if not target:
            raise SystemExit(f"시트 관계(rId={rid})를 찾지 못했습니다.")
        path = target if target.startswith("xl/") else "xl/" + target.lstrip("/")

        rows = []
        sheet = ET.fromstring(z.read(path))
        for row in sheet.iter(f"{NS_MAIN}row"):
            vals = []
            for c in row.findall(f"{NS_MAIN}c"):
                idx = _col_index(c.get("r", ""))
                while len(vals) <= idx:
                    vals.append("")
                t = c.get("t")
                v = c.find(f"{NS_MAIN}v")
                if t == "s" and v is not None:
                    vals[idx] = shared[int(v.text)]
                elif t == "inlineStr":
                    is_el = c.find(f"{NS_MAIN}is")
                    vals[idx] = "".join(x.text or "" for x in is_el.iter(f"{NS_MAIN}t")) if is_el is not None else ""
                elif v is not None:
                    vals[idx] = v.text or ""
            rows.append([(x or "").strip() for x in vals])
        return rows


# ── 공통 ───────────────────────────────────────────────────────────────────

def sb():
    load_env()
    return need("SUPABASE_URL").rstrip("/"), need("SUPABASE_SERVICE_ROLE_KEY")


def write_csv(path, header, rows):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    # UTF-8 BOM — 엑셀에서 한글이 깨지지 않게 (그리드 규약 §13.5 와 동일)
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)
    print(f"  → {path} ({len(rows)}행)")


def read_csv(path):
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def org_list(url, key, org=None):
    raw = rpc(url, key, "erp_role_org_list", {"p_org_change_id": org})
    return json.loads(raw) if isinstance(raw, str) else raw


# ── ① 추출 ─────────────────────────────────────────────────────────────────

def cmd_extract(args):
    load_env()
    xlsx = args.xlsx or os.environ.get("ROLE_SEED_XLSX", "")
    if not xlsx:
        raise SystemExit(
            "엑셀 경로가 필요합니다 — --xlsx 로 주거나 .env 에 ROLE_SEED_XLSX 를 추가하세요.\n"
            "  (경로는 저장소에 적지 않는다 — CLAUDE.md §1)"
        )
    if not os.path.exists(xlsx):
        raise SystemExit(f"엑셀을 찾지 못했습니다: {xlsx}")

    rows = read_sheet(xlsx, SHEET_NAME)
    if not rows:
        raise SystemExit("시트가 비어 있습니다.")

    # 헤더 행 탐색 ('부서' 와 '역할' 이 같은 행에 있는 첫 행)
    head_i = 0
    for i, r in enumerate(rows[:20]):
        joined = " ".join(r)
        if "부서" in joined and "역할" in joined:
            head_i = i
            break
    header = rows[head_i]
    ci = {}
    for j, h in enumerate(header):
        if h.startswith("부서"):
            ci.setdefault("dept", j)
        elif "역할코드" in h or h in ("역할코드", "ROLE ID", "ROLEID"):
            ci.setdefault("role_id", j)
        elif "역할명" in h or h in ("역할명", "ROLE명"):
            ci.setdefault("role_nm", j)
    missing = {"dept", "role_id", "role_nm"} - set(ci)
    if missing:
        raise SystemExit(f"헤더에서 컬럼을 못 찾았습니다({missing}). 실제 헤더: {header}")

    out, seen = [], set()
    for r in rows[head_i + 1:]:
        def g(k):
            j = ci[k]
            return r[j].strip() if j < len(r) else ""
        dept, rid, rnm = g("dept"), g("role_id"), g("role_nm")
        if not dept or not rid:
            continue
        k = (dept, rid)
        if k in seen:
            continue
        seen.add(k)
        out.append([dept, rid, rnm])

    write_csv(F_EXCEL, ["legacy_dept_nm", "role_id", "role_nm"], out)
    depts = sorted({r[0] for r in out})
    roles = sorted({r[1] for r in out})
    print(f"  부서 {len(depts)}종 · 역할코드 {len(roles)}종 · 매핑 {len(out)}행")

    # 매핑 파일 초안 — 이미 있으면 덮지 않는다(사람이 채운 결정을 지우지 않기 위해)
    if os.path.exists(F_MAP):
        print(f"  (기존 매핑 유지: {F_MAP})")
    else:
        url, key = sb()
        cur = {d["dept_nm"]: d for d in org_list(url, key)}
        org = next(iter(cur.values()))["org_change_id"] if cur else ""
        draft = []
        for d in depts:
            hit = cur.get(d)
            draft.append([d, org,
                          hit["dept_cd"] if hit else "",
                          hit["dept_nm"] if hit else "",
                          "same" if hit else "unmapped",
                          "high" if hit else "low",
                          "" if hit else "현행 조직에 동명 부서가 없습니다 — 매핑을 결정하세요"])
        write_csv(F_MAP,
                  ["legacy_dept_nm", "org_change_id", "dept_cd", "dept_nm", "rule", "confidence", "note"],
                  draft)
        print("  ★ 매핑 초안을 만들었습니다. rule=unmapped 행을 채운 뒤 --plan 을 실행하세요.")


# ── ③ 계획 ─────────────────────────────────────────────────────────────────

def cmd_plan(args):
    url, key = sb()
    excel = read_csv(F_EXCEL)
    if not excel:
        raise SystemExit(f"{F_EXCEL} 가 없습니다 — 먼저 --extract 를 실행하세요.")
    mapping = read_csv(F_MAP)
    if not mapping:
        raise SystemExit(f"{F_MAP} 가 없습니다 — 먼저 --extract 로 초안을 만들고 채우세요.")

    cur = org_list(url, key, args.org)
    if not cur:
        raise SystemExit("현행 조직 목록이 비어 있습니다.")
    org = cur[0]["org_change_id"]
    valid_cd = {d["dept_cd"]: d["dept_nm"] for d in cur}

    # legacy 부서명 → [(dept_cd, confidence)] (split 은 1:N)
    m = {}
    for r in mapping:
        if (r.get("org_change_id") or org) != org:
            continue
        rule = (r.get("rule") or "").strip()
        cd = (r.get("dept_cd") or "").strip()
        if rule in ("unmapped", "ignore") or not cd:
            continue
        if cd not in valid_cd:
            print(f"  ! 매핑의 dept_cd '{cd}' 가 현행 조직에 없습니다 (legacy={r['legacy_dept_nm']})")
            continue
        m.setdefault(r["legacy_dept_nm"], []).append((cd, (r.get("confidence") or "medium").strip()))

    # 라이브에 살아 있는 역할코드 (회수분 제외) — 존재하지 않는 역할을 표준으로 넣지 않기 위해
    raw = rpc(url, key, "erp_role_catalog", {})
    live_roles = {x["role_id"] for x in (json.loads(raw) if isinstance(raw, str) else raw)}

    plan, unmapped = [], []
    for r in excel:
        dept, rid, rnm = r["legacy_dept_nm"], r["role_id"], r.get("role_nm", "")
        targets = m.get(dept)
        if not targets:
            unmapped.append([dept, rid, rnm, "부서 매핑 없음(rule=unmapped/ignore 또는 미결정)"])
            continue
        if live_roles and rid not in live_roles:
            unmapped.append([dept, rid, rnm, "현재 배정 이력이 없는 역할코드 — 표준으로 넣지 않음"])
            continue
        for cd, conf in targets:
            plan.append([org, cd, valid_cd[cd], rid, rnm, "excel_2025_07",
                         f"엑셀 부서명: {dept}", conf])

    write_csv(F_PLAN,
              ["org_change_id", "dept_cd", "dept_nm", "role_id", "role_nm",
               "source", "source_detail", "confidence"],
              plan)
    write_csv(F_UNMAPPED, ["legacy_dept_nm", "role_id", "role_nm", "reason"], unmapped)

    covered = {p[1] for p in plan}
    gap = [d for d in cur if d["dept_cd"] not in covered and int(d.get("member_cnt") or 0) > 0]
    if gap:
        total = sum(int(d.get("member_cnt") or 0) for d in gap)
        print(f"\n  ★ 기준 없는 부서 {len(gap)}곳 · 인원 {total}명 — 화면에서 「기준없음」으로 표시됩니다:")
        for d in sorted(gap, key=lambda x: -int(x.get("member_cnt") or 0)):
            print(f"     {d['dept_nm']}({d['dept_cd']}) {d['member_cnt']}명")
        print("     → --majority 로 후보를 만들거나 매핑을 채우세요.")


# ── ④ 적용 ─────────────────────────────────────────────────────────────────

def cmd_apply(args):
    url, key = sb()
    rows = read_csv(args.file or F_PLAN)
    if not rows:
        raise SystemExit(f"{args.file or F_PLAN} 가 비어 있습니다 — 먼저 --plan 을 실행하세요.")

    # (org, dept_cd, role_id) 중복 제거 — 구 부서 여러 곳이 한 부서로 합쳐지면(merge) 같은 키가 반복된다.
    # 그대로 보내면 PostgreSQL 이 "ON CONFLICT DO UPDATE command cannot affect row a second time" 로 거부한다.
    # 합쳐진 출처는 source_detail 에 모아 둔다 — 어느 구 부서에서 왔는지가 검토에 필요하다.
    RANK = {"high": 0, "medium": 1, "low": 2}
    merged = {}
    for r in rows:
        k = (r["org_change_id"], r["dept_cd"], r["role_id"])
        cur = merged.get(k)
        if cur is None:
            merged[k] = dict(r)
            merged[k]["_srcs"] = [r.get("source_detail") or ""]
        else:
            cur["_srcs"].append(r.get("source_detail") or "")
            # 신뢰도는 가장 높은 것을 남긴다(한 곳이라도 확실하면 확실한 매핑이다)
            if RANK.get(r.get("confidence"), 9) < RANK.get(cur.get("confidence"), 9):
                cur["confidence"] = r.get("confidence")

    dropped = len(rows) - len(merged)
    if dropped:
        print(f"  (중복 {dropped}행 병합 — 구 부서 여러 곳이 한 부서로 합쳐진 결과)")

    payload = [{
        "org_change_id": r["org_change_id"],
        "dept_cd": r["dept_cd"],
        "role_id": r["role_id"],
        "dept_nm_at_seed": r.get("dept_nm") or None,
        "role_nm_at_seed": r.get("role_nm") or None,
        "source": r.get("source") or "manual",
        "source_detail": " / ".join(sorted({s for s in r.get("_srcs", []) if s})) or None,
        "confidence": r.get("confidence") or "high",
        "approved_by": (r.get("approved_by") or None),
        "note": r.get("note") or None,
        "updated_by": "seed_role_standard",
    } for r in merged.values()]

    if not args.commit:
        by_dept = {}
        for p in payload:
            by_dept[p["dept_nm_at_seed"] or p["dept_cd"]] = by_dept.get(p["dept_nm_at_seed"] or p["dept_cd"], 0) + 1
        print(f"[dry-run] {len(payload)}행 · 부서 {len(by_dept)}곳")
        for d, c in sorted(by_dept.items(), key=lambda x: -x[1]):
            print(f"   {d}: {c}")
        print("실제 적용하려면 --commit 을 붙이세요.")
        return

    out = rpc(url, key, "erp_role_standard_seed", {"p_rows": payload})
    print(f"적용 완료: {out}")


# ── ⑤ 다수결 후보 ──────────────────────────────────────────────────────────

def cmd_majority(args):
    url, key = sb()
    raw = rpc(url, key, "erp_role_majority_suggest", {
        "p_org_change_id": args.org,
        "p_min_size": args.min_size,
        "p_threshold": args.threshold,
    })
    rows = json.loads(raw) if isinstance(raw, str) else raw
    write_csv(F_MAJORITY,
              ["org_change_id", "dept_cd", "dept_nm", "role_id", "role_nm",
               "source", "source_detail", "confidence"],
              [[r["org_change_id"], r["dept_cd"], r["dept_nm"], r["role_id"], r["role_nm"],
                "majority", r["source_detail"], "low"] for r in rows])
    print(f"  인원 {args.min_size}명 이상 · 보유율 {args.threshold} 이상인 후보 {len(rows)}건")
    print("  ⚠ 추정치입니다(approved_by 없음) — 화면에 「추정(미승인)」으로 표시됩니다.")
    print("  ⚠ 인원 1~2명 부서는 제외됩니다 — 보유 role 이 전부 100%가 되어 이상권한이 영영 0건이 되기 때문입니다.")


def main(argv=None):
    p = argparse.ArgumentParser(
        prog="seed-role-standard",
        description="부서 표준 ERP role 세트 시드 (엑셀 → 매핑 → 계획 → 적용)")
    p.add_argument("--xlsx", help="엑셀 경로(미지정 시 .env ROLE_SEED_XLSX)")
    p.add_argument("--org", help="조직개편 버전(미지정 시 현행)")
    p.add_argument("--file", help="--apply 에 쓸 CSV(기본 seed/dept_role_standard.csv)")
    p.add_argument("--min-size", type=int, default=3, dest="min_size", help="--majority 최소 인원(기본 3)")
    p.add_argument("--threshold", type=float, default=0.6, help="--majority 보유율 임계값(기본 0.6)")
    p.add_argument("--commit", action="store_true", help="--apply 실제 반영(기본 dry-run)")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--extract", action="store_true", help="① 엑셀 → CSV + 매핑 초안")
    g.add_argument("--plan", action="store_true", help="③ 매핑 적용 → 시드 계획 CSV")
    g.add_argument("--apply", action="store_true", help="④ 계획 CSV → DB (기본 dry-run)")
    g.add_argument("--majority", action="store_true", help="⑤ 기준 없는 부서 다수결 후보")
    a = p.parse_args(argv)

    if a.extract:
        cmd_extract(a)
    elif a.plan:
        cmd_plan(a)
    elif a.apply:
        cmd_apply(a)
    elif a.majority:
        cmd_majority(a)
    return 0


if __name__ == "__main__":
    sys.exit(main())
