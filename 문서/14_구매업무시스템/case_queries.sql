-- 구매 건 추적 예시(case.json)에 넣을 ERP 값을 뽑는 조회문 틀 — 읽기 전용(SELECT 만).
-- 대상은 중간DB(ERP 읽기 전용 사본). 운영 ERP 에 직접 조회하지 않는다(CLAUDE.md §1.2 · §4).
-- 실제 번호·거래처는 여기에 적지 않는다 — 실행할 때 자리표시자(:po_no 등)를 바꿔 넣는다.
-- 결의전표·부가세·국세청 표는 서버 권한으로만 읽힌다(결정 C-15) — 관리자 SQL 편집기에서 실행한다.
-- 결과를 case.json(스키마 pur-case/1)에 옮기고 `_build_case.py "<사례 폴더>"` 로 화면을 만든다.

-- 1) 요청 줄 + 발주 줄 — 발주 한 건 기준(요청 줄은 발주 줄의 요청번호로 거슬러 올라간다)
with po as (select * from erp_ro.pur_order_s where po_no = :po_no)
select r.pu_no, r.pr_no, r.item_code, r.req_qty, r.req_unit, r.req_dt, r.dlvy_dt as need_dt, r.pr_sts, r.req_title, r.req_prsn,
       po.po_no, po.po_seq, po.po_dt, po.dlvy_dt as po_dlvy_dt, po.bp_code, po.bp_name, po.po_qty, po.po_prc, po.po_amt,
       po.po_sts, po.rcpt_qty, po.src_updated, po.synced_at
from po left join erp_ro.pur_req_s r on r.pr_no = po.pr_no
order by po.po_seq;

-- 2) 같은 요청 결재가 다른 거래처로 간 몫 — 요청 결재번호 기준
select r.pu_no, o.po_no, o.po_dt, o.bp_name, count(*) as lines, sum(o.po_amt) as amt
from erp_ro.pur_req_s r join erp_ro.pur_order_s o on o.pr_no = r.pr_no
where r.pu_no = :pu_no
group by r.pu_no, o.po_no, o.po_dt, o.bp_name
order by o.po_no;

-- 3) 입고 — 발주 줄(발주번호 + 순번)마다
select g.mvmt_no, g.po_seq_no, g.mvmt_dt, g.rcpt_dt, g.mvmt_qty, g.io_type_cd
from erp_ro.pur_goods_mvmt_s g
where g.po_no = :po_no
order by g.po_seq_no, g.mvmt_no;

-- 4) 매입 — 발주 줄마다(매입 한 건이 발주 여러 건을 묶기도 한다)
select i.iv_no, i.iv_seq_no, i.iv_dt, i.po_seq_no, i.item_code, i.iv_qty, i.iv_prc, i.iv_loc_amt, i.vat_loc_amt, i.mvmt_no
from erp_ro.iv_dtl_s i
where i.po_no = :po_no
order by i.iv_no, i.iv_seq_no;

-- 5) 결의전표 — 참조번호가 매입번호인 매입 전표(입력유형 AP)
select h.temp_gl_no, h.temp_gl_dt, h.gl_input_type, h.ref_no, h.dr_loc_amt, h.conf_fg, h.gl_no,
       i.item_seq, i.acct_cd, (select max(a.acct_nm) from erp_ro.acct_master_s a where a.acct_cd = i.acct_cd) as acct_nm, i.dr_cr_fg, i.item_loc_amt
from erp_ro.gl_slip_s h join erp_ro.gl_slip_item_s i on i.temp_gl_no = h.temp_gl_no
where h.ref_no = :iv_no and h.gl_input_type = 'AP'
order by i.item_seq;

-- 6) 부가세 원장 — 전표번호로
select v.vat_no, v.issued_dt, v.net_loc_amt, v.vat_loc_amt, v.ref_no, v.io_fg, v.conf_fg
from erp_ro.vat_s v
where v.temp_gl_no = :slip_no;

-- 7) 국세청 전자세금계산서 — 공통 번호가 없어 값 네 개로 맞춘다(매입 구분 · 작성일 · 공급자 사업자번호 · 공급가액)
select e.aprv_no, e.write_date, e.issue_date, e.sup_amt, e.vat_amt, e.item_nm, e.etax_kind, e.etax_type
from erp_ro.etax_master_s e
where e.sapu_type = 'I' and e.write_date = :issue_dt and e.sup_busi_no = :bp_biz_no and e.sup_amt = :supply_amt;

