-- ============================================================
-- Custom Access Token Hook — 로그인 토큰(JWT)에 role·vendor_bp 주입
-- 이게 있어야 실제 로그인 사용자에게 RLS가 적용된다(03 테스트는 시뮬레이션).
-- 적용 후: 대시보드 → Authentication → Hooks →
--          "Customize Access Token (JWT) Claims" → public.custom_access_token_hook 선택·활성화
-- ============================================================

-- 사용자의 app_metadata(role·vendor_bp)를 토큰 claims.app_metadata 에 복사.
-- 사내 도메인(@jeilm.co.kr)은 role 미지정 시 internal 로 자동 판정(데모 편의).
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  claims  jsonb;
  meta    jsonb;
  v_role  text;
  v_bp    jsonb;
  v_email text;
begin
  select coalesce(u.raw_app_meta_data, '{}'::jsonb), u.email
    into meta, v_email
  from auth.users u
  where u.id = (event->>'user_id')::uuid;

  v_role := meta->>'role';
  v_bp   := meta->'vendor_bp';

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
           'vendor_bp', coalesce(v_bp, '[]'::jsonb)
         )
  );

  return jsonb_set(event, '{claims}', claims);
end;
$$;

-- 권한: Auth 서버(supabase_auth_admin)만 실행/조회, 일반 롤은 차단
grant usage  on schema public to supabase_auth_admin;
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
grant select  on auth.users to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook(jsonb) from authenticated, anon, public;

-- ── 협력사 테스트 계정 메타 설정 (계정 생성 후 실행) ──────
-- 먼저 대시보드 → Authentication → Users → Add user 로 계정을 만든 뒤,
-- 아래에서 이메일을 맞춰 app_metadata 를 부여한다.
--
-- update auth.users
--   set raw_app_meta_data = coalesce(raw_app_meta_data,'{}'::jsonb)
--       || '{"role":"vendor","vendor_bp":["V-1027"]}'::jsonb
--   where email = 'vendorA@example.com';
--
-- 사내 테스트 계정(도메인이 jeilm.co.kr 아니면 명시):
-- update auth.users
--   set raw_app_meta_data = coalesce(raw_app_meta_data,'{}'::jsonb)
--       || '{"role":"internal"}'::jsonb
--   where email = 'staff@example.com';
--
-- 확인(로그인 후 토큰 디코드 또는):
-- select email, raw_app_meta_data->>'role' role, raw_app_meta_data->'vendor_bp' bp
--   from auth.users order by created_at desc;
