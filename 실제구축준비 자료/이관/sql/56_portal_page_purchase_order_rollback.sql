-- 56_portal_page_purchase_order_rollback.sql
-- 되돌리기: 구매팀 「발주·구매요청 진행현황」 포털 등재 해제 (REQ-0068)
--
-- 기본은 **삭제가 아니라 비활성**이다 — active=false 면 게이트가 차단하고 카드도 사라지지만,
-- 언제 무엇을 등재했는지 기록은 남는다(perm_effective 는 active 행만 본다).

update public.portal_page
   set active = false, updated_by = 'dh.choi@jeilm.co.kr', updated_at = now()
 where page_key = 'purchase_order_2026';

-- 완전히 지워야 한다면(권장하지 않음):
-- delete from public.portal_page where page_key = 'purchase_order_2026';
