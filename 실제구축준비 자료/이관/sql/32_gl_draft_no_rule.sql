-- 32_gl_draft_no_rule.sql
-- 참조번호 채번규칙 재정립 — 「번호 하나로 언제·누가·몇 번째인지 알 수 있게」
-- 작성 2026-08-27 · 관리 최동혁 · 선행 `21_gl_draft.sql`
-- 마이그레이션: gl_draft_no_rule_v1
--
-- ▣ 왜 바꾸는가
--   종전 번호는 테이블 기본값 `'DRAFT-' || YYYYMMDD || '-' || lpad(nextval('gl_draft_seq'),4)` 였다.
--   세 가지가 문제였다.
--     1. **날짜별 일련번호처럼 보이지만 아니다.** 시퀀스가 전역이라 날짜가 바뀌어도 이어진다
--        (`DRAFT-20260824-0014` 의 0014 는 그날 14번째가 아니라 개설 이래 14번째다).
--     2. **작성자가 번호에 없다.** 번호만 들고는 누가 만든 건인지 알 수 없어, 회계 담당자가
--        전송 화면에서 문의를 받으면 매번 DB/화면을 되짚어야 했다.
--     3. **`DRAFT-` 접두는 ERP 표기 관례 밖이다.** 이 번호는 그대로 ERP
--        `A_BATCH.REF_NO` · `A_TEMP_GL.REF_NO` 에 실려 들어가는 멱등키인데, ERP 쪽에서 보면
--        출처를 알 수 없는 문자열이었다.
--
-- ▣ 새 규칙 — AX{YYMMDD}-U{작성자코드}-{순번}
--
--     AX260827-U012-003
--     │  │      │    └ 그 사람의 그날 순번 001~ (일자별 초기화, 빈 번호 없음)
--     │  │      └───── 작성자 고정코드 U001~ (최초 작성 시 1회 부여, 이후 평생 고정)
--     │  └──────────── 작성일 YYMMDD (Asia/Seoul)
--     └─────────────── AX 포털 발행 표식 — ERP 2자 유형코드 관례 계승(TG 수기결의·AG AI전표·BT 배치·VT 부가세)
--
--   · **사용자 간 충돌이 구조적으로 불가능하다.** 작성자마다 코드가 다르므로 같은 날 두 사람이
--     동시에 저장해도 번호가 겹칠 수 없다. 종전처럼 전역 시퀀스에 의존하지 않는다.
--   · **번호만으로 추적된다.** 260827 → 작성일, U012 → 작성자(레지스트리 `gl_draft_owner`),
--     003 → 그 사람의 그날 세 번째. ERP 에 들어간 REF_NO 만 보고도 되짚을 수 있다.
--   · 길이 18자 — ERP `REF_NO nvarchar(30)` 안에 여유 있게 들어간다.
--   · 한 사람·하루 999건을 넘으면 순번이 4자리로 늘어난다(`lpad` 는 자르지 않는다).
--     작성자 999명을 넘으면 코드가 `U1000` 으로 늘어난다. 어느 쪽도 유일성은 그대로다.
--
-- ▣ 왜 시퀀스가 아니라 카운터 테이블인가
--   시퀀스는 롤백해도 값이 돌아오지 않아 번호에 구멍이 생긴다. 저장 실패가 곧 결번인
--   구조는 회계 번호로 부적절하다. `gl_draft_no_ctr` 는 일반 테이블이라 트랜잭션이 되돌아가면
--   순번도 함께 되돌아간다 — 같은 (작성자, 날짜) 안에서 빈 번호가 생기지 않는다.
--   대가는 같은 사람이 같은 날 동시에 저장할 때의 행 잠금인데, 사람이 쓰는 화면이라 무시할 수준이다.
--
-- ▣ 기존 번호는 건드리지 않는다
--   이미 발급된 44건(`DRAFT-*`)은 그대로 둔다. 그중 일부는 ERP `REF_NO` 로 이미 들어가 있어
--   재부여하면 포털과 ERP 의 대사(멱등 확인)가 끊긴다. 규칙은 **새로 만드는 건부터** 적용된다.
--   구 시퀀스 `gl_draft_seq` 도 롤백 대비로 남긴다(더는 쓰이지 않는다).
--
-- ▣ 화면 용어 대응 (2026-08-27 관리자 결정)
--   화면 표기는 **참조번호**, 데이터·API 이름은 `draft_no` 그대로다.
--   `gl_draft.ref_no`(그룹웨어 결재 문서번호)와 헷갈리지 않게 아래에서 컬럼 주석을 명확히 한다.

