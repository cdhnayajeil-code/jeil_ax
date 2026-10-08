-- 95_pur_board_case_chain.sql
-- 구매업무시스템 로드맵 P1 — 「진행판」 뷰 + 「구매 건 추적」 함수 + 포털 카드 2행 (2026-10-07 · REQ-0116)
--
-- 번호 꼴: ERP 문서번호는 두 글자 + 12자리(연월일 8 + 순번 4) — 예: PO2026MMDD0001
-- 무엇을 하나
--   ① public.v_erp_pur_board  — 발주 1건 = 1행. 8단계 상태(s1~s8)와 지금 단계(cur_stage)를 **실적 문서의 존재**로 판정한다.
--      규칙은 문서/14_구매업무시스템/04(P0.5 예시 검증)·_build_case.py 와 같다 — 한 곳의 정의를 화면 두 개(진행판·추적)가 쓴다.
--   ② public.pur_case_round(p_po)   — 발주 1건의 사슬 전체를 JSON 하나로(요청→발주→입고→매입→전표→부가세→국세청→대장→화면).
--   ③ public.pur_case_chain(p_key)  — 어떤 번호로 들어와도(PO·PR·PU·PG·IV·TG·기안 권-번호·그 밖은 검색) 발주 건을 찾아 ②를 묶어 준다.
--   ④ public.portal_page 2행 — /work/purchase-board · /work/purchase-trace (구매팀 전용 · 67·88번과 같은 방식 · erp_module null)
--
-- 권한 — 넓히지 않는다(결정 C-15 그대로)
--   · 뷰는 security_invoker, 함수는 security invoker(기본) · stable. 부르는 사람의 RLS 가 그대로 적용된다.
--   · erp_ro 의 결의전표·부가세·국세청 표는 authenticated 에 SELECT grant 자체가 없어(정책도 없음 = 서비스 권한 전용) **참조만 해도 permission denied** 가 난다(실측 2026-10-08).
--     그래서 그 몫은 `pur_case_round_fin` 으로 떼어 `has_table_privilege` 가 참일 때만 부른다 — 사내 사용자에게는 `slips/vats/etax = null` + `fin_locked:true` 로 온다.
--     화면은 그 자리를 「열람 범위 밖(결정 C-15 · REQ-0081)」로 표시한다. 열람을 넓히려면 그 결정 뒤 별도 SQL 로 한다.
--   · 요청·발주·입고·매입·대장은 is_internal() 정책(기존)으로 사내 사용자가 본다.
--
-- 왜 함수인가 — 화면이 번호 하나로 들어오는 "건" 전체를 한 번에 받아야 한다(화면 넷을 오가지 않게 · 기획서 §2).
--   여러 표를 왕복하면 RLS 가 표마다 돌아 느리고, 클라이언트에 조립 규칙이 흩어진다(§3.3 데이터 접근 한 곳).
--
-- 되돌리기: 95_pur_board_case_chain_rollback.sql
-- 확인(적용 뒤): 맨 아래 「확인」 절.

-- ─────────────────────────────────────────────────────────────────────────────
-- ⓪ 기안 ↔ 발주 연결(번호만) — 유일한 security definer 조각
--    `v_pur_proposal_po_link`(SQL 76)는 security_invoker 이고 안에서 결의전표 표를 조인하므로 사내 사용자는 읽을 수 없다
--    (실측 2026-10-08: 참조만 해도 permission denied). 연결 **사실**(권-번호 ↔ 발주번호 · 확정/추정 · 방법)만 내보낸다 —
--    전표 번호·금액은 없다. 결의전표·계산서 열람 범위(C-15)는 그대로다.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.pur_proposal_links()
returns table (vol smallint, no integer, po_no text, confidence text, method text)
language sql
stable
security definer
set search_path = public
as $$
  select l.vol, l.no, l.po_no, l.confidence, l.method from public.v_pur_proposal_po_link l;
$$;
revoke all on function public.pur_proposal_links() from public;
grant execute on function public.pur_proposal_links() to authenticated, service_role;
comment on function public.pur_proposal_links() is
  '기안 ↔ 발주 연결 사실만(권-번호·발주번호·확정/추정·방법) — security definer · 전표 번호·금액 없음(C-15 유지) · REQ-0116';

-- ─────────────────────────────────────────────────────────────────────────────
-- ① 진행판 뷰
-- ─────────────────────────────────────────────────────────────────────────────
create or replace view public.v_erp_pur_board with (security_invoker = true) as
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

