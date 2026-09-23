-- 73_etax_vat_mirror.sql
-- 국세청(e세로) 전자세금계산서 + 부가세 계산서 원장 미러 (REQ-0082 · REQ-0081 의 2단계)
-- 작성: 2026-09-23 · 되돌리기: 73_etax_vat_mirror_rollback.sql
--
-- ── 왜 만드나 ────────────────────────────────────────────────────────────────
-- ERP 메뉴 「전자금융CMS(CM) > 홈택스(Vat)(CM9)」 아래 세 화면이
--   · 전자세금계산서내역조회(홈택스) CM902M1
--   · 전자세금계산서조회(S)        CM903M1_KO174
--   · ERP자료대사(S)               CM903M2_KO174   ← e세로 ↔ ERP 를 나란히 비교
-- 이미 국세청 원본을 들고 있다. 2026-09-23 ERP 운영DB 실측으로 두 축의 정본을 확정했다
-- (ERP 저장프로시저 `USP_CREATE_ETAX_REP` 의 로직을 그대로 재현 — 화면 수치 오차 0):
--
--   축        | 원천                      | 조건                                              | 2026-09-01~09-23 매입·이천
--   ----------|---------------------------|---------------------------------------------------|---------------------------
--   e세로     | A_TS_ETAX_MASTER          | SAPU_TYPE='I' · BUY_BUSI_NO='1248114298'          | 75매 792,279,874 / 79,129,442
--             |                           | · WRITE_DATE between '20260901' and '20260923'     |
--   ERP       | A_VAT (뷰 AV_A_VAT_ETAX)  | 동일 조건(WRITE_DATE = ISSUED_DT)                  | 73매 709,085,382 / 70,837,992
--
-- 기존에 REQ-0081 이 쓰던 **전표 관리항목(V1 공급가액·V8 부가세·V5 신고사업장)** 계산은
-- 매수(73)는 정확히 맞았지만 금액이 0.09% 어긋났다(708,463,942 / 70,846,378).
-- **A_VAT 이 오차 없는 정본**이므로 이제부터 계산서 축은 이 원장을 쓴다.
--
-- ⭐ 가장 큰 수확: `A_VAT` 이 **세금계산서 ↔ 결의전표**를 직접 잇는다.
--    `TEMP_GL_NO`+`TEMP_ITEM_SEQ`(결의전표) · `GL_NO`+`ITEM_SEQ`(확정전표) 가 테이블 컬럼으로 있다.
--    REQ-0081 이 관리항목으로 추정하던 「이 전표의 계산서」를 **추정 없이** 확정할 수 있다.
--    (반대로 `A_TS_ETAX_MASTER` 42컬럼에는 전표번호가 **없다** — 확장슬롯에도 없음을 값으로 확인했다.
--     그래서 국세청 승인번호 ↔ 전표는 「사업자번호+작성일+공급가액」 3축 매칭이며, 이 SQL 도 그렇게 잇는다.)
--
-- ⚠ ERP 축의 모집단은 `A_VAT` 전량이 아니다. 뷰 `AV_A_VAT_ETAX` 가
--   `B_TAX_BIZ_AREA`(신고사업장) · `B_CONFIGURATION`(MAJOR_CD='B9001' · SEQ_NO in (3,4) · REFERENCE='Y')
--   에 INNER JOIN 하고 `ISSUE_DT_FG='Y'` 로 거른다 — 2026년 원본 1,783 → 뷰 1,760(23건 차이).
--   ETL(`vat_ledger`)은 이 조건을 그대로 복제한다. 원본만 긁으면 화면과 어긋난다.
-- ⚠ 뷰 1열 `ERP_TAX_ID` 는 `NEWID()` 라 호출할 때마다 바뀐다 — 키로 쓰면 매번 새 행이 된다.
--   유일키는 `VAT_NO`(=뷰의 `ERP_TAX_NO`)다.
--
-- ── 경계 (§1.2 · §6) ────────────────────────────────────────────────────────
-- · ERP 운영 MSSQL 은 읽기 전용. 이 파일은 **중간DB(미러)** 만 만든다.
-- · 두 표는 `erp_ro.gl_slip_*` 과 **같은 잠금**이다 — RLS ON · 정책 0개 · anon/authenticated 회수 ·
--   service_role 만 SELECT. 화면은 반드시 definer RPC 로만 들어온다(권한 재판정은 RPC 안에서).
-- · 적재 제외(민감): 대표자명(SUP_CEO_NAME·BUY_CEO_NAME) · 이메일(SUP_EMAIL·BUY_EMAIL1·BUY_EMAIL2) ·
--   주소(ADDR·ADDR1) · 신용카드번호(CREDIT_CD) · 현금영수증번호(CASH_NO).
--   ETL 추출 SQL(`10_ERP_DB연계/etl/etl_run.py` 의 `etax_master`·`vat_ledger`)에서 애초에 뽑지 않는다.

