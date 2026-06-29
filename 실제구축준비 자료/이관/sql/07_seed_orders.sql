-- 07_seed_orders.sql
-- 협력사 발주 샘플 데이터 (데모) — ERP 실데이터 금지, vendor_master(마스킹) 기반 가공 샘플
-- 계정 거래처 중심: 02128((주)삼성○○티)·00206((주)대신○○○스) + 대시보드용 타 거래처
-- 적용: Supabase Management API(/database/query)

-- 0) RLS 테스트 잔여 정리
delete from public.sp_order_state where po_no in ('PO202606220012','PO202606220033');

-- 1) 발주 헤더
insert into public.sp_order_header (po_no,bp_cd,vendor_name,order_date,due_date,po_type,project_code,items,amt) values
('PO202607010128','02128','(주)삼성○○티','2026-07-01','2026-07-15','SIE','2025-095-SUL-EC',
  '[{"pn":"PLT-AL5T","nm":"알루미늄 브라켓 가공","spec":"5T×1000×2000 절단·CNC","qty":500,"unit":"EA","price":3200}]'::jsonb, 1600000),
('PO202607020128','02128','(주)삼성○○티','2026-07-02','2026-07-12','SIE','2025-095-SUL-EC',
  '[{"pn":"FRM-ST3","nm":"스틸 프레임 용접 조립","spec":"SS400 3T 용접","qty":120,"unit":"EA","price":18500}]'::jsonb, 2220000),
('PO202607030128','02128','(주)삼성○○티','2026-07-03','2026-07-25','SIE-1','2026-012-PWR',
  '[{"pn":"SHF-S45C","nm":"정밀 샤프트 가공","spec":"Ø30×450 연삭","qty":80,"unit":"EA","price":42000}]'::jsonb, 3360000),
('PO202607010206','00206','(주)대신○○○스','2026-07-01','2026-07-18','SIE','2025-095-SUL-EC',
  '[{"pn":"CSE-SUS","nm":"판금 케이스 제작","spec":"SUS304 1.5T 절곡·도장","qty":200,"unit":"EA","price":9800}]'::jsonb, 1960000),
('PO202607020206','00206','(주)대신○○○스','2026-06-20','2026-07-05','SIE','2025-088-MOT',
  '[{"pn":"GBX-A1","nm":"기어박스 어셈블리","spec":"감속비 1:20","qty":40,"unit":"SET","price":135000}]'::jsonb, 5400000),
('PO202607010209','00209','(주)서일○텐','2026-07-01','2026-07-20','DIV','2026-012-PWR',
  '[{"pn":"PIP-SCH40","nm":"배관 자재 SET","spec":"STS 50A SCH40","qty":300,"unit":"M","price":7400}]'::jsonb, 2220000),
('PO202607010768','01768','(주)엠○텍','2026-06-28','2026-07-10','SIE','2025-095-SUL-EC',
  '[{"pn":"WH-EL12","nm":"전장 하네스 제작","spec":"12P 커넥터 조립","qty":150,"unit":"EA","price":12600}]'::jsonb, 1890000),
('PO202607014521','4521','(주)지아○텍','2026-07-03','2026-07-28','SIE-1','2026-020-INJ',
  '[{"pn":"INJ-PC01","nm":"사출 성형품","spec":"PC 흑색 t2.0","qty":2000,"unit":"EA","price":850}]'::jsonb, 1700000)
on conflict (po_no) do nothing;

-- 2) 진행 상태 (new/prod/insp/done · step 1~10)
insert into public.sp_order_state (po_no,bp_cd,status,step,updated_by) values
('PO202607010128','02128','prod',3,'ERP배치'),
('PO202607020128','02128','insp',6,'ERP배치'),
('PO202607030128','02128','new',1,'ERP배치'),
('PO202607010206','00206','prod',4,'ERP배치'),
('PO202607020206','00206','done',9,'ERP배치'),
('PO202607010209','00209','prod',2,'ERP배치'),
('PO202607010768','01768','insp',5,'ERP배치'),
('PO202607014521','4521','new',1,'ERP배치')
on conflict (po_no) do update set status=excluded.status, step=excluded.step, updated_at=now();

-- 3) 초기 메시지 (사내→협력사, 시연)
insert into public.sp_message (po_no,bp_cd,sender_role,sender_id,body) values
('PO202607010128','02128','internal','김도현(구매2팀)','PO202607010128 생산 일정 공유 부탁드립니다.'),
('PO202607020128','02128','internal','김도현(구매2팀)','용접부 외관 사진 등록 후 검수요청 부탁드립니다.'),
('PO202607010206','00206','internal','박서준(구매1팀)','도장 색상 RAL7016 확인 부탁드립니다.');

-- 4) 검수 요청 (insp 단계)
insert into public.sp_insp_request (po_no,bp_cd,insp_req_no,requested_by) values
('PO202607020128','02128','IR202607100128','삼성○○티 담당'),
('PO202607010768','01768','IR202607080768','엠○텍 담당');