-- ─────────────────────────────────────────────────────────────────────────────
-- ② 발주 1건의 사슬 JSON
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.pur_case_round_fin(p_po text)
returns jsonb
language sql
stable
set search_path = public, erp_ro
as $$
with ivs as (select i.* from erp_ro.iv_dtl_s i where i.po_no = p_po),
slips as (select h.* from erp_ro.gl_slip_s h where h.gl_input_type = 'AP' and h.ref_no in (select distinct iv_no from ivs)),
vats as (select v.* from erp_ro.vat_s v where v.temp_gl_no in (select temp_gl_no from slips))
select jsonb_build_object(
  'slips', (select jsonb_agg(jsonb_build_object('slip_no', h.temp_gl_no, 'slip_dt', h.temp_gl_dt, 'ref_no', h.ref_no, 'amt', h.dr_loc_amt, 'conf', h.conf_fg, 'gl_no', h.gl_no) order by h.temp_gl_dt) from slips h),
  'vats', (select jsonb_agg(jsonb_build_object('vat_no', v.vat_no, 'issue_dt', v.issued_dt, 'supply_amt', v.net_loc_amt, 'vat_amt', v.vat_loc_amt, 'ref_no', v.ref_no, 'slip_no', v.temp_gl_no) order by v.issued_dt) from vats v),
  'etax', (select jsonb_agg(jsonb_build_object('approval_no', e.aprv_no, 'write_dt', e.write_date, 'issue_dt', e.issue_date, 'supply_amt', e.sup_amt, 'vat_amt', e.vat_amt, 'vat_no', v.vat_no) order by e.write_date)
           from vats v join erp_ro.etax_master_s e on e.sapu_type = 'I' and e.write_date = v.issued_dt and e.sup_busi_no = v.bp_rgst_no and e.sup_amt = v.net_loc_amt)
);
$$;

comment on function public.pur_case_round_fin(text) is
  '발주 1건의 전표·부가세·국세청 몫(REQ-0116 · SQL 95) — 그 표들에 SELECT 권한이 있는 역할(서비스 권한)에서만 pur_case_round 가 부른다(C-15)';

create or replace function public.pur_case_round(p_po text)
returns jsonb
language plpgsql
stable
set search_path = public, erp_ro
as $$
declare
  base jsonb;
  fin  jsonb := jsonb_build_object('slips', null, 'vats', null, 'etax', null, 'fin_locked', true);