-- ── ① 국세청(e세로) 전자세금계산서 ──────────────────────────────────────────
create table if not exists erp_ro.etax_master_s (
  etax_id       text primary key,   -- A_TS_ETAX_MASTER.ETAX_ID (nvarchar(36) · PK)
  sapu_type     text,               -- I 매입 / O 매출
  write_date    date,               -- 작성일자 (화면 조회 기준)
  issue_date    date,               -- 발급일자
  transfer_date date,               -- 전송일자
  aprv_no       text,               -- 국세청 승인번호 (예 20260921-41000016-62556095)
  sup_busi_no   text,               -- 공급자 사업자번호 (하이픈 없는 10자리)
  sup_comp_nm   text,
  buy_busi_no   text,               -- 공급받는자 사업자번호
  buy_comp_nm   text,
  sup_amt       numeric,            -- 공급가액
  vat_amt       numeric,            -- 부가세액
  tot_amt       numeric,            -- 합계금액
  etax_kind     text,               -- 일반 / 일반(수정) / 영세율 / 수입 / 위수탁 …(8종)
  etax_type     text,               -- 세금계산서 / 수정세금계산서 / 계산서(3종)
  issue_type    text,               -- 발급수단: ASP발급 / 인터넷발급 / 겸용서식발급 / 자체발급 / 모바일발급
  sup_sub_busi_no text,             -- 공급자 종사업장번호
  buy_sub_busi_no text,             -- 공급받는자 종사업장번호
  item_dt       date,               -- 대표품목 일자
  item_nm       text,
  item_spec     text,
  remark        text,               -- 비고(수정발행 사유가 들어온다)
  src_updated   timestamptz,
  synced_at     timestamptz not null default now(),
  batch_id      uuid
);

comment on table erp_ro.etax_master_s is
  '국세청(e세로) 전자세금계산서 — A_TS_ETAX_MASTER 미러. ERP자료대사(CM903M2)의 「e세로」 축. 대표자명·이메일·주소 미적재.';

-- ── ② 부가세 계산서 원장 (ERP 축 · 전표 연결) ───────────────────────────────
create table if not exists erp_ro.vat_s (
  vat_no             text primary key,  -- A_VAT.VAT_NO (계산서번호 · PK)
  issued_dt          date,              -- 발행일 (= e세로 작성일과 대사)
  bp_rgst_no         text,              -- ⚠ A_VAT.OWN_RGST_NO = **거래처(상대방)** 사업자번호.
                                        --   매입이면 공급자, 매출이면 공급받는자. 하이픈 제거해 적재.
  report_rgst_no     text,              -- 우리 쪽 = 신고사업장 사업자번호 (B_TAX_BIZ_AREA.OWN_RGST_NO)
  report_biz_area_cd text,              -- 신고사업장코드 (TX1 이천 / TX2 김해)
  report_biz_area_nm text,              -- 신고사업장명
  biz_area_cd        text,              -- 발생사업장코드
  bp_cd              text,              -- 거래처코드 → erp_ro.bp_master_s
  acct_cd            text,
  ref_no             text,
  io_fg              text,              -- 입출구분
  vat_type           text,              -- 계산서유형
  vat_rate           numeric,
  net_loc_amt        numeric,           -- 공급가액(자국)
  vat_loc_amt        numeric,           -- 부가세액(자국)
  made_vat_fg        text,              -- 신고구분
  conf_fg            text,              -- 승인상태
  gl_no              text,              -- 확정(회계) 전표번호
  item_seq           smallint,
  temp_gl_no         text,              -- ★ 결의전표번호 — 기안서 대장의 TG 번호와 같은 축
  temp_item_seq      smallint,          -- ★ 결의전표 항목순번 (= gl_slip_item_s.item_seq)
  ar_no              text,              -- 매출채권번호
  ap_no              text,              -- 매입채무번호
  vat_desc           text,
  miss_fg            text,
  exclusion_fg       text,
  input_tax_fg       text,
  zerotax_type       text,
  src_updated        timestamptz,
  synced_at          timestamptz not null default now(),
  batch_id           uuid
);

comment on table erp_ro.vat_s is
  'ERP 부가세 계산서 원장 — A_VAT 미러. ERP자료대사(CM903M2)의 「ERP」 축이자 계산서↔결의전표 연결키(TEMP_GL_NO·TEMP_ITEM_SEQ). 카드·현금영수증번호 미적재.';

