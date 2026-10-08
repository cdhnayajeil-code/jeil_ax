-- 96_pur_board7_slip_trace.sql
-- 구매업무시스템 P1 보강 — 진행판 7단계(LIST 제외) + 결의전표 번호(TG)로 구매 건 추적 (2026-10-08 · REQ-0116 · 관리자 지시)
--
-- 무엇을 바꾸나(SQL 95 를 이어받는다 — 95 의 ⓪ pur_proposal_links · ② pur_case_round / pur_case_round_fin 은 그대로)
--   ① public.v_erp_pur_board  — 8단계 → **7단계**. 정의서의 2 「발주통합관리 LIST」는 단계가 아니라 목록(도구)이라 뺀다(결정 16).
--      s1 요청 · s2 견적(기록 없음) · s3 확정(기록 없음) · s4 품의·발주 · s5 입고·계산서 발행요청 · s6 매입마감·매입전표 · s7 기안서 대장.
--      cur_stage ∈ {1,5,6,7,null}. 판정 규칙은 95 와 글자 하나 다르지 않다 — 번호만 당겨졌다.
--      ⚠ 문서/14 §04(예시 검증)·_build_case.py 는 정의서 번호(8단계)로 적혀 있어 LIST 뒤 단계가 하나씩 다르다(5 입고 = 정의서 6). 문서 재번호는 별도 요청.
--   ② public.pur_slip_trace(p_tg)  — 결의전표 번호 → 발주번호. **유일한 security definer 조각**(사내 사용자는 전표 표를 못 읽는다 · C-15).
--      추적할 수 있는 전표는 두 가지뿐(관리자 지시 · 결정 17):
--        (a) 구매모듈이 만든 매입전표 — gl_input_type = 'AP' 이고 ref_no 가 매입번호(IV)   → 매입(iv_dtl_s).po_no
--        (b) 구매팀이 입력한 결의전표 — dept_cd 가 구매팀                                   → 기안서 대장 전표 칸(계약금·중도금·잔금) 에 적힌 기안 → 기안↔발주 연결(pur_proposal_links)
--      이 두 길 밖(다른 부서 전표·적요 글자·금액 유사)은 쓰지 않는다. 내보내는 것은 **번호뿐**(전표 종류·매입번호·권-번호·발주번호) — 금액·적요·승인 상태 없음.
--      없는 전표와 범위 밖 전표는 똑같이 found:false 로 답한다(다른 부서 전표의 존재 여부도 알려 주지 않는다).
--   ③ public.pur_case_chain(p_key)  — TG 가지를 ② 로 바꾼다(서비스 권한도 같은 규칙). 답에 'slip'(② 결과)을 실어 화면이 어느 매입·기안에 걸렸는지 표시한다.
--   ④ portal_page 카드 2행 note 갱신(7단계 · 전표번호).
--   ⑤ (같은 날 보강 · 마이그레이션 pur_definer_guard_req0116) definer 조각 2종(⓪ pur_proposal_links · ② pur_slip_trace)에 **사내(is_internal)·서비스 권한 판정** + `revoke … from public, anon`.
--      Supabase 기본 권한이 새 함수에 anon·authenticated 실행권을 주므로 `revoke from public` 만으로는 anon 이 남고, 협력사 세션(authenticated·vendor)도 부를 수 있었다(실측: anon 실행권 참).
--      SQL 70 선례대로 막는다 — 사내·서비스 권한 결과는 그대로(연결 2,814 · 추적 동일), 협력사·anon 은 빈 결과/allowed:false. 아래 ⑤ 절이 현행 정의다(② 절은 ⑤ 로 대체).
--
-- 되돌리기: 96_pur_board7_slip_trace_rollback.sql (95 의 뷰·chain 으로 되돌리고 ② 를 지운다)

