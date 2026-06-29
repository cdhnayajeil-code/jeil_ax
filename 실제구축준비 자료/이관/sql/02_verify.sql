-- ============================================================
-- 01_schema_rls.sql 적용 후 검증 — SQL Editor 에서 RUN
-- 기대 결과를 주석에 표기. 인증 토큰이 필요한 RLS 격리 테스트는
-- 인증(C단계) 이후 01_실행가이드 §G 로 수행.
-- ============================================================

-- [1] 테이블 6개 생성 확인  → sp_inspection, sp_inspection_log, sp_insp_request,
--                              sp_message, sp_order_state, sp_photo
select table_name
from information_schema.tables
where table_schema = 'public' and table_name like 'sp_%'
order by 1;

-- [2] RLS 활성화 확인  → 6행 모두 rls_enabled = true
select relname as table_name, relrowsecurity as rls_enabled
from pg_class
where relname like 'sp_%' and relkind = 'r'
order by 1;

-- [3] 정책 확인  → order_state/photo/message/insp_request: internal_all + vendor_own (각 2)
--                  inspection/inspection_log: internal_all + vendor_select (각 2)
select tablename, policyname, cmd
from pg_policies
where tablename like 'sp_%'
order by 1, 2;

-- [4] 클레임 헬퍼 함수 확인  → is_internal, vendor_bp (2행)
select proname
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and proname in ('is_internal', 'vendor_bp')
order by 1;

-- [5] Storage 버킷 확인  → vendor-photos, public = false (1행)
select id, name, public from storage.buckets where id = 'vendor-photos';

-- [6] Storage 정책 확인  → vendor_photos_internal, vendor_photos_vendor (2행)
select policyname, cmd from pg_policies
where schemaname = 'storage' and tablename = 'objects'
  and policyname like 'vendor_photos_%'
order by 1;