-- ── ③ 인덱스 ────────────────────────────────────────────────────────────────
-- 화면 조회 축(구분·신고사업장·기간)
create index if not exists ix_etax_master_io   on erp_ro.etax_master_s (sapu_type, buy_busi_no, write_date);
create index if not exists ix_etax_master_aprv on erp_ro.etax_master_s (aprv_no);
-- 3축 매칭(공급자 사업자번호 + 작성일 + 공급가액) — A_VAT 에 승인번호가 없어 이 경로로 잇는다
create index if not exists ix_etax_master_sup  on erp_ro.etax_master_s (sup_busi_no, write_date, sup_amt);
-- 전표 → 계산서 (기안서 대장 행 상세가 타는 길)
create index if not exists ix_vat_temp_gl      on erp_ro.vat_s (temp_gl_no, temp_item_seq);
create index if not exists ix_vat_gl           on erp_ro.vat_s (gl_no);
-- 자료대사 집계 축
create index if not exists ix_vat_rpt_io_dt    on erp_ro.vat_s (report_rgst_no, io_fg, issued_dt);
create index if not exists ix_vat_bp_rgst      on erp_ro.vat_s (bp_rgst_no, issued_dt, net_loc_amt);
create index if not exists ix_vat_bp_dt        on erp_ro.vat_s (bp_cd, issued_dt);

-- ── ④ 경계 — gl_slip_* 과 동일(RLS ON · 정책 0개 · service_role 만) ─────────
alter table erp_ro.etax_master_s enable row level security;
alter table erp_ro.vat_s         enable row level security;

revoke all on erp_ro.etax_master_s from anon, authenticated;
revoke all on erp_ro.vat_s         from anon, authenticated;
grant select on erp_ro.etax_master_s to service_role;
grant select on erp_ro.vat_s         to service_role;