-- ─────────────────────────────────────────────────────────────────────────────
-- ① 진행판 뷰 — 7단계
--    열이 줄어드는 바꿈이라 create or replace 가 안 된다(뷰는 열을 뺄 수 없다) → drop 뒤 create. 뷰에 기대는 것은 함수 둘뿐이라 하드 의존이 없다.
-- ─────────────────────────────────────────────────────────────────────────────
drop view if exists public.v_erp_pur_board;
create view public.v_erp_pur_board with (security_invoker = true) as
with po as (
  select l.po_no,
         min(l.po_dt)                                   as po_dt,
         max(l.bp_code)                                 as bp_code,
         max(l.bp_name)                                 as bp_name,
         max(l.p_code)                                  as p_code,
         max(l.prj_nm)                                  as prj_nm,
         max(l.agent_nm)                                as agent_nm,
         string_agg(distinct nullif(l.pu_no, ''), ',')  as pu_nos,
         max(l.req_title)                               as req_title,
         max(l.req_dept)                                as req_dept,
         min(l.req_dt)                                  as req_dt,
         max(l.po_dlvy_dt)                              as dlvy_dt,
         max(l.po_type_cd)                              as po_type_cd,
         max(l.whs_nm)                                  as whs_nm,
         count(*)                                       as lines,
         sum(l.amt)                                     as amt,
         sum(l.qty)                                     as po_qty,
         sum(coalesce(l.rcpt_qty_sum, 0))               as rcpt_qty_sum,
         sum(coalesce(l.iv_qty_sum, 0))                 as iv_qty_sum,
         sum(coalesce(l.rcpt_cnt, 0))                   as rcpt_cnt,
         sum(coalesce(l.iv_cnt, 0))                     as iv_cnt,
         min(l.rcpt_first_dt)                           as rcpt_first_dt,
         max(l.rcpt_last_dt)                            as rcpt_last_dt,
         min(l.iv_first_dt)                             as iv_first_dt,
         max(l.iv_last_dt)                              as iv_last_dt,
         count(*) filter (where coalesce(l.pr_no, '') = '')                        as lines_no_pr,
         count(*) filter (where l.qty > 0 and coalesce(l.rcpt_qty_sum, 0) >= l.qty) as lines_rcpt_full,
         count(*) filter (where l.qty > 0 and coalesce(l.iv_qty_sum, 0) >= l.qty)   as lines_iv_full,
         bool_or(l.is_unreceived)                       as unreceived,
         bool_or(l.overdue_unreceived)                  as overdue,
         max(l.synced_at)                               as synced_at
  from public.v_erp_pur_list l
  where l.row_kind = 'PO'
  group by l.po_no
),
led as (
  select k.po_no,
         count(distinct (p.vol, p.no))                              as ledger_cnt,
         string_agg(distinct p.vol || '-' || p.no, ',')             as ledger_vols,
         bool_and(p.closed_yn = 'Y')                                as ledger_closed,
         bool_or(k.confidence = '확정')                              as ledger_confirmed,
         max(p.draft_dt)                                            as ledger_last_dt,
         bool_or(coalesce(p.bp_slip, '') <> '' or coalesce(p.dp_slip, '') <> '' or coalesce(p.mp_slip, '') <> '') as ledger_has_slip
  from public.pur_proposal_links() k
  join public.pur_proposal p on p.vol = k.vol and p.no = k.no
  group by k.po_no
),
st as (
  select po.*, led.ledger_cnt, led.ledger_vols, led.ledger_closed, led.ledger_confirmed, led.ledger_last_dt, led.ledger_has_slip,
         -- 1 구매요청: 발주 줄마다 요청번호가 이어지면 완료 · 일부만이면 일부 · 하나도 없으면 기록 없음
         case when po.lines_no_pr = 0 then 'done' when po.lines_no_pr < po.lines then 'part' else 'norec' end as s1,
         'norec'::text as s2,            -- 2 견적검토: ERP 에 기록이 없다(P2 포털 기록 전까지)
         'norec'::text as s3,            -- 3 구매확정: 결과만 발주로 남는다
         'done'::text  as s4,            -- 4 품의·발주: 발주가 있다(발주통합 LIST 는 이 발주의 목록이지 단계가 아니다 — 결정 16)
         -- 5 입고: 전량 입고 완료 / 일부 / 입고 기록 없이 매입으로 끝남(외주·용역·진척 매입 — P0.5 ①②) / 아직
         case when po.po_qty > 0 and po.rcpt_qty_sum >= po.po_qty then 'done'
              when po.rcpt_qty_sum > 0 then 'part'
              when po.po_qty > 0 and po.iv_qty_sum >= po.po_qty then 'norec'
              else 'todo' end as s5,
         -- 6 매입: 매입 수량이 발주 수량을 채우면 완료(전표 승인은 열람 범위 밖이라 보지 않는다)
         case when po.po_qty > 0 and po.iv_qty_sum >= po.po_qty then 'done'
              when po.iv_qty_sum > 0 then 'part'
              else 'todo' end as s6,
         -- 7 대장: 연결된 기안이 있고 종결이면 완료 · 있으면 일부 · 없으면 아직
         case when led.ledger_cnt is null then 'todo' when led.ledger_closed then 'done' else 'part' end as s7
  from po left join led on led.po_no = po.po_no
)
select st.*,
       -- 지금 서 있는 단계: 기록이 남는 주 흐름(1·5·6·7)에서 처음 만나는 「아직/일부」(4 는 항상 완료 · 2·3 은 기록 없음)
       case when st.s1 in ('todo', 'part') then 1
            when st.s5 in ('todo', 'part') then 5
            when st.s6 in ('todo', 'part') then 6
            when st.s7 in ('todo', 'part') then 7
            else null end as cur_stage,
       case when st.s6 = 'done' then '매입완료'
            when st.s5 = 'done' then '입고완료'
            when st.s5 = 'part' then '부분입고'
            else '발주' end as status_kr,
       (current_date - st.po_dt) as days_since_po,
       case when st.req_dt is not null then (st.po_dt - st.req_dt) end as days_req_to_po,
       case when st.rcpt_first_dt is not null then (st.rcpt_first_dt - st.po_dt) end as days_po_to_rcpt
