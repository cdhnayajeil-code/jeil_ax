-- 44. 품목 존재/중복 조회 고도화 — 품명·규격 정규화 계산 칼럼 + 중복 조회 RPC  (REQ-0030)
-- 적용: 마이그레이션 `item_dup_norm_functions` · `item_master_dup_keys` · `item_dup_search_rpc`
--       · `item_dup_norm_loose_separators`(규격·품명 키 구분자 전부 무시로 보정 + 전건 재계산)
--       · `item_dup_search_rpc_plan_fix`(74 s → 0.6 s 실행계획 보정 + 규격 인덱스 (spec_key, name_key) 교체)
--       (2026-09-11, Supabase MCP) — 이 파일은 보정 후 최종 정의다.
--
-- 배경(2026-09-11 실측):
--   · 화면(/work/item-duplicates)은 `v_erp_item` 을 item_code·item_name ILIKE 로만 찾았다 — **규격은 검색 대상이 아니었다**.
--     중복 판정도 결과 상위 200건(정렬 없음) 안에서 "규격만" 같으면 묶어, 재질이 다른 같은 규격이 중복으로 잡히고
--     200건 밖의 같은 품목은 보이지 않았다.
--   · 품목 59,243건 중 품명+규격이 같은 묶음: 원문 그대로 4,692그룹 → 최종 키 **7,926그룹 / 25,608코드**.
--     미정리(유효 코드 2개 이상) 4,653그룹·18,709코드 · 정리됨(「사용금지」 표기로 유효 1개만) 3,160그룹 · 전부 사용금지 113그룹.
--   · 폐기 표시는 use_yn(false 3건뿐)이 아니라 품명 표기로 한다 — `◆사용금지 ◆`(3,770) · `◆사용금지 ->APP 코드사용◆`(3,185)
--     · 접두 `사용금지 - `(품명·규격 둘 다, 약 50건).
--   · 매 조회마다 5.9만 건을 정규화하면 약 1초(Seq Scan + temp spill, work_mem 2MB) → 정규화 결과를 계산 칼럼으로 저장한다.
--
-- 설계:
--   1) erp_ro 정규화 함수 3종(IMMUTABLE) — 같은 규칙을 저장(칼럼)과 검색(토큰)에 똑같이 쓴다.
--        공통: NFKC(전각→반각, ㎜→mm) · 대문자 · 지름기호 Φ/φ/∅/⌀→Ø · 곱셈기호 ×/✕→*
--              · 치수 사이 X(예 25A X 10K, M10x30, 18"X14")도 구분자로 본다
--        키  : 구분자(공백·* ·콤마·하이픈·괄호·따옴표)를 **전부 지우고** 영숫자·한글·Ø . / + % 만 남긴다.
--              . / + % 는 뜻이 있으므로 남긴다 — 1.5T≠15T, 1/2≠12.
--        품명: 추가로 ◆…◆ 표기·사용금지 접두·(사용금지) 제거(O-RING = O RING = ORING)
--        규격: 추가로 사용금지 접두 제거
--   ※ 구분자를 남기는 안(연속 구분자 → * 하나)은 실데이터에서 같은 품목을 갈라놓았다
--      — 「25A*10K*SO F.F」 181코드 vs 「25A*10K SO F.F」 2코드, 「A312 TP304」 vs 「A312-TP304」 등 77그룹.
--      반대로 전부 지우는 안이 서로 다른 품목을 합칠 위험(Ø30*88 vs Ø308*8)은 전수 검사에서
--      숫자 덩어리가 달라지는 묶음 1건(「12T*60*60」 vs 「12T*6060」 — 이것도 오타로 같은 품목)뿐이었다(2026-09-11).
--   2) erp_ro.item_master_s 에 계산 칼럼 name_key·spec_key(GENERATED ALWAYS … STORED) + 인덱스 2종.
--        ETL 무변경 — 적재 경로는 erp_etl_upsert 하나이고 칼럼을 명시해 INSERT/ON CONFLICT UPDATE 하므로
--        계산 칼럼은 자동으로 다시 계산된다(2026-09-11 함수 정의 확인).
--   3) public.item_dup_search RPC — SECURITY INVOKER. 호출자 권한·RLS(internal_select_item_master_s)가 그대로 적용되어
--        협력사 등 비내부 계정은 0행이다. anon·PUBLIC EXECUTE 회수(42번 교훈), authenticated 에만 부여.
--
-- ⚠ 정규화 규칙(함수 본문)을 바꾸면 저장된 계산 칼럼은 저절로 바뀌지 않는다.
--   바꾼 뒤 `update erp_ro.item_master_s set item_name = item_name, spec = spec;` 로 전건 재계산하고
--   `vacuum (analyze) erp_ro.item_master_s;` 를 돌린다(5.9만 건, 수 초). src_updated·synced_at 은 바뀌지 않는다.
--
-- 되돌리기:
--   drop function if exists public.item_dup_search(text, text, text, integer);
--   alter table erp_ro.item_master_s drop column if exists name_key, drop column if exists spec_key;  -- 인덱스 함께 삭제
--   drop function if exists erp_ro.item_search_tokens(text), erp_ro.item_norm_spec(text),
--                           erp_ro.item_norm_name(text), erp_ro.item_norm_base(text);