begin;

-- ═══════════════════════════════════════════════════════════════════════
-- 1) 작성자 코드 레지스트리 — 사람 ↔ U### 를 평생 1:1로 묶는다
-- ═══════════════════════════════════════════════════════════════════════
create sequence if not exists public.gl_draft_owner_seq;

create table if not exists public.gl_draft_owner (
  owner_upn  text primary key,                    -- MS 계정(UPN) — 소문자로 정규화해 저장
  owner_cd   text not null unique
             check (owner_cd ~ '^U[0-9]{3,}$'),   -- 'U012' (999 초과 시 4자리로 확장)
  owner_nm   text,                                -- 표시용 성명(마스킹 대상 아님 — CLAUDE.md §1.7)
  created_at timestamptz not null default now()   -- 최초 작성 시각 = 코드 부여 시각
);
comment on table public.gl_draft_owner is
  '참조번호 작성자 코드 레지스트리. 번호의 U### 조각이 누구인지 되짚는 유일한 출처 — 한 번 부여하면 바꾸지 않는다.';

-- ═══════════════════════════════════════════════════════════════════════
-- 2) (작성자, 일자) 순번 카운터 — 결번 없는 채번의 근거
-- ═══════════════════════════════════════════════════════════════════════
create table if not exists public.gl_draft_no_ctr (
  owner_cd   text not null,
  ymd        text not null check (ymd ~ '^[0-9]{6}$'),   -- YYMMDD (Asia/Seoul)
  last_n     integer not null default 0 check (last_n >= 0),
  updated_at timestamptz not null default now(),
  primary key (owner_cd, ymd)
);
comment on table public.gl_draft_no_ctr is
  '참조번호 일자별 순번 카운터. 시퀀스가 아닌 테이블인 이유 — 저장이 롤백되면 순번도 되돌아가 결번이 생기지 않는다.';

-- ═══════════════════════════════════════════════════════════════════════
-- 3) 작성자 코드 부여 — 최초 1회, 이후 조회
-- ═══════════════════════════════════════════════════════════════════════
create or replace function public.gl_draft_owner_cd(p_upn text, p_nm text default null)
  returns text
  language plpgsql
  security definer
  set search_path to ''
as $function$
declare
  v_upn text := lower(btrim(coalesce(p_upn, '')));
  v_nm  text := nullif(btrim(coalesce(p_nm, '')), '');
  v_cd  text;
begin
  if v_upn = '' then
    raise exception '작성자(UPN)가 비어 있어 참조번호를 만들 수 없습니다.';
  end if;

  select owner_cd into v_cd from public.gl_draft_owner where owner_upn = v_upn;
  if v_cd is not null then
    -- 이름은 최신값으로 유지한다(코드는 절대 바꾸지 않는다)
    if v_nm is not null and coalesce((select owner_nm from public.gl_draft_owner where owner_upn = v_upn), '') <> v_nm then
      update public.gl_draft_owner set owner_nm = v_nm where owner_upn = v_upn;
    end if;
    return v_cd;
  end if;

  -- 최초 작성 — 코드를 새로 뗀다. 동시에 두 요청이 들어오면 뒤엣것은 do nothing 으로 흡수하고
  -- 아래에서 이미 부여된 코드를 다시 읽는다(시퀀스 한 칸이 비지만 코드 유일성에는 영향 없다).
  insert into public.gl_draft_owner (owner_upn, owner_cd, owner_nm)
  values (v_upn, 'U' || lpad(nextval('public.gl_draft_owner_seq')::text, 3, '0'), v_nm)
  on conflict (owner_upn) do nothing;

  select owner_cd into v_cd from public.gl_draft_owner where owner_upn = v_upn;
  return v_cd;
