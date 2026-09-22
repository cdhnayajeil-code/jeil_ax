-- 58_portal_page_purchase_list_rollback.sql
-- 되돌리기: 발주통합관리 LIST 포털 등재 해제 (REQ-0069)
--
-- 삭제가 아니라 비활성이다 — active=false 면 게이트가 차단하고 카드도 사라지지만
-- 언제 무엇을 등재했는지 기록은 남는다(perm_effective 는 active 행만 본다).

update public.portal_page
   set active = false, updated_by = 'dh.choi@jeilm.co.kr', updated_at = now()
 where page_key = 'purchase_list_2026';

-- delete from public.portal_page where page_key = 'purchase_list_2026';   -- 권장하지 않음