-- ───────────────────────── 1) 정규화 함수 (마이그레이션 item_dup_norm_functions) ─────────────────────────

-- 공통 바탕: NFKC · 대문자 · 지름기호 통일 · 곱셈기호와 치수 사이 X 를 * 로
create or replace function erp_ro.item_norm_base(p text)
returns text
language sql immutable parallel safe
set search_path = ''
return pg_catalog.regexp_replace(
  pg_catalog.translate(
    pg_catalog.upper(pg_catalog.normalize(coalesce(p, ''), 'NFKC')),
    'Φ∅⌀×✕', 'ØØØ**'),
  '([0-9.")]|[0-9][A-Z])\s*X\s*(?=[0-9Ø.(]|[A-Z][0-9])', '\1*', 'g');
comment on function erp_ro.item_norm_base(text) is
  'REQ-0030 품목 정규화 바탕 — NFKC·대문자·Φ/∅/⌀→Ø·×/✕/치수 사이 X→*. 44_item_dup_search.sql';

-- 품명 키: 사용금지 표기 제거 → 구분자 전부 제거(영숫자·한글·Ø . / + % 만)
create or replace function erp_ro.item_norm_name(p text)
returns text
language sql immutable parallel safe
set search_path = ''
return pg_catalog.regexp_replace(
  erp_ro.item_norm_base(
    pg_catalog.regexp_replace(coalesce(p, ''),
      '◆[^◆]*◆|^\s*사용\s*금지\s*-?|\(\s*사용\s*금지\s*\)', '', 'g')),
  '[^0-9A-Z가-힣Ø./+%]', '', 'g');
comment on function erp_ro.item_norm_name(text) is
  'REQ-0030 품명 비교키 — ◆…◆·사용금지 표기 제거, 띄어쓰기·기호·구분자 차이 무시. 44_item_dup_search.sql';

-- 규격 키: 사용금지 접두 제거 → 구분자 전부 제거(영숫자·한글·Ø . / + % 만)
create or replace function erp_ro.item_norm_spec(p text)
returns text
language sql immutable parallel safe
set search_path = ''
return pg_catalog.regexp_replace(
  erp_ro.item_norm_base(pg_catalog.regexp_replace(coalesce(p, ''), '^\s*1?사용\s*금지\s*-?', '', 'g')),
  '[^0-9A-Z가-힣Ø./+%]', '', 'g');
comment on function erp_ro.item_norm_spec(text) is
  'REQ-0030 규격 비교키 — 구분자(공백·*·X·콤마·하이픈·괄호) 무시, . / + % 유지. 44_item_dup_search.sql';

-- 검색 토큰: 입력을 공백·* 로 나눠 각 조각을 같은 규칙으로 정리(순서 무관 AND 검색용)
create or replace function erp_ro.item_search_tokens(p text)
returns text[]
language sql immutable parallel safe
set search_path = ''
begin atomic
  select coalesce(pg_catalog.array_agg(x.t) filter (where x.t <> ''), '{}'::text[])
  from pg_catalog.regexp_split_to_table(erp_ro.item_norm_base(p), '[\s*]+') as s(raw)
  cross join lateral (
    select pg_catalog.regexp_replace(s.raw, '[^0-9A-Z가-힣Ø./+%]', '', 'g') as t
  ) as x;
