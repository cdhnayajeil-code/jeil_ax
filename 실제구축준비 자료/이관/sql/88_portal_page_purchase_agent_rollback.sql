-- 88_portal_page_purchase_agent_rollback.sql
-- 되돌리기: 구매 AI 에이전트 포털 등재 해제 (REQ-0106)
--
-- 삭제가 아니라 비활성이다 — active=false 면 포털 카드가 사라지지만 등재 기록은 남는다.
-- 화면 자체(`/work/purchase-agent`)는 그대로 열린다(서버가 구성원을 판정) — 카드만 내린다.

update public.portal_page
   set active = false, updated_by = 'dh.choi@jeilm.co.kr', updated_at = now()
 where page_key = 'purchase_agent_2026';

-- delete from public.portal_page where page_key = 'purchase_agent_2026';   -- 권장하지 않음