-- 8) 포털 발주통합 LIST 가 이 발주를 어떻게 보여 주는지(화면 상태와 실적 합계를 나란히)
select po_no, status_kr, bool_or(is_unreceived) as unreceived, bool_or(overdue_unreceived) as overdue,
       sum(qty) as po_qty, sum(rcpt_qty_sum) as rcpt_qty_sum, sum(iv_qty_sum) as iv_qty_sum, max(rcpt_last_dt) as rcpt_last, max(iv_last_dt) as iv_last
from public.v_erp_pur_list
where po_no = :po_no
group by po_no, status_kr;

-- 9) 기안서 대장(중간DB 적재분) · 묶음 파일 · 발주 자동 연결
select p.vol, p.no, p.draft_dt, p.drafter, p.job_no, p.content, p.vendor, p.amt, p.closed_yn, p.bp_slip, p.bp_dt, p.src_updated,
       (select s.file_name from public.pur_proposal_scan s where s.vol = p.vol and s.no = p.no and s.matched) as scan_file,
       (select string_agg(l.po_no, ',') from public.v_pur_proposal_po_link l where l.vol = p.vol and l.no = p.no) as po_link
from public.pur_proposal p
where p.vol = :vol and p.no = :no;

-- 10) 발주 한 건의 사슬 전체를 JSON 하나로(P0.5 예시 검증에서 추가 · 2026-10-07) — 위 1)~9) 를 한 번에.
--     매입은 장마다 「이 발주 몫」과 「매입 전체(다른 발주 몫 포함)」를 같이 낸다 — 전표·계산서는 전체와, 발주 몫은 줄과 대조하기 위해.
with po as (select * from erp_ro.pur_order_s where po_no = :po_no),
pr as (select r.* from erp_ro.pur_req_s r where r.pr_no in (select pr_no from po)),
allpr as (select r.* from erp_ro.pur_req_s r where r.pu_no = (select max(pu_no) from pr where pu_no <> '')),
ivs as (select i.* from erp_ro.iv_dtl_s i where i.po_no = :po_no),
slips as (select h.* from erp_ro.gl_slip_s h where h.gl_input_type = 'AP' and h.ref_no in (select distinct iv_no from ivs)),
vats as (select v.* from erp_ro.vat_s v where v.temp_gl_no in (select temp_gl_no from slips))
select json_build_object(
  'pu', (select json_build_object('pu_no', pu_no, 'title', max(req_title), 'req_dt', min(req_dt), 'need_dt', max(dlvy_dt), 'pr_sts', max(pr_sts), 'lines_total', count(*),
           'unordered', (select json_agg(json_build_object('pr_no', a.pr_no, 'item_cd', a.item_code, 'qty', a.req_qty, 'sts', a.pr_sts)) from allpr a where not exists (select 1 from erp_ro.pur_order_s o where o.pr_no = a.pr_no)),
           'other', (select json_agg(json_build_object('bp_nm', bp_name, 'po_no', po_no, 'po_dt', po_dt, 'lines', n, 'amt', amt)) from (select o.po_no, min(o.po_dt) po_dt, max(o.bp_name) bp_name, count(*) n, sum(o.po_amt) amt from erp_ro.pur_order_s o where o.pr_no in (select pr_no from allpr) and o.po_no <> :po_no group by o.po_no) x)) from allpr group by pu_no),
  'pr_lines', (select json_agg(json_build_object('pr_no', r.pr_no, 'item_cd', r.item_code, 'qty', r.req_qty, 'po_seq', po.po_seq) order by po.po_seq) from pr r join po on po.pr_no = r.pr_no),
  'po', (select json_build_object('po_no', :po_no, 'po_dt', min(po_dt), 'dlvy_dt', max(dlvy_dt), 'bp_nm', max(bp_name), 'amt', sum(po_amt),
           'mirror', json_build_object('po_sts', min(po_sts), 'rcpt_qty', sum(rcpt_qty), 'src_updated', max(src_updated)::date, 'synced', max(synced_at)::date),
           'lines', (select json_agg(json_build_object('po_seq', po_seq, 'item_cd', item_code, 'qty', po_qty, 'price', po_prc, 'amt', po_amt, 'pr_no', pr_no) order by po_seq) from po)) from po),
  'gr', (select json_agg(json_build_object('pg_no', mvmt_no, 'dt', rcpt_dt, 'po_seq', po_seq_no, 'qty', rcpt_qty) order by rcpt_dt, mvmt_no) from erp_ro.pur_goods_mvmt_s g where g.po_no = :po_no and g.rcpt_dt is not null and coalesce(g.rcpt_qty, 0) > 0),
  'iv_parts', (select json_agg(json_build_object('iv_no', iv_no, 'iv_dt', iv_dt, 'supply_amt', s, 'vat_amt', v, 'lines', lines,
                 'iv_total', (select json_build_object('supply_amt', sum(t.iv_loc_amt), 'vat_amt', sum(t.vat_loc_amt), 'lines', count(*),
                                'other_pos', (select string_agg(distinct t2.po_no, ',') from erp_ro.iv_dtl_s t2 where t2.iv_no = q.iv_no and t2.po_no <> :po_no)) from erp_ro.iv_dtl_s t where t.iv_no = q.iv_no)) order by iv_dt, iv_no)
               from (select iv_no, min(iv_dt) iv_dt, sum(iv_loc_amt) s, sum(vat_loc_amt) v,
                            json_agg(json_build_object('iv_seq', iv_seq_no, 'po_seq', po_seq_no, 'qty', iv_qty, 'price', iv_prc, 'amt', iv_loc_amt, 'vat', vat_loc_amt, 'pg_no', mvmt_no) order by iv_seq_no) lines from ivs group by iv_no) q),
  'slips', (select json_agg(json_build_object('slip_no', h.temp_gl_no, 'slip_dt', h.temp_gl_dt, 'ref_no', h.ref_no, 'amt', h.dr_loc_amt, 'conf', h.conf_fg,
              'lines', (select json_agg(json_build_object('seq', i.item_seq, 'acct_cd', i.acct_cd, 'drcr', i.dr_cr_fg, 'amt', i.item_loc_amt) order by i.item_seq) from erp_ro.gl_slip_item_s i where i.temp_gl_no = h.temp_gl_no)) order by h.temp_gl_dt) from slips h),
  'vats', (select json_agg(json_build_object('vat_no', vat_no, 'issue_dt', issued_dt, 'supply_amt', net_loc_amt, 'vat_amt', vat_loc_amt, 'ref_no', ref_no, 'slip_no', temp_gl_no)) from vats),
  'etax', (select json_agg(json_build_object('approval_no', e.aprv_no, 'write_dt', e.write_date, 'issue_dt', e.issue_date, 'supply_amt', e.sup_amt, 'vat_amt', e.vat_amt, 'vat_no', v.vat_no))
           from vats v join erp_ro.etax_master_s e on e.sapu_type = 'I' and e.write_date = v.issued_dt and e.sup_busi_no = v.bp_rgst_no and e.sup_amt = v.net_loc_amt),
  'ledger', (select json_agg(json_build_object('vol_no', p.vol||'-'||p.no, 'draft_dt', p.draft_dt, 'job_no_raw', p.job_no, 'amt', p.amt, 'closed', p.closed_yn, 'dp', json_build_object('rate', p.dp_rate, 'slip', p.dp_slip, 'dt', p.dp_dt),
              'mp', json_build_object('rate', p.mp_rate, 'slip', p.mp_slip, 'dt', p.mp_dt), 'bp', json_build_object('rate', p.bp_rate, 'slip', p.bp_slip, 'dt', p.bp_dt), 'link', l.confidence||'/'||l.method))
             from public.v_pur_proposal_po_link l join public.pur_proposal p on p.vol = l.vol and p.no = l.no where l.po_no = :po_no),
  'screen', (select json_build_object('status_kr', string_agg(distinct status_kr, ','), 'unreceived', bool_or(is_unreceived), 'overdue', bool_or(overdue_unreceived), 'po_qty', sum(qty), 'rcpt_qty_sum', sum(rcpt_qty_sum), 'iv_qty_sum', sum(iv_qty_sum))
             from public.v_erp_pur_list s where s.po_no = :po_no and s.row_kind = 'PO')
) as j;