end;
comment on function erp_ro.item_search_tokens(text) is
  'REQ-0030 품목 검색 토큰 — 공백·* 기준 분리 후 정규화. 44_item_dup_search.sql';

-- erp_ro 는 REST 비노출이고 anon 은 USAGE 가 없다. 계산 칼럼이 이 함수를 쓰므로
-- 적재 경로(erp_etl_upsert = SECURITY DEFINER, owner postgres)가 막히지 않게 기본 EXECUTE(PUBLIC)를 그대로 둔다.


-- ───────────────────────── 2) 계산 칼럼 + 인덱스 (마이그레이션 item_master_dup_keys) ─────────────────────────

alter table erp_ro.item_master_s
  add column if not exists name_key text generated always as (erp_ro.item_norm_name(item_name)) stored,
  add column if not exists spec_key text generated always as (erp_ro.item_norm_spec(spec)) stored;

comment on column erp_ro.item_master_s.name_key is
  'REQ-0030 품명 비교키(계산 칼럼) — erp_ro.item_norm_name(item_name). ETL 이 쓰지 않는다.';
comment on column erp_ro.item_master_s.spec_key is
  'REQ-0030 규격 비교키(계산 칼럼) — erp_ro.item_norm_spec(spec). ETL 이 쓰지 않는다.';

-- 같은 품명+규격 묶음 펼치기 / 같은 규격의 코드 수·품명 수(인덱스 전용 스캔). 최대 길이 품명 117B·규격 269B(실측) — btree 한도 여유.
create index if not exists item_master_s_dup_key_idx on erp_ro.item_master_s (name_key, spec_key);
create index if not exists item_master_s_spec_name_idx on erp_ro.item_master_s (spec_key, name_key);


-- ───────────────────────── 3) 조회 RPC (마이그레이션 item_dup_search_rpc → item_dup_search_rpc_plan_fix) ─────────────────────────
-- 입력: 품명 / 규격 / 통합(코드·품명·규격) — 채운 칸은 모두 만족(AND), 칸 안의 여러 단어는 순서 무관.
-- 반환: 검색에 걸린 품목 + 그 품목과 품명+규격이 같은 **전체 마스터의** 다른 코드(matched=false).
--       행마다 묶음 크기·유효 코드 수·같은 규격 전체 코드 수/품명 수를 실어 화면이 그룹을 그린다.
-- 정렬: 중복 묶음 먼저 → 미정리(유효 2개 이상)·정리됨(유효 1개)·전부 사용금지 순 → 묶음 큰 순 → 검색일치 행 먼저.
-- 상한: 기본 1,000행(최대 3,000). 2글자 이상 조각이 하나도 없으면 조회하지 않는다(전건 스캔·전건 반환 방지).
--
-- 실행계획 주의(2026-09-11 실측): 검색일치(hit) 행 수를 planner 가 37행으로 추정한다(실제 17,854).
--   묶음 집계·같은 규격 집계를 CTE 끼리 **조인**하면 중첩 루프로 7천만 회 비교 → 품명 「STS304」 74 s.
--   그래서 ① 묶음 집계는 윈도 함수 ② 검색일치 표시는 IN(hashed SubPlan) ③ 같은 규격 통계는 상한 뒤(≤3,000행)
--   LATERAL 인덱스 전용 스캔 ④ 통합 칸의 코드 비교는 translate(행마다 NFKC·정규식 없음)로 둔다. **CTE 끼리 조인하지 말 것.**
--   실측(내부 계정, RLS 포함): 규격 0.24 s · 코드 0.29 s · 품명+규격 0.17 s · 일치 없음 0.12 s · 「STS304」(1.8만) 0.60 s · 「20」(2.7만) 1.02 s.