-- ── ⑤ 적재 RPC (ETL 전용 · service_role) ────────────────────────────────────
-- 기존 erp_master_upsert 를 건드리지 않고 별 함수로 둔다 — 그 함수는 20개 분기를 이미 갖고 있어
-- create or replace 로 전문을 다시 쓰면 정본 파일과 라이브가 어긋날 위험이 크다(erp_secure_upsert 와 같은 분리).
create or replace function public.erp_vat_upsert(p_table text, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare n integer := 0;
begin
  if p_table = 'etax_master_s' then
    insert into erp_ro.etax_master_s (etax_id, sapu_type, write_date, issue_date, transfer_date,
                                      aprv_no, sup_busi_no, sup_comp_nm, buy_busi_no, buy_comp_nm,
                                      sup_amt, vat_amt, tot_amt, etax_kind, etax_type, issue_type,
                                      sup_sub_busi_no, buy_sub_busi_no, item_dt, item_nm, item_spec, remark,
                                      src_updated, synced_at, batch_id)
    select x.etax_id, x.sapu_type, x.write_date, x.issue_date, x.transfer_date,
           x.aprv_no, x.sup_busi_no, x.sup_comp_nm, x.buy_busi_no, x.buy_comp_nm,
           x.sup_amt, x.vat_amt, x.tot_amt, x.etax_kind, x.etax_type, x.issue_type,
           x.sup_sub_busi_no, x.buy_sub_busi_no, x.item_dt, x.item_nm, x.item_spec, x.remark,
           x.src_updated, now(), x.batch_id
      from jsonb_to_recordset(p_rows) as x(etax_id text, sapu_type text, write_date date,
             issue_date date, transfer_date date, aprv_no text, sup_busi_no text, sup_comp_nm text,
             buy_busi_no text, buy_comp_nm text, sup_amt numeric, vat_amt numeric, tot_amt numeric,
             etax_kind text, etax_type text, issue_type text, sup_sub_busi_no text, buy_sub_busi_no text,
             item_dt date, item_nm text, item_spec text, remark text,
             src_updated timestamptz, batch_id uuid)
    on conflict (etax_id) do update
      set sapu_type = excluded.sapu_type, write_date = excluded.write_date,
          issue_date = excluded.issue_date, transfer_date = excluded.transfer_date,
          aprv_no = excluded.aprv_no, sup_busi_no = excluded.sup_busi_no,
          sup_comp_nm = excluded.sup_comp_nm, buy_busi_no = excluded.buy_busi_no,
          buy_comp_nm = excluded.buy_comp_nm, sup_amt = excluded.sup_amt,
          vat_amt = excluded.vat_amt, tot_amt = excluded.tot_amt,
          etax_kind = excluded.etax_kind, etax_type = excluded.etax_type,
          issue_type = excluded.issue_type, sup_sub_busi_no = excluded.sup_sub_busi_no,
          buy_sub_busi_no = excluded.buy_sub_busi_no, item_dt = excluded.item_dt,
          item_nm = excluded.item_nm, item_spec = excluded.item_spec, remark = excluded.remark,
          synced_at = excluded.synced_at, src_updated = excluded.src_updated,
          batch_id = excluded.batch_id;
  elsif p_table = 'vat_s' then
    insert into erp_ro.vat_s (vat_no, issued_dt, bp_rgst_no, report_rgst_no, report_biz_area_cd,
                              report_biz_area_nm, biz_area_cd,
                              bp_cd, acct_cd, ref_no, io_fg, vat_type, vat_rate,
                              net_loc_amt, vat_loc_amt, made_vat_fg, conf_fg,
                              gl_no, item_seq, temp_gl_no, temp_item_seq, ar_no, ap_no,
                              vat_desc, miss_fg, exclusion_fg, input_tax_fg, zerotax_type,
                              src_updated, synced_at, batch_id)
    select x.vat_no, x.issued_dt, x.bp_rgst_no, x.report_rgst_no, x.report_biz_area_cd,
           x.report_biz_area_nm, x.biz_area_cd,
           x.bp_cd, x.acct_cd, x.ref_no, x.io_fg, x.vat_type, x.vat_rate,
           x.net_loc_amt, x.vat_loc_amt, x.made_vat_fg, x.conf_fg,
           x.gl_no, x.item_seq, x.temp_gl_no, x.temp_item_seq, x.ar_no, x.ap_no,
           x.vat_desc, x.miss_fg, x.exclusion_fg, x.input_tax_fg, x.zerotax_type,
           x.src_updated, now(), x.batch_id
      from jsonb_to_recordset(p_rows) as x(vat_no text, issued_dt date, bp_rgst_no text,
             report_rgst_no text, report_biz_area_cd text, report_biz_area_nm text,
             biz_area_cd text, bp_cd text, acct_cd text, ref_no text,
             io_fg text, vat_type text, vat_rate numeric, net_loc_amt numeric, vat_loc_amt numeric,
             made_vat_fg text, conf_fg text, gl_no text, item_seq smallint,
             temp_gl_no text, temp_item_seq smallint, ar_no text, ap_no text, vat_desc text,
             miss_fg text, exclusion_fg text, input_tax_fg text, zerotax_type text,
             src_updated timestamptz, batch_id uuid)
    on conflict (vat_no) do update
      set issued_dt = excluded.issued_dt, bp_rgst_no = excluded.bp_rgst_no,
          report_rgst_no = excluded.report_rgst_no, report_biz_area_cd = excluded.report_biz_area_cd,
          report_biz_area_nm = excluded.report_biz_area_nm, biz_area_cd = excluded.biz_area_cd,
          bp_cd = excluded.bp_cd, acct_cd = excluded.acct_cd, ref_no = excluded.ref_no,
          io_fg = excluded.io_fg, vat_type = excluded.vat_type, vat_rate = excluded.vat_rate,
          net_loc_amt = excluded.net_loc_amt, vat_loc_amt = excluded.vat_loc_amt,
          made_vat_fg = excluded.made_vat_fg, conf_fg = excluded.conf_fg,
          gl_no = excluded.gl_no, item_seq = excluded.item_seq,
          temp_gl_no = excluded.temp_gl_no, temp_item_seq = excluded.temp_item_seq,
          ar_no = excluded.ar_no, ap_no = excluded.ap_no, vat_desc = excluded.vat_desc,
          miss_fg = excluded.miss_fg, exclusion_fg = excluded.exclusion_fg,
          input_tax_fg = excluded.input_tax_fg, zerotax_type = excluded.zerotax_type,
          synced_at = excluded.synced_at, src_updated = excluded.src_updated,
          batch_id = excluded.batch_id;
  else
    raise exception '허용되지 않은 테이블: %', p_table;
  end if;
  get diagnostics n = row_count;
  return n;
end $function$;

revoke all on function public.erp_vat_upsert(text, jsonb) from public, anon, authenticated;
grant execute on function public.erp_vat_upsert(text, jsonb) to service_role;

-- ── 확인 ─────────────────────────────────────────────────────────────────────
-- select count(*) from erp_ro.etax_master_s;   -- 적재 후 2026 작성분
-- select count(*) from erp_ro.vat_s;           -- 적재 후 2026 발행분
-- 경계: 정책 0개 · anon/authenticated 권한 0개여야 한다
-- select relname, relrowsecurity, (select count(*) from pg_policies p
--          where p.schemaname='erp_ro' and p.tablename=c.relname) as policies
--   from pg_class c join pg_namespace n on n.oid=c.relnamespace
--  where n.nspname='erp_ro' and c.relname in ('etax_master_s','vat_s');
