-- 101_hr_master_page_rollback.sql — REQ-0122 되돌리기
-- hr_career_get 의 코드 그룹 대소문자 보정은 되돌리지 않는다(되돌리면 직위 일부가 코드로 보일 뿐 — 필요하면 100 번을 다시 적용).
drop function if exists public.hr_emp_list();
update public.portal_page
   set active = false, updated_by = 'dh.choi@jeilm.co.kr', updated_at = now()
 where page_key = 'hr_master_2026';
-- delete from public.portal_page where page_key = 'hr_master_2026';   -- 권장하지 않음(권한 설정 이력이 함께 사라진다)