end $function$;

-- ═══════════════════════════════════════════════════════════════════════
-- 4) 다음 참조번호 — AX{YYMMDD}-U{작성자}-{순번}
-- ═══════════════════════════════════════════════════════════════════════
create or replace function public.gl_draft_next_no(p_upn text, p_nm text default null)
  returns text
  language plpgsql
  security definer
  set search_path to ''
as $function$
declare
  v_cd  text;
  v_ymd text := to_char((now() at time zone 'Asia/Seoul'), 'YYMMDD');
  v_n   integer;
begin
  v_cd := public.gl_draft_owner_cd(p_upn, p_nm);

  insert into public.gl_draft_no_ctr (owner_cd, ymd, last_n, updated_at)
  values (v_cd, v_ymd, 1, now())
  on conflict (owner_cd, ymd)
    do update set last_n = public.gl_draft_no_ctr.last_n + 1, updated_at = now()
  returning last_n into v_n;

  return 'AX' || v_ymd || '-' || v_cd || '-' || lpad(v_n::text, 3, '0');
end $function$;

-- ═══════════════════════════════════════════════════════════════════════
-- 5) 채번 지점 — 테이블 기본값에서 트리거로 옮긴다
-- ═══════════════════════════════════════════════════════════════════════
-- 기본값(default)은 다른 컬럼값을 볼 수 없어 작성자를 번호에 넣을 수 없다.
-- BEFORE INSERT 트리거는 NEW.owner_upn 을 읽을 수 있고, NOT NULL 검사보다 먼저 돈다.
-- 번호를 직접 지정해 넣는 경로(테스트 시드 `DRAFT-TEST-*` · `DRAFT-LDG-*`)는 그대로 통과시킨다.
create or replace function public.gl_draft_no_bi()
  returns trigger
  language plpgsql
  security definer
  set search_path to ''
as $function$
begin
  if new.draft_no is null or btrim(new.draft_no) = '' then
    new.draft_no := public.gl_draft_next_no(new.owner_upn, new.owner_nm);
  end if;
  return new;
end $function$;

drop trigger if exists gl_draft_no_bi on public.gl_draft;
create trigger gl_draft_no_bi
  before insert on public.gl_draft
  for each row execute function public.gl_draft_no_bi();

-- 구 기본값 해제 — 이제 번호는 트리거만 만든다(두 곳에서 만들면 규칙이 둘이 된다).
alter table public.gl_draft alter column draft_no drop default;

-- ═══════════════════════════════════════════════════════════════════════
-- 6) 기존 작성자 소급 등록 — 지금 있는 사람부터 코드를 굳혀 둔다
-- ═══════════════════════════════════════════════════════════════════════
-- 첫 작성이 이른 사람에게 이른 번호가 가도록 정렬해 넣는다(정렬은 표시상의 배려일 뿐,
-- 코드 값 자체에 의미는 없다 — 유일성과 불변성만이 규칙이다).
insert into public.gl_draft_owner (owner_upn, owner_cd, owner_nm)
select s.owner_upn,
       'U' || lpad(nextval('public.gl_draft_owner_seq')::text, 3, '0'),
       s.owner_nm
from (
  select lower(btrim(owner_upn)) as owner_upn,
         (array_agg(owner_nm order by created_at desc))[1] as owner_nm,
         min(created_at) as first_at
  from public.gl_draft
  where coalesce(btrim(owner_upn), '') <> ''
  group by lower(btrim(owner_upn))
  order by min(created_at)
) s
on conflict (owner_upn) do nothing;

