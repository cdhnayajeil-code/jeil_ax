-- 96_pur_board7_slip_trace_rollback.sql — 96 되돌리기(REQ-0116)
-- 뷰·chain 을 SQL 95(8단계 · TG 는 서비스 권한만) 그대로 되돌리고, 전표 추적 함수를 지운다. 포털 카드 note 도 95 문구로.
drop function if exists public.pur_slip_trace(text);
-- ⑤ 가드만 되돌리려면(함수는 두고): 95 의 ⓪ pur_proposal_links 정의를 다시 실행한다(anon 회수는 유지 권장). pur_slip_trace 는 위 drop 으로 함께 사라진다.

-- ① 뷰 — 95 의 8단계 정의 그대로(열이 늘어나므로 drop 뒤 create)
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
         'done'::text  as s2,            -- 2 LIST: ERP 발주가 곧 포털 LIST 의 줄
         'norec'::text as s3,            -- 3 견적: ERP 에 기록이 없다(P2 포털 기록 전까지)
         'norec'::text as s4,            -- 4 구매확정: 결과만 발주로 남는다
         'done'::text  as s5,            -- 5 품의·발주: 발주가 있다
         -- 6 입고: 전량 입고 완료 / 일부 / 입고 기록 없이 매입으로 끝남(외주·용역·진척 매입 — P0.5 ①②) / 아직
         case when po.po_qty > 0 and po.rcpt_qty_sum >= po.po_qty then 'done'
              when po.rcpt_qty_sum > 0 then 'part'
              when po.po_qty > 0 and po.iv_qty_sum >= po.po_qty then 'norec'
              else 'todo' end as s6,
         -- 7 매입: 매입 수량이 발주 수량을 채우면 완료(전표 승인은 열람 범위 밖이라 보지 않는다)
         case when po.po_qty > 0 and po.iv_qty_sum >= po.po_qty then 'done'
              when po.iv_qty_sum > 0 then 'part'
              else 'todo' end as s7,
         -- 8 대장: 연결된 기안이 있고 종결이면 완료 · 있으면 일부 · 없으면 아직
         case when led.ledger_cnt is null then 'todo' when led.ledger_closed then 'done' else 'part' end as s8
  from po left join led on led.po_no = po.po_no
)
select st.*,
       -- 지금 서 있는 단계: 기록이 남는 주 흐름(1·6·7·8)에서 처음 만나는 「아직/일부」(2·5 는 항상 완료)
       case when st.s1 in ('todo', 'part') then 1
            when st.s6 in ('todo', 'part') then 6
            when st.s7 in ('todo', 'part') then 7
            when st.s8 in ('todo', 'part') then 8
            else null end as cur_stage,
       case when st.s7 = 'done' then '매입완료'
            when st.s6 = 'done' then '입고완료'
            when st.s6 = 'part' then '부분입고'
            else '발주' end as status_kr,
       (current_date - st.po_dt) as days_since_po,
       case when st.req_dt is not null then (st.po_dt - st.req_dt) end as days_req_to_po,
       case when st.rcpt_first_dt is not null then (st.rcpt_first_dt - st.po_dt) end as days_po_to_rcpt
from st;

grant select on public.v_erp_pur_board to authenticated, service_role;

comment on view public.v_erp_pur_board is
  '구매 진행판(REQ-0116 · 정본 SQL 95) — 발주 1건 = 1행 · 8단계 상태 s1~s8(done/part/norec/todo) · cur_stage · 규칙은 문서/14 §04 와 같다 · security_invoker';

-- ③ chain — 95 그대로
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
    -- 전표 표는 서비스 권한 전용(C-15) — 사내 사용자에게는 빈 결과. 화면이 사유를 보여 준다.
    kind := 'TG';
    if has_table_privilege('erp_ro.gl_slip_s', 'select') then
      pos := array(select distinct i.po_no from erp_ro.gl_slip_s h join erp_ro.iv_dtl_s i on i.iv_no = h.ref_no where h.temp_gl_no = k order by 1);
    else
      pos := '{}';
    end if;
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
    'note', case when kind = 'TG' then '결의전표 번호로 찾기는 서비스 권한에서만 된다(결정 C-15) — 사내 사용자는 매입번호(IV)·발주번호로 찾는다' end
  );
end;
$$;

comment on function public.pur_case_chain(text) is
  '번호 하나(PO·PR·PU·PG·IV·TG·기안 권-번호, 그 밖은 검색)로 구매 건 전체를 돌려준다(REQ-0116 · SQL 95) — security invoker';
grant execute on function public.pur_case_chain(text) to authenticated, service_role;

-- ④ 포털 카드 note — 95 문구
update public.portal_page set note = '구매업무시스템 P1(REQ-0116) · 발주 1건 = 1행 · 8단계 상태를 실적 문서로 판정(뷰 v_erp_pur_board) · 조회 전용', updated_at = now() where page_key = 'purchase_board_2026';
update public.portal_page set note = '구매업무시스템 P1(REQ-0116) · 번호 하나(PO·PR·PU·PG·IV·기안)로 요청→발주→입고→매입→대장 전체(함수 pur_case_chain) · 전표·계산서는 열람 범위 밖(C-15) · 조회 전용', updated_at = now() where page_key = 'purchase_trace_2026';
