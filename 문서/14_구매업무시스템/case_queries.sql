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
