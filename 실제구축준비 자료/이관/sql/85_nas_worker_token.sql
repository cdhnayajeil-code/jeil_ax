-- 85 — NAS 워커 전용 토큰(좁은 키) (REQ-0102 · ADR-110 v3 · 2026-10-02)
--
-- 왜
--   NAS 컨테이너에 service_role 키를 두지 않기 위해서다. 컨테이너는 전용 토큰 하나만 갖고,
--   Edge Function jeil-nas-bridge 가 그 토큰을 여기서 대조한 뒤 NAS 적재용 RPC 8종만 중계한다.
--
-- 무엇을 저장하는가
--   토큰의 **SHA-256 해시만**. 평문은 발급한 PC 의 git 제외 파일과 NAS 컨테이너 .env 에만 있다.
--   해시가 새어도 토큰을 되살릴 수 없다(토큰은 256비트 난수).
--
-- 운영
--   · 발급: 난수 생성 → 해시만 insert (값은 출력·명령줄·문서에 남기지 않는다 — CLAUDE.md §1.8)
--   · 회전: 새 행 insert → 컨테이너 .env 교체·재생성 → 옛 행 active=false
--   · 차단: active=false 한 줄(즉시 — 브리지는 호출마다 대조한다)
--
-- 되돌리기: 85_nas_worker_token_rollback.sql

create table if not exists etl_meta.nas_worker_token (
  token_hash   text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  worker       text not null check (worker ~ '^[A-Za-z0-9_.-]{1,60}$'),   -- 심박·요청에 찍히는 이름(서버가 강제한다)
  label        text,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);
alter table etl_meta.nas_worker_token enable row level security;   -- 정책 0 = RPC(정의자 권한) 전용
revoke all on etl_meta.nas_worker_token from anon, authenticated;

comment on table etl_meta.nas_worker_token is
  'NAS 워커 전용 토큰의 SHA-256 해시. Edge Function jeil-nas-bridge 가 대조한다. 평문은 저장하지 않는다.';

-- 해시가 유효하면 워커 이름을 돌려준다(없으면 null). last_used_at 은 1분에 한 번만 갱신한다 —
-- 워커가 20초마다 부르므로 매번 쓰면 쓸데없는 쓰기가 쌓인다.
create or replace function public.nas_worker_token_check(p_hash text)
returns text
language plpgsql
security definer
set search_path = public, etl_meta, pg_temp
as $fn$
declare
  v_worker text;
begin
  if p_hash is null or p_hash !~ '^[0-9a-f]{64}$' then
    return null;
  end if;
  select t.worker into v_worker from etl_meta.nas_worker_token t where t.token_hash = p_hash and t.active;
  if v_worker is null then
    return null;
  end if;
  update etl_meta.nas_worker_token
     set last_used_at = now()
   where token_hash = p_hash and (last_used_at is null or last_used_at < now() - interval '1 minute');
  return v_worker;
end;
$fn$;

revoke all on function public.nas_worker_token_check(text) from public, anon, authenticated;
grant execute on function public.nas_worker_token_check(text) to service_role;
