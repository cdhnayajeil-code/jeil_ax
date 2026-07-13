-- 16_erp_pur_order_hdr.sql
-- ERP 발주원장 헤더 집계 뷰 — 외주발주 프로세스 현황 화면(pages/외주발주_검사진행현황_2026.html) 보드 기본 소스.
-- 적용일 2026-07-13 · Supabase 마이그레이션: create_v_erp_pur_order_hdr
-- 배경: 해당 화면이 협력사 포털 시드(sp_order_header, 8건)만 읽어 ERP 실발주(중간DB 570건)가 미표시였음.
--   → v_erp_pur_order(라인 2,703) 를 발주(po_no) 단위로 집계한 헤더 뷰를 신설해 보드 기본 소스로 승격하고,
--     같은 po_no의 협력사 등록분(sp_photo·sp_inspection·sp_message·sp_order_state)을 오버레이한다.
-- 원칙(08번 파일과 동일): erp_ro는 REST 비노출, 노출 진입점은 public.v_erp_* 뷰뿐.
--   security_invoker=true → 하위 erp_ro.pur_order_s RLS(internal_select)로 사내(role=internal)만 통과(협력사/anon 0행).
-- 재현/이관용 정본. 이 파일은 Supabase에 apply_migration으로 이미 적용된 DDL의 사본이다.
-- 갱신 2026-07-13: project_code(수주번호 so_no, 발주→구매요청 경유) 컬럼 추가 + 조회 인덱스.

create index if not exists idx_pur_req_s_pr_no on erp_ro.pur_req_s(pr_no);

create or replace view public.v_erp_pur_order_hdr
with (security_invoker=true) as
select
  o.po_no,
  min(o.po_dt)                                 as po_dt,
  max(o.dlvy_dt)                               as dlvy_dt,
  max(o.bp_code)                               as bp_code,
  max(o.bp_name)                               as bp_name,
  count(*)                                     as line_cnt,
  count(distinct o.item_name)                  as item_cnt,
  sum(o.po_amt)                                as amt,
  sum(o.po_qty)                                as po_qty,
  sum(o.rcpt_qty)                              as rcpt_qty,
  -- 발주 전체 진행상태 = 가장 덜 진행된 라인 기준(모든 라인 IV여야 매입완료)
  case min(case o.po_sts when 'IV' then 2 when 'GR' then 1 else 0 end)
       when 2 then 'IV' when 1 then 'GR' else 'PO' end as po_sts,
  max(o.subcontra_flg)                         as subcontra_flg,
  array_to_string((array_agg(distinct o.item_name order by o.item_name))[1:8], ', ') as items_txt,
  max(o.synced_at)                             as synced_at,
  -- 프로젝트코드(수주번호 so_no): pur_order_s.pr_no → pur_req_s.so_no. LATERAL(limit 1)로 라인당 1:1 → 합계 왜곡 없음.
  (array_agg(distinct so.so_no) filter (where so.so_no is not null))[1] as project_code
from erp_ro.pur_order_s o
left join lateral (
  select r.so_no from erp_ro.pur_req_s r
  where r.pr_no = o.pr_no and r.so_no is not null and r.so_no <> ''
  limit 1
) so on true
where o.po_dt is not null
group by o.po_no;

grant select on public.v_erp_pur_order_hdr to anon, authenticated;

-- 참고(데이터품질): 현재 ERP 스냅샷은 (1) subcontra_flg 전건 'N'(외주 미분리),
--   (2) 수주번호 so_no 가 구매요청 3,784건 중 2건만 채워져 project_code 실적재 0/570.
--   외주/프로젝트 필터가 유의미해지려면 ETL 의 M_CONFIG_PROCESS 외주구분 + 수주연계(so_no) 매핑
--   보정이 선행되어야 함(유니포인트 협의 · erp-db-connector 점검).