begin
with po as (select * from erp_ro.pur_order_s where po_no = p_po),
pr as (select r.* from erp_ro.pur_req_s r where r.pr_no in (select pr_no from po where pr_no is not null)),
pun as (select max(pu_no) as pu_no from pr where coalesce(pu_no, '') <> ''),
allpr as (select r.* from erp_ro.pur_req_s r where r.pu_no = (select pu_no from pun) and (select pu_no from pun) is not null),
ivs as (select i.* from erp_ro.iv_dtl_s i where i.po_no = p_po),
board as (select * from public.v_erp_pur_board b where b.po_no = p_po)
select jsonb_build_object(
  'po_no', p_po,
  'found', exists (select 1 from po),
  'board', (select to_jsonb(board) - 'synced_at' from board),
  'pu', (select jsonb_build_object('pu_no', pu_no, 'title', max(req_title), 'req_dt', min(req_dt), 'need_dt', max(dlvy_dt),
            'req_dept', max(req_dept), 'req_user', max(req_prsn), 'pr_sts', string_agg(distinct pr_sts, ','),
            'lines_total', count(*), 'lines_this_po', (select count(*) from po where pr_no in (select pr_no from allpr)),
            'unordered', (select jsonb_agg(jsonb_build_object('pr_no', a.pr_no, 'item_cd', a.item_code, 'item_nm', a.item_name, 'qty', a.req_qty, 'sts', a.pr_sts) order by a.pr_no)
                          from allpr a where not exists (select 1 from erp_ro.pur_order_s o where o.pr_no = a.pr_no)),
            'other', (select jsonb_agg(jsonb_build_object('bp_nm', x.bp_name, 'po_no', x.po_no, 'po_dt', x.po_dt, 'lines', x.n, 'amt', x.amt) order by x.po_no)
                      from (select o.po_no, min(o.po_dt) po_dt, max(o.bp_name) bp_name, count(*) n, sum(o.po_amt) amt
                            from erp_ro.pur_order_s o where o.pr_no in (select pr_no from allpr) and o.po_no <> p_po group by o.po_no) x))
          from allpr group by pu_no),
  'pr_lines', (select jsonb_agg(jsonb_build_object('pr_no', r.pr_no, 'item_cd', r.item_code, 'item_nm', r.item_name, 'qty', r.req_qty, 'po_seq', po.po_seq, 'req_dt', r.req_dt, 'need_dt', r.dlvy_dt, 'pr_sts', r.pr_sts) order by po.po_seq)
               from pr r join po on po.pr_no = r.pr_no),
  'po', (select jsonb_build_object('po_no', p_po, 'po_dt', min(po_dt), 'dlvy_dt', max(dlvy_dt), 'bp_cd', max(bp_code), 'bp_nm', max(bp_name),
            'amt', sum(po_amt), 'po_type', max(po_type_cd), 'hdr_remark', max(hdr_remark), 'ref_no', max(ref_no),
            'mirror', jsonb_build_object('po_sts', min(po_sts), 'rcpt_qty', sum(rcpt_qty), 'src_updated', max(src_updated)::date, 'synced', max(synced_at)::date),
            'lines', (select jsonb_agg(jsonb_build_object('po_seq', x.po_seq, 'item_cd', x.item_code, 'item_nm', coalesce(m.item_name, x.item_name), 'spec', m.spec,
                                 'qty', x.po_qty, 'unit', x.po_unit, 'price', x.po_prc, 'amt', x.po_amt, 'pr_no', x.pr_no, 'dlvy_dt', x.dlvy_dt, 'sts', x.po_sts, 'rcpt_raw', x.rcpt_qty, 'remark', x.dtl_remark) order by x.po_seq)
                      from po x left join erp_ro.item_master_s m on m.item_code = x.item_code))
         from po),
  'gr', (select jsonb_agg(jsonb_build_object('pg_no', g.mvmt_no, 'dt', g.rcpt_dt, 'po_seq', g.po_seq_no, 'qty', g.rcpt_qty, 'io', g.io_type_cd) order by g.rcpt_dt, g.mvmt_no)
         from erp_ro.pur_goods_mvmt_s g where g.po_no = p_po and g.rcpt_dt is not null and coalesce(g.rcpt_qty, 0) > 0),
  'iv_parts', (select jsonb_agg(jsonb_build_object('iv_no', q.iv_no, 'iv_dt', q.iv_dt, 'supply_amt', q.s, 'vat_amt', q.v, 'lines', q.lines,
                 'iv_total', (select jsonb_build_object('supply_amt', sum(t.iv_loc_amt), 'vat_amt', sum(t.vat_loc_amt), 'lines', count(*),
                                'other_pos', (select string_agg(distinct t2.po_no, ',') from erp_ro.iv_dtl_s t2 where t2.iv_no = q.iv_no and t2.po_no <> p_po))
                              from erp_ro.iv_dtl_s t where t.iv_no = q.iv_no)) order by q.iv_dt, q.iv_no)
               from (select iv_no, min(iv_dt) iv_dt, sum(iv_loc_amt) s, sum(vat_loc_amt) v,
                            jsonb_agg(jsonb_build_object('iv_seq', iv_seq_no, 'po_seq', po_seq_no, 'qty', iv_qty, 'price', iv_prc, 'amt', iv_loc_amt, 'vat', vat_loc_amt, 'pg_no', mvmt_no) order by iv_seq_no) lines
                     from ivs group by iv_no) q),
  'ledger', (select jsonb_agg(jsonb_build_object('vol_no', p.vol || '-' || p.no, 'vol', p.vol, 'no', p.no, 'draft_dt', p.draft_dt, 'drafter', p.drafter, 'job_no', p.job_no, 'project', p.project,
                 'content', p.content, 'vendor', p.vendor, 'amt', p.amt, 'closed', p.closed_yn,
                 'dp', jsonb_build_object('rate', p.dp_rate, 'slip', p.dp_slip, 'dt', p.dp_dt), 'mp', jsonb_build_object('rate', p.mp_rate, 'slip', p.mp_slip, 'dt', p.mp_dt), 'bp', jsonb_build_object('rate', p.bp_rate, 'slip', p.bp_slip, 'dt', p.bp_dt),
                 'remark', p.remark, 'link', k.confidence, 'method', k.method, 'loaded', p.src_updated::date,
                 'scan_file', (select max(s.file_name) from public.pur_proposal_scan s where s.vol = p.vol and s.no = p.no and s.matched)) order by p.vol, p.no)
             from public.pur_proposal_links() k join public.pur_proposal p on p.vol = k.vol and p.no = k.no where k.po_no = p_po),
  'screen', (select jsonb_build_object('status_kr', string_agg(distinct s.status_kr, ','), 'unreceived', bool_or(s.is_unreceived), 'overdue', bool_or(s.overdue_unreceived),
                 'po_qty', sum(s.qty), 'rcpt_qty_sum', sum(s.rcpt_qty_sum), 'iv_qty_sum', sum(s.iv_qty_sum), 'rcpt_last', max(s.rcpt_last_dt), 'iv_last', max(s.iv_last_dt))
             from public.v_erp_pur_list s where s.po_no = p_po and s.row_kind = 'PO')
) into base;
  -- 전표·부가세·국세청은 SELECT 권한이 있는 역할(서비스 권한)에서만 읽는다 — 권한 없는 역할이 그 표를 참조하면 빈 배열이 아니라 permission denied 가 난다(실측 2026-10-08).
  if has_table_privilege('erp_ro.gl_slip_s', 'select') and has_table_privilege('erp_ro.vat_s', 'select') and has_table_privilege('erp_ro.etax_master_s', 'select') then
    fin := public.pur_case_round_fin(p_po) || jsonb_build_object('fin_locked', false);
  end if;
  return base || fin;
