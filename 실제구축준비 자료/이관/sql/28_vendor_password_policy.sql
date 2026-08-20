-- 28_vendor_password_policy.sql
-- 협력사/포털 관리자 계정 비밀번호 정책 변경 (관리자 지시, 2026-08-20)
-- 적용: Supabase 마이그레이션 `vendor_force_password_change`
--
-- 기존: 발급·초기화 때마다 무작위 임시비번(Jm…7!)을 만들어 관리자가 협력사에 전달
-- 변경: 초기 비밀번호를 고정값 'jeilmns'로 두고, 최초 로그인 시 새 비밀번호 설정을 강제한다.
--       (전달할 비밀번호가 하나로 고정돼 안내가 단순해지는 대신, 초기비번 방치를 강제변경으로 막는다.)
--
-- 강제 플래그: auth.users.raw_app_meta_data.must_change_password (사용자가 직접 수정 불가)
--   · 세팅: Edge Function vendor-provision / vendor-admin-provision / vendor-reset-password
--   · 해제: Edge Function vendor-set-password 만 — 실제로 비밀번호를 바꿔야 풀린다
--   · 화면 판정: 아래 Hook이 JWT app_metadata.must_pw 로 실어 보낸다
--
-- 참고: 프로젝트 Auth 최소 비밀번호 길이는 6자(실측) → 7자 'jeilmns' 통과.
--       최소 길이를 8자 이상으로 올리면 이 초기값은 거부되므로 함께 조정해야 한다.

/* ── 1. JWT 클레임에 must_pw 추가 (기존 role·vendor_bp 유지) ────────── */
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb language plpgsql stable set search_path to '' as $function$
declare
  claims  jsonb;
  meta    jsonb;
  v_role  text;
  v_bp    jsonb;
  v_email text;
  v_mustpw boolean;
begin
  select coalesce(u.raw_app_meta_data, '{}'::jsonb), u.email
    into meta, v_email
  from auth.users u
  where u.id = (event->>'user_id')::uuid;

  v_role := meta->>'role';
  v_bp   := meta->'vendor_bp';
  v_mustpw := coalesce((meta->>'must_change_password')::boolean, false);

  -- fallback: 사내 도메인이면 internal
  if (v_role is null or v_role = '') and v_email like '%@jeilm.co.kr' then
    v_role := 'internal';
  end if;

  claims := coalesce(event->'claims', '{}'::jsonb);
  claims := jsonb_set(
    claims, '{app_metadata}',
    coalesce(claims->'app_metadata', '{}'::jsonb)
      || jsonb_build_object(
           'role',      coalesce(v_role, ''),
           'vendor_bp', coalesce(v_bp, '[]'::jsonb),
           'must_pw',   v_mustpw
         )
  );

  return jsonb_set(event, '{claims}', claims);
end;
$function$;

/* ── 2. 관리 화면 표시용 상태 컬럼(판정 자체는 app_metadata가 단일 출처) ── */
alter table public.vendor_account       add column if not exists must_change_pw boolean not null default false;
alter table public.vendor_admin_account add column if not exists must_change_pw boolean not null default false;
comment on column public.vendor_account.must_change_pw is
  '초기 비밀번호(jeilmns) 상태 — 최초 로그인 시 새 비밀번호 설정이 강제된다. 실제 판정은 auth app_metadata.must_change_password.';
comment on column public.vendor_admin_account.must_change_pw is
  '초기 비밀번호(jeilmns) 상태 — 최초 로그인 시 새 비밀번호 설정이 강제된다. 실제 판정은 auth app_metadata.must_change_password.';

/* ── 3. 검증 쿼리 ─────────────────────────────────────────────────────
   -- Hook이 기존 클레임을 보존하며 must_pw를 싣는지(로그인 전 구간 영향 → 필수 확인)
   select u.email,
          public.custom_access_token_hook(jsonb_build_object('user_id', u.id, 'claims', '{}'::jsonb))
            -> 'claims' -> 'app_metadata' as claims
   from auth.users u order by u.created_at desc limit 5;
   -- 기대: {"role":"vendor","vendor_bp":["00209"],"must_pw":false}
*/