-- ═══════════════════════════════════════════════════════════════════════
-- 7) 권한 — 회계는 민감 등급. Edge Function(service_role) 단일 경로를 유지한다.
-- ═══════════════════════════════════════════════════════════════════════
alter table public.gl_draft_owner  enable row level security;
alter table public.gl_draft_no_ctr enable row level security;
revoke all on public.gl_draft_owner, public.gl_draft_no_ctr from anon, authenticated;
grant select, insert, update on public.gl_draft_owner, public.gl_draft_no_ctr to service_role;
-- 정책은 만들지 않는다(정책 0개 = 전면 차단). service_role 만 통과한다.

revoke all on sequence public.gl_draft_owner_seq from anon, authenticated;
grant usage, select on sequence public.gl_draft_owner_seq to service_role;

revoke all on function public.gl_draft_owner_cd(text, text) from public, anon, authenticated;
revoke all on function public.gl_draft_next_no(text, text) from public, anon, authenticated;
revoke all on function public.gl_draft_no_bi() from public, anon, authenticated;
grant execute on function public.gl_draft_owner_cd(text, text) to service_role;
grant execute on function public.gl_draft_next_no(text, text) to service_role;

-- ═══════════════════════════════════════════════════════════════════════
-- 8) 이름이 겹치던 두 칸을 주석으로 갈라 둔다
-- ═══════════════════════════════════════════════════════════════════════
-- 화면의 「참조번호」는 draft_no 다. gl_draft.ref_no 는 다른 것(그룹웨어 문서번호)이고
-- 현재 화면에 노출되지 않는다 — 나중에 이 둘을 헷갈려 잘못 잇는 일을 막는다.
comment on column public.gl_draft.draft_no is
  '참조번호(화면 표기) — AX{YYMMDD}-U{작성자코드}-{순번}. ERP A_BATCH/A_TEMP_GL 의 REF_NO 로 그대로 실려 들어가는 멱등키. 규칙 정본 32_gl_draft_no_rule.sql';
comment on column public.gl_draft.ref_no is
  '외부 참조 문서번호(그룹웨어 전자결재 문서번호) — 현재 화면 미노출(E4 과제). 화면의 「참조번호」는 이 칸이 아니라 draft_no 다.';
comment on sequence public.gl_draft_seq is
  '구 초안번호(DRAFT-YYYYMMDD-nnnn) 시퀀스 — 2026-08-27 채번규칙 재정립으로 사용 중단. 롤백 대비로만 남긴다.';

commit;

-- ═══════════════════════════════════════════════════════════════════════
-- 9) 확인 쿼리 (적용 후 눈으로 보는 용도)
-- ═══════════════════════════════════════════════════════════════════════
-- 작성자 코드 대장
--   select owner_cd, owner_nm, owner_upn, created_at from public.gl_draft_owner order by owner_cd;
-- 번호 발급 현황
--   select owner_cd, ymd, last_n, updated_at from public.gl_draft_no_ctr order by ymd desc, owner_cd;
-- 신·구 번호 혼재 확인
--   select case when draft_no like 'AX%' then '신규규칙' else '구번호' end as 구분,
--          count(*), min(draft_no), max(draft_no)
--   from public.gl_draft group by 1;

-- ═══════════════════════════════════════════════════════════════════════
-- 10) 롤백 (필요 시)
-- ═══════════════════════════════════════════════════════════════════════
-- drop trigger if exists gl_draft_no_bi on public.gl_draft;
-- alter table public.gl_draft alter column draft_no set default
--   'DRAFT-' || to_char((now() at time zone 'Asia/Seoul'), 'YYYYMMDD')
--            || '-' || lpad(nextval('public.gl_draft_seq')::text, 4, '0');
-- drop function if exists public.gl_draft_no_bi();
-- drop function if exists public.gl_draft_next_no(text, text);
-- drop function if exists public.gl_draft_owner_cd(text, text);
-- drop table if exists public.gl_draft_no_ctr;
-- drop table if exists public.gl_draft_owner;  drop sequence if exists public.gl_draft_owner_seq;