end;
$$;

comment on function public.pur_case_round(text) is
  '발주 1건의 사슬 전체 JSON(REQ-0116 · SQL 95) — security invoker · 전표·부가세·국세청은 서비스 권한에서만 채워진다(C-15)';

-- ─────────────────────────────────────────────────────────────────────────────
-- ③ 번호 하나로 건 찾기
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

revoke all on function public.pur_case_round_fin(text) from public;   -- 기본 EXECUTE(PUBLIC) 제거 — 직접 불러도 invoker 라 거부되지만 표면을 줄인다
grant execute on function public.pur_case_round_fin(text) to service_role;
grant execute on function public.pur_case_round(text) to authenticated, service_role;
grant execute on function public.pur_case_chain(text) to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- ④ 포털 카드 — 구매팀 전용(erp_module null · 67·88번과 같은 이유)
-- ─────────────────────────────────────────────────────────────────────────────
insert into public.portal_page
  (page_key,               title,                    path,                    icon,
   dept_nm,   visibility,  shared_depts, erp_module, sort, active, updated_by,            owner_dept_cd, note)
values
  ('purchase_board_2026',  '구매 진행판 2026',         '/work/purchase-board',  '🧭',
   '구매팀', '부서 전용',   '{}',         null,       49,  true,  'dh.choi@jeilm.co.kr', '5200',
   '구매업무시스템 P1(REQ-0116) · 발주 1건 = 1행 · 8단계 상태를 실적 문서로 판정(뷰 v_erp_pur_board) · 조회 전용'),
  ('purchase_trace_2026',  '구매 건 추적 2026',        '/work/purchase-trace',  '🔗',
   '구매팀', '부서 전용',   '{}',         null,       50,  true,  'dh.choi@jeilm.co.kr', '5200',
   '구매업무시스템 P1(REQ-0116) · 번호 하나(PO·PR·PU·PG·IV·기안)로 요청→발주→입고→매입→대장 전체(함수 pur_case_chain) · 전표·계산서는 열람 범위 밖(C-15) · 조회 전용')
on conflict (page_key) do update
  set title = excluded.title, path = excluded.path, icon = excluded.icon,
      dept_nm = excluded.dept_nm, visibility = excluded.visibility,
      shared_depts = excluded.shared_depts, erp_module = excluded.erp_module,
      sort = excluded.sort, active = excluded.active, note = excluded.note,
      owner_dept_cd = excluded.owner_dept_cd,
      updated_by = excluded.updated_by, updated_at = now();

-- ── 확인 ─────────────────────────────────────────────────────────────────────
-- select cur_stage, count(*) from public.v_erp_pur_board group by 1 order by 1;             -- 단계별 발주 수
-- select s6, s7, count(*) from public.v_erp_pur_board group by 1,2 order by 1,2;            -- 입고·매입 조합
-- select jsonb_pretty(public.pur_case_chain('<발주번호>'));                                    -- 사슬 JSON
-- select page_key, path, sort from public.portal_page where page_key like 'purchase%' order by sort;