from st;

grant select on public.v_erp_pur_board to authenticated, service_role;

comment on view public.v_erp_pur_board is
  '구매 진행판(REQ-0116 · 정본 SQL 96) — 발주 1건 = 1행 · 7단계 상태 s1~s7(done/part/norec/todo · 정의서 8단계에서 2 LIST 제외 — 결정 16) · cur_stage ∈ {1,5,6,7} · security_invoker';

-- ─────────────────────────────────────────────────────────────────────────────
-- ② 결의전표 번호 → 발주번호 (security definer · 번호만)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.pur_slip_trace(p_tg text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
with k as (
  select upper(regexp_replace(coalesce(p_tg, ''), '\s', '', 'g')) as tg
),
s as (   -- 추적 대상 전표: (a) 구매모듈 매입전표(AP · ref_no = 매입번호) 또는 (b) 구매팀이 입력한 전표(dept_cd = 구매팀 5200 · erp_ro.dept_master_s · portal_page.owner_dept_cd 와 같다)
  select h.temp_gl_no,
         case when h.gl_input_type = 'AP' and h.ref_no like 'IV%' then 'AP매입' else '구매팀입력' end as kind,
         case when h.gl_input_type = 'AP' and h.ref_no like 'IV%' then h.ref_no end as iv_no
    from erp_ro.gl_slip_s h, k
   where k.tg ~ '^TG\d{12}$' and h.temp_gl_no = k.tg
     and ((h.gl_input_type = 'AP' and h.ref_no like 'IV%') or btrim(coalesce(h.dept_cd, '')) = any ('{5200}'::text[]))
),
ivs as (  -- (a) 매입 → 발주
  select distinct i.iv_no, i.po_no
    from s join erp_ro.iv_dtl_s i on i.iv_no = s.iv_no
),
led as (  -- (b) 기안서 대장 전표 칸(계약금·중도금·잔금 · 한 칸에 여러 번호 · 공백·쉼표·슬래시 구분)에 이 전표가 적힌 기안
  select distinct p.vol, p.no
    from public.pur_proposal p, s
   where s.temp_gl_no = any (regexp_split_to_array(btrim(concat_ws(' ', p.dp_slip, p.mp_slip, p.bp_slip)), '[\s,/]+'))
),
lpo as (  -- 기안 → 발주(연결 사실만 · SQL 95 ⓪)
  select distinct l.po_no
    from public.pur_proposal_links() l join led on led.vol = l.vol and led.no = l.no
   where l.po_no is not null
)
select jsonb_build_object(
  'tg',     (select tg from k),
  'found',  exists (select 1 from s),
  'kind',   (select kind from s limit 1),
  'iv_nos', (select coalesce(jsonb_agg(distinct iv_no), '[]'::jsonb) from ivs),
  'vols',   (select coalesce(jsonb_agg(vol || '-' || no order by vol || '-' || no), '[]'::jsonb) from led),
  'po_nos', (select coalesce(jsonb_agg(distinct po_no), '[]'::jsonb)
               from (select po_no from ivs where po_no is not null union select po_no from lpo) u)
);
$$;
revoke all on function public.pur_slip_trace(text) from public;
grant execute on function public.pur_slip_trace(text) to authenticated, service_role;
comment on function public.pur_slip_trace(text) is
  '결의전표 번호(TG) → 발주번호 — 구매모듈 매입전표(AP·ref_no=IV) 와 구매팀 입력 전표(dept_cd 5200)만, 길은 매입 ref 와 기안서 대장 전표 칸 둘뿐(결정 17) · security definer · 번호만 내보낸다(C-15 유지) · REQ-0116 · SQL 96';

-- ─────────────────────────────────────────────────────────────────────────────
-- ③ 번호 하나로 건 찾기 — TG 가지를 ② 로
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.pur_case_chain(p_key text)
returns jsonb
language plpgsql
stable
set search_path = public, erp_ro
as $$
declare
  k    text := upper(regexp_replace(coalesce(p_key, ''), '\s', '', 'g'));
  kind text;
  pos  text[];
  slip jsonb;
  lim  int := 30;
begin
  if k = '' then
    return jsonb_build_object('key', p_key, 'kind', '', 'po_count', 0, 'rounds', '[]'::jsonb, 'note', '번호를 넣으세요');
  end if;
  if k ~ '^PO\d{12}$' then
    kind := 'PO'; pos := array(select distinct po_no from erp_ro.pur_order_s where po_no = k);
  elsif k ~ '^PR\d{12}$' then
    kind := 'PR'; pos := array(select distinct po_no from erp_ro.pur_order_s where pr_no = k);
  elsif k ~ '^PU\d{12}$' then
    kind := 'PU'; pos := array(select distinct o.po_no from erp_ro.pur_order_s o join erp_ro.pur_req_s r on r.pr_no = o.pr_no where r.pu_no = k order by 1);
  elsif k ~ '^PG\d{12}$' then
    kind := 'PG'; pos := array(select distinct po_no from erp_ro.pur_goods_mvmt_s where mvmt_no = k);
  elsif k ~ '^IV\d{12}$' then
    kind := 'IV'; pos := array(select distinct po_no from erp_ro.iv_dtl_s where iv_no = k order by 1);
  elsif k ~ '^TG\d{12}$' then
    -- 결의전표: 구매모듈 매입전표·구매팀 입력 전표만, 매입 ref 와 대장 전표 칸으로만 잇는다(결정 17 · 함수 pur_slip_trace · 번호만)
    kind := 'TG';
    slip := public.pur_slip_trace(k);
    pos := array(select x from jsonb_array_elements_text(coalesce(slip->'po_nos', '[]'::jsonb)) as t(x) order by 1);
  elsif k ~ '^\d{1,3}-\d{1,5}$' then
    kind := '기안'; pos := array(select distinct l.po_no from public.pur_proposal_links() l where l.vol = split_part(k, '-', 1)::int and l.no = split_part(k, '-', 2)::int order by 1);
  else
    -- 번호 꼴이 아니면 검색: 발주번호 일부 · P-CODE(프로젝트) · 거래처명 · 요청 건명 — 최근 발주부터 lim 건
    kind := '검색';
    pos := array(select po_no from (
             select distinct b.po_no, b.po_dt from public.v_erp_pur_board b
             where b.po_no ilike '%' || k || '%' or coalesce(b.p_code, '') ilike '%' || k || '%'
                or coalesce(b.bp_name, '') ilike '%' || p_key || '%' or coalesce(b.req_title, '') ilike '%' || p_key || '%'
                or coalesce(b.prj_nm, '') ilike '%' || p_key || '%'
             order by b.po_dt desc, b.po_no desc limit lim) s);
  end if;

  return jsonb_build_object(
    'key', p_key, 'kind', kind,
    'po_count', coalesce(array_length(pos, 1), 0),
    'truncated', (kind = '검색' and coalesce(array_length(pos, 1), 0) >= lim),
    'rounds', coalesce((select jsonb_agg(public.pur_case_round(x.po_no) order by x.po_no) from unnest(pos) as x(po_no)), '[]'::jsonb),
    -- 요청 결재(PU)로 들어왔으면 발주 없이 남은 요청 줄도 같이 준다(접수함 선행 · P0.5 ④)
    'pu_unordered', case when kind = 'PU' then
        (select jsonb_agg(jsonb_build_object('pr_no', a.pr_no, 'item_cd', a.item_code, 'item_nm', a.item_name, 'qty', a.req_qty, 'sts', a.pr_sts, 'req_dt', a.req_dt) order by a.pr_no)
         from erp_ro.pur_req_s a where a.pu_no = k and not exists (select 1 from erp_ro.pur_order_s o where o.pr_no = a.pr_no)) end,
    -- 전표로 들어왔으면 어느 매입·기안에 걸렸는지(번호만) — 화면이 사슬 상자에 표시한다
    'slip', slip,
    'note', case when kind = 'TG' then
        case when not coalesce((slip->>'found')::boolean, false)
               then '이 번호는 구매팀이 입력한 전표도, 구매모듈(매입)에서 만들어진 매입전표도 아니라 여기서는 추적하지 않는다(또는 중간DB 에 없다) — 다른 부서 전표는 ERP 에서 본다'
             when coalesce(array_length(pos, 1), 0) = 0 and slip->>'kind' = 'AP매입'
               then '구매 매입전표이지만 그 매입(IV)에 발주번호가 없어 발주를 찾지 못했다'
             when coalesce(array_length(pos, 1), 0) = 0
               then '구매팀 입력 전표이지만 기안서 대장 전표 칸에 없거나 그 기안이 발주와 이어지지 않아 발주를 찾지 못했다'
                    || case when jsonb_array_length(coalesce(slip->'vols', '[]'::jsonb)) > 0 then ' — 대장 ' || (select string_agg(v, ', ') from jsonb_array_elements_text(slip->'vols') v) else '' end
        end end
  );
end;
$$;

comment on function public.pur_case_chain(text) is
  '번호 하나(PO·PR·PU·PG·IV·TG·기안 권-번호, 그 밖은 검색)로 구매 건 전체를 돌려준다(REQ-0116 · SQL 96) — security invoker · TG 는 pur_slip_trace(구매팀·구매 매입전표만)';

grant execute on function public.pur_case_chain(text) to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- ④ 포털 카드 note
-- ─────────────────────────────────────────────────────────────────────────────
update public.portal_page set
  note = '구매업무시스템 P1(REQ-0116) · 발주 1건 = 1행 · 7단계 상태를 실적 문서로 판정(뷰 v_erp_pur_board · LIST 는 단계 아님) · 표준 그리드 · 조회 전용',
  updated_by = 'dh.choi@jeilm.co.kr', updated_at = now()
 where page_key = 'purchase_board_2026';
update public.portal_page set
  note = '구매업무시스템 P1(REQ-0116) · 번호 하나(PO·PR·PU·PG·IV·기안·전표 TG)로 요청→발주→입고→매입→대장 전체(함수 pur_case_chain) · 전표는 구매팀 입력·구매 매입전표만 번호로 잇는다(pur_slip_trace) · 금액·승인은 열람 범위 밖(C-15) · 조회 전용',
  updated_by = 'dh.choi@jeilm.co.kr', updated_at = now()
 where page_key = 'purchase_trace_2026';

-- ── 확인 ─────────────────────────────────────────────────────────────────────
-- select cur_stage, count(*) from public.v_erp_pur_board group by 1 order by 1;             -- 1·5·6·7·null 만 나와야 한다
-- select jsonb_pretty(public.pur_slip_trace('<전표번호>'));                                   -- found·kind·iv_nos·vols·po_nos
-- select jsonb_pretty(public.pur_case_chain('<전표번호>') - 'rounds');                         -- slip·note

-- ─────────────────────────────────────────────────────────────────────────────
-- ⑤ 보강(2026-10-08 · pur_definer_guard_req0116) — definer 조각 2종 사내 판정 + anon 회수 · 현행 정의
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.pur_proposal_links()
returns table (vol smallint, no integer, po_no text, confidence text, method text)
language sql stable security definer set search_path = public as $$
  select l.vol, l.no, l.po_no, l.confidence, l.method
    from public.v_pur_proposal_po_link l
   where public.is_internal() or coalesce(auth.jwt() ->> 'role', '') = 'service_role';   -- 사내 또는 서비스 권한만 · 그 밖은 빈 결과
$$;
revoke all on function public.pur_proposal_links() from public, anon;
grant execute on function public.pur_proposal_links() to authenticated, service_role;
comment on function public.pur_proposal_links() is
  '기안 ↔ 발주 연결 사실만(권-번호·발주번호·확정/추정·방법) — security definer · 사내(is_internal)·서비스 권한만, 그 밖은 빈 결과 · anon 회수 · 전표 번호·금액 없음(C-15 유지) · REQ-0116 · SQL 95 ⓪ + 96 ⑤';

create or replace function public.pur_slip_trace(p_tg text)
returns jsonb language sql stable security definer set search_path = public as $$
with ok as (   -- 사내 또는 서비스 권한만 · 그 밖은 allowed:false 로 아무것도 찾지 않는다
  select (public.is_internal() or coalesce(auth.jwt() ->> 'role', '') = 'service_role') as allowed
),
k as (
  select case when ok.allowed then upper(regexp_replace(coalesce(p_tg, ''), '\s', '', 'g')) else '' end as tg, ok.allowed from ok
),
s as (   -- 추적 대상 전표: (a) 구매모듈 매입전표(AP · ref_no = 매입번호) 또는 (b) 구매팀이 입력한 전표(dept_cd = 구매팀 5200)
  select h.temp_gl_no,
         case when h.gl_input_type = 'AP' and h.ref_no like 'IV%' then 'AP매입' else '구매팀입력' end as kind,
         case when h.gl_input_type = 'AP' and h.ref_no like 'IV%' then h.ref_no end as iv_no
    from erp_ro.gl_slip_s h, k
   where k.tg ~ '^TG\d{12}$' and h.temp_gl_no = k.tg
     and ((h.gl_input_type = 'AP' and h.ref_no like 'IV%') or btrim(coalesce(h.dept_cd, '')) = any ('{5200}'::text[]))
),
ivs as (  -- (a) 매입 → 발주
  select distinct i.iv_no, i.po_no from s join erp_ro.iv_dtl_s i on i.iv_no = s.iv_no
),
led as (  -- (b) 기안서 대장 전표 칸(계약금·중도금·잔금 · 한 칸에 여러 번호)에 이 전표가 적힌 기안
  select distinct p.vol, p.no from public.pur_proposal p, s
   where s.temp_gl_no = any (regexp_split_to_array(btrim(concat_ws(' ', p.dp_slip, p.mp_slip, p.bp_slip)), '[\s,/]+'))
),
lpo as (  -- 기안 → 발주(연결 사실만)
  select distinct l.po_no from public.pur_proposal_links() l join led on led.vol = l.vol and led.no = l.no where l.po_no is not null
)
select jsonb_build_object(
  'tg',      (select nullif(tg, '') from k),
  'allowed', (select allowed from k),
  'found',   exists (select 1 from s),
  'kind',    (select kind from s limit 1),
  'iv_nos',  (select coalesce(jsonb_agg(distinct iv_no), '[]'::jsonb) from ivs),
  'vols',    (select coalesce(jsonb_agg(vol || '-' || no order by vol || '-' || no), '[]'::jsonb) from led),
  'po_nos',  (select coalesce(jsonb_agg(distinct po_no), '[]'::jsonb)
                from (select po_no from ivs where po_no is not null union select po_no from lpo) u));
$$;
revoke all on function public.pur_slip_trace(text) from public, anon;
grant execute on function public.pur_slip_trace(text) to authenticated, service_role;
comment on function public.pur_slip_trace(text) is
  '결의전표 번호(TG) → 발주번호 — 구매모듈 매입전표(AP·ref_no=IV) 와 구매팀 입력 전표(dept_cd 5200)만, 길은 매입 ref 와 기안서 대장 전표 칸 둘뿐(결정 17) · security definer · 사내(is_internal)·서비스 권한만(allowed) · anon 회수 · 번호만(C-15 유지) · REQ-0116 · SQL 96';

-- ── 확인(⑤) ──────────────────────────────────────────────────────────────────
-- select has_function_privilege('anon', 'public.pur_slip_trace(text)', 'execute'), has_function_privilege('anon', 'public.pur_proposal_links()', 'execute');  -- 둘 다 false
-- 협력사 claim(authenticated · app_metadata.role=vendor)으로: select count(*) from public.pur_proposal_links();  -- 0 · pur_slip_trace(...)->>'allowed' = false