create or replace function public.item_dup_search(
  p_name  text    default null,
  p_spec  text    default null,
  p_all   text    default null,
  p_limit integer default 1000
)
returns table (
  item_code      text,
  item_name      text,
  spec           text,
  unit           text,
  item_group_cd  text,
  item_group_nm  text,
  use_yn         boolean,
  forbid         boolean,   -- 품명·규격에 「사용금지」 표기
  dup_key        text,      -- 품명키|규격키 (묶음 식별)
  spec_key       text,
  matched        boolean,   -- 검색 조건에 직접 걸린 행(false = 같은 묶음이라 함께 온 행)
  dup_cnt        integer,   -- 전체 마스터에서 같은 품명+규격 코드 수
  dup_valid_cnt  integer,   -- 그중 사용 가능(use_yn 이고 사용금지 표기 없음)
  spec_cnt       integer,   -- 전체 마스터에서 같은 규격 코드 수(품명 무관)
  spec_name_cnt  integer,   -- 같은 규격의 서로 다른 품명 수
  match_total    integer,   -- 검색 조건에 직접 걸린 전체 건수(상한 적용 전)
  row_total      integer    -- 묶음까지 펼친 전체 행 수(상한 적용 전)
)
language sql
stable
security invoker
set search_path = ''
as $$
  with tok as (
    select erp_ro.item_search_tokens(p_name) as tn,
           erp_ro.item_search_tokens(p_spec) as ts,
           erp_ro.item_search_tokens(p_all)  as ta
  ), ok as (
    select tok.tn, tok.ts, tok.ta
    from tok
    where exists (select 1 from unnest(tok.tn || tok.ts || tok.ta) as u(t) where length(u.t) >= 2)
  ), hit as materialized (
    select i.item_code, i.name_key, i.spec_key
    from erp_ro.item_master_s i
    cross join ok
    where not exists (select 1 from unnest(ok.tn) as u(t) where strpos(i.name_key, u.t) = 0)
      and not exists (select 1 from unnest(ok.ts) as u(t) where strpos(i.spec_key, u.t) = 0)
      and not exists (
        select 1 from unnest(ok.ta) as u(t)
        where strpos(pg_catalog.translate(pg_catalog.upper(i.item_code), '０１２３４５６７８９-', '0123456789')
                     || '|' || i.name_key || '|' || i.spec_key, u.t) = 0)
  ), mem as (
    select i.item_code, i.item_name, i.spec, i.unit, i.item_group_cd, i.use_yn, i.name_key, i.spec_key,
           (coalesce(i.item_name, '') ~ '사용\s*금지' or coalesce(i.spec, '') ~ '^\s*1?사용\s*금지') as forbid,
           (i.item_code in (select h.item_code from hit h)) as matched
    from erp_ro.item_master_s i
    where (i.name_key, i.spec_key) in (select h.name_key, h.spec_key from hit h)
  ), agg as (
    select m.*,
           (count(*) over w)::integer as dup_cnt,
           (count(*) filter (where m.use_yn and not m.forbid) over w)::integer as dup_valid_cnt,
           (count(*) over ())::integer as row_total
    from mem m
    window w as (partition by m.name_key, m.spec_key)
  ), page as (
    select a.*,
           row_number() over (
             order by (a.dup_cnt > 1) desc,
                      (case when a.dup_valid_cnt >= 2 then 0 when a.dup_valid_cnt = 1 then 1 else 2 end),
                      a.dup_cnt desc, a.name_key, a.spec_key, (not a.matched), a.item_code) as rn
    from agg a
    order by rn
    limit greatest(1, least(coalesce(p_limit, 1000), 3000))
  )
  select p.item_code, p.item_name, p.spec, p.unit, p.item_group_cd, ig.item_group_nm, p.use_yn, p.forbid,
         p.name_key || '|' || p.spec_key, p.spec_key, p.matched,
         p.dup_cnt, p.dup_valid_cnt, coalesce(s.spec_cnt, 0), coalesce(s.spec_name_cnt, 0),
         (select count(*) from hit)::integer, p.row_total
  from page p
  left join lateral (
    select count(*)::integer as spec_cnt, count(distinct i.name_key)::integer as spec_name_cnt
    from erp_ro.item_master_s i
    where p.spec_key <> '' and i.spec_key = p.spec_key
  ) s on true
  left join erp_ro.item_group_s ig on ig.item_group_cd = p.item_group_cd
  order by p.rn;
$$;

comment on function public.item_dup_search(text, text, text, integer) is
  'REQ-0030 품목 존재/중복 조회 — 품명/규격/통합 AND 검색 + 전체 마스터 기준 품명+규격 동일 묶음. SECURITY INVOKER(RLS 적용). 44_item_dup_search.sql';

revoke all on function public.item_dup_search(text, text, text, integer) from public, anon;
grant execute on function public.item_dup_search(text, text, text, integer) to authenticated, service_role;
