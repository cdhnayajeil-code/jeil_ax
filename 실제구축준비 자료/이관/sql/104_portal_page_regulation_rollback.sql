-- 104_portal_page_regulation_rollback.sql
-- 되돌리기: 「사내규정 조회」 포털 등재 해제 (REQ-0124)
--
-- 삭제가 아니라 비활성이다 — active=false 면 포털 카드가 사라지고 접근 게이트(perm_effective)가 화면을 막는다. 등재 기록은 남는다.

update public.portal_page
   set active = false, updated_by = 'dh.choi@jeilm.co.kr', updated_at = now()
 where page_key = 'regulation_lookup';

-- delete from public.portal_page where page_key = 'regulation_lookup';   -- 권장하지 않음
