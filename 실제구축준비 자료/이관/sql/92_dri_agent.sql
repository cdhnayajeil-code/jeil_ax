-- 92_dri_agent.sql — 사업운영팀 「DRI 분석·생성 에이전트」 준비 단계 등록 (REQ-0112 · 관리자 지시 2026-10-07)
--
-- 무엇을 하나
--   ① 사내 NAS 허용 폴더에 사업운영팀 부서 폴더 등록(부서코드 6110) — 그 아래 DRI 폴더가 이 에이전트의 자료 폴더다.
--   ② 부서 에이전트 `dri` 등록(상태 pilot · 사업운영팀) + 설정 v1(현재) + 관리자 1명(reviewer).
--
-- 지금 되는 것(준비 단계 D0): 대화에 붙인 이미지·도면 분석 · DRI 폴더 파일 목록 · 본인 과거 대화 · 부서 NAS 보관함(저장·관리).
-- 아직 안 되는 것: NAS 폴더의 이미지를 에이전트가 직접 읽기(D1) · AI 이미지 생성(D2 — 모델·외부 전송·예산 결정 뒤).
--   그래서 설정 v1 의 답변 원칙에 「생성은 아직 연결되지 않았다」를 사실대로 적어 둔다 — 모델이 한 척하지 않게.
-- 기획: 문서/12_에이전트관리/08_DRI분석생성_에이전트_기획.md
-- 되돌리기: 92_dri_agent_rollback.sql

-- ── 1. 허용 폴더 ─────────────────────────────────────────────────────────────
insert into etl_meta.nas_folder_scope (folder_key, rel_path, label_ko, audience, dept_nm, active, approved_by, approved_at, note)
values ('biz_ops', '부서/6110_사업운영팀', '사업운영팀', 'dept', '사업운영팀', true, 'dh.choi@jeilm.co.kr', now(),
        '사업운영팀 부서 폴더(2026-10-07 관리자 지시 등록 · REQ-0112) — 부서코드 6110 · 하위 DRI 폴더 = DRI 분석·생성 에이전트의 자료 폴더')
on conflict (folder_key) do nothing;

-- ── 2. 에이전트 ──────────────────────────────────────────────────────────────
insert into public.ai_agent (agent_key, name_ko, summary_ko, icon, dept_nm, status, current_version,
                             daily_limit, monthly_budget_usd, collect_turns, retention_days, suggestions, updated_by)
values ('dri', 'DRI 분석·생성 에이전트', 'DRI 폴더의 이미지·도면 자료를 분석하고 설명 자료·이미지 초안을 만든다(준비 단계)', '🖼',
        '사업운영팀', 'pilot', 1, 30, 50, true, 180,
        '[{"label":"DRI 폴더 파일 목록","q":"사업운영팀 폴더의 DRI 폴더에 있는 파일 목록 보여줘"},
          {"label":"이미지 분석","q":"첨부한 이미지를 분석해서 무엇이 보이는지, 특이사항, 제안 순서로 정리해줘"},
          {"label":"여러 장 비교","q":"첨부한 이미지들을 비교해서 같은 점과 다른 점을 표로 정리해줘"},
          {"label":"생성 지시문 초안","q":"첨부한 자료를 바탕으로 새 이미지를 만들기 위한 생성 지시문(구도·구성 요소·문구·주의점) 초안을 써줘"},
          {"label":"예전 대화 찾기","q":"예전에 내가 물어본 대화를 찾아줘 — 찾을 낱말을 물어봐줘"}]'::jsonb,
        'sql92')
on conflict (agent_key) do nothing;

insert into public.ai_agent_version (agent_key, version, state, model_id, fallback_model_id, effort, max_tokens, temperature,
                                     prompt_caching, role_prompt, answer_rules, modules, max_tool_rounds, note, created_by, approved_by, approved_at)
select 'dri', 1, 'current', 'claude-sonnet-5', 'gpt-4.1-mini', 'medium', 2048, null, true,
  '당신은 제일엠앤에스 사업운영팀의 DRI 분석·생성 에이전트입니다. 사업운영팀이 사내 NAS 의 DRI 폴더에서 관리하는 이미지·도면 자료를 정리·분석하고, 그 내용을 바탕으로 설명 자료와 이미지 초안을 만들도록 돕습니다.',
  E'- 사용자가 대화에 붙인 이미지·도면은 직접 보고 분석합니다. 보이는 것과 추정을 구분해 쓰고, 읽히지 않는 글자·치수는 지어내지 말고 「판독 불가」로 적으세요.\n'
  || E'- 사내 NAS 의 DRI 폴더는 지금 파일 이름·수정일만 볼 수 있습니다(내용 판독은 준비 중). 내용이 필요하면 그 파일을 대화에 붙여 달라고 안내하세요.\n'
  || E'- 이미지 생성 기능은 아직 연결되지 않았습니다(관리자 결정 대기). 요청받으면 생성하지 못한다고 사실대로 말하고, 대신 생성 지시문 초안(구도·구성 요소·문구·주의점)을 글로 정리해 주세요. 만든 척하지 마세요.\n'
  || E'- 도면·고객 자료는 대외비일 수 있습니다. 외부 공유·메일 발송은 하지 않으며, 한 자료의 고객사·수치를 다른 자료와 섞지 마세요.\n'
  || E'- 답변 첫 줄에 결론을 한 문장으로 쓰고, 분석은 「무엇이 보이는가 → 특이사항 → 제안」 순서로 쓰세요.',
  '{"domains":["nas","common"],"off":[]}'::jsonb, 4,
  'v1 준비 단계(D0) — 붙인 이미지 분석 + NAS 파일 목록·과거 대화. NAS 이미지 직접 판독(D1)·AI 이미지 생성(D2)은 미연결(REQ-0112)',
  'dh.choi@jeilm.co.kr', 'dh.choi@jeilm.co.kr', now()
where not exists (select 1 from public.ai_agent_version where agent_key = 'dri' and version = 1);

insert into public.ai_agent_member (agent_key, upn, role, added_by)
select 'dri', 'dh.choi@jeilm.co.kr', 'reviewer', 'sql92'
where not exists (select 1 from public.ai_agent_member where agent_key = 'dri' and upn = 'dh.choi@jeilm.co.kr');

-- ── 확인 ─────────────────────────────────────────────────────────────────────
-- select agent_key, name_ko, dept_nm, status, current_version from public.ai_agent where agent_key = 'dri';
-- select folder_key, rel_path, dept_nm from etl_meta.nas_folder_scope order by folder_key;
