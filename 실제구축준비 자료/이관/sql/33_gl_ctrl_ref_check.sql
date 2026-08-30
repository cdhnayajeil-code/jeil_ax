-- =====================================================================
-- 33_gl_ctrl_ref_check.sql — 관리항목 값 실존 판정 RPC (REQ-0015)
--   결의전표 관리항목에 적은 코드가 **ERP 마스터에 실재하는 값인지**를 한 번에 판정한다.
--   화면(입력 즉시)·Edge Function(저장·제출·전송)이 같은 함수를 쓴다 — 판정 기준 단일화.
--
--   왜 만드나(2026-08-28 결함):
--     종전 검증은 Edge Function 안에서 `erp_ro` 스키마를 **REST로 직접 조회**했다.
--     그런데 erp_ro 는 REST 비노출이라 조회가 조용히 빈 결과를 돌려주고,
--     코드는 그것을 "참조 마스터가 없는 항목"으로 해석해 **무조건 통과**시켰다.
--     → 손입력 거래처 `123` 이 ERP까지 가서 채권원장(A_OPEN_AR) 외래키 위반을 냈다.
--     조회를 RPC(security definer)로 옮기면 스키마 노출 설정과 무관하게 동작한다.
--
--   왜 ctrl_ref_s 하나로 안 되나:
--     거래처(BP·V6·X01)·품목(MK)은 통합 미러 `ctrl_ref_s` 에 적재하지 않는다
--     (건수가 커 전용 검색 RPC gl_bp_search·gl_item_search 를 쓴다 — etl_run.py §294).
--     그래서 판정도 전용 미러(bp_master_s·item_master_s)를 봐야 한다.
--     어느 쪽을 볼지는 화면에 박지 않고 **ERP 마스터의 참조테이블(ctrl_item_s.ref_tbl)** 로 정한다.
--
--   적용 이력(Supabase migration):
--     gl_ctrl_ref_check_v1   (2026-08-28) 본 함수 신설
--   관련: 23_erp_ctrl_master.sql(ctrl_item_s) · 27_gl_ctrl_ref.sql(ctrl_ref_s)
--        · 20_erp_etl_upsert_bp_master_fix.sql(bp_master_s)
-- =====================================================================

-- ── 판정 RPC ─────────────────────────────────────────────────────────
--   입력: [{"cd":"BP","val":"123"}, {"cd":"PC","val":"999-999"}, ...]
--   출력: [{"cd","val","ctrl_nm","state","nm"}, ...]
--     state = 'ok'      마스터에 있고 사용중 → nm 에 명칭(화면에 초록으로 표시)
--             'off'     있으나 사용중지(폐지) → 새 전표에 쓰면 안 된다
--             'bad'     마스터에 없다 → ERP 투입 시 실패한다
--             'unknown' 참조 마스터가 없는 항목(날짜·금액·자유입력) → 판정 대상 아님
--   빈 값·빈 코드는 결과에서 빠진다(필수 여부는 별도 규칙 — A_ACCT_CTRL_ASSN).
create or replace function public.gl_ctrl_ref_check(p_pairs jsonb)
  returns jsonb language plpgsql stable security definer set search_path to ''
as $$
declare
  r        jsonb;
  v_cd     text;
  v_val    text;
  v_tbl    text;
  v_ctrl   text;
  v_nm     text;
  v_state  text;
  v_loaded boolean;
  v_out    jsonb := '[]'::jsonb;
  v_seen   text[] := '{}';
  v_key    text;
begin
  for r in select value from jsonb_array_elements(coalesce(p_pairs, '[]'::jsonb)) loop
    v_cd  := btrim(upper(coalesce(r->>'cd', '')));
    v_val := btrim(coalesce(r->>'val', ''));
    continue when v_cd = '' or v_val = '';

    -- 같은 (항목,값)을 두 번 판정하지 않는다(라인 수만큼 왕복하지 않게)
    v_key := v_cd || '|' || v_val;
    continue when v_key = any(v_seen);
    v_seen := v_seen || v_key;

    v_tbl := ''; v_ctrl := v_cd; v_nm := null; v_state := 'unknown';
    select btrim(upper(coalesce(c.ref_tbl, ''))), coalesce(c.ctrl_nm, v_cd)
      into v_tbl, v_ctrl
      from erp_ro.ctrl_item_s c
     where btrim(upper(c.ctrl_cd)) = v_cd
     limit 1;
    v_tbl  := coalesce(v_tbl, '');
    v_ctrl := coalesce(v_ctrl, v_cd);

    if v_tbl = 'B_BIZ_PARTNER' then
      -- 거래처 — A_OPEN_AR/A_OPEN_AP 외래키의 실제 대상. 이번 결함의 진원지다.
      select b.bp_nm, case when b.use_yn then 'ok' else 'off' end
        into v_nm, v_state
        from erp_ro.bp_master_s b
       where btrim(b.bp_cd) = v_val
       limit 1;
      if not found then v_state := 'bad'; v_nm := null; end if;

    elsif v_tbl = 'B_ITEM' then
      select i.item_name, case when i.use_yn then 'ok' else 'off' end
        into v_nm, v_state
        from erp_ro.item_master_s i
       where btrim(i.item_code) = v_val
       limit 1;
      if not found then v_state := 'bad'; v_nm := null; end if;

    else
      -- 나머지 27종 — 통합 미러. **적재된 항목만** 판정한다.
      -- 미적재(민감항목 미수집 등)를 'bad' 로 몰면 정상 입력을 막게 된다.
      select exists(select 1 from erp_ro.ctrl_ref_s x where x.ctrl_cd = v_cd) into v_loaded;
      if v_loaded then
        select x.ref_nm into v_nm
          from erp_ro.ctrl_ref_s x
         where x.ctrl_cd = v_cd and btrim(x.ref_cd) = v_val
         limit 1;
        v_state := case when found then 'ok' else 'bad' end;
      else
        v_state := 'unknown'; v_nm := null;
      end if;
    end if;

    v_out := v_out || jsonb_build_object(
      'cd', v_cd, 'val', v_val, 'ctrl_nm', v_ctrl, 'state', v_state, 'nm', v_nm);
  end loop;
  return v_out;
end;
$$;

comment on function public.gl_ctrl_ref_check(jsonb) is
  '관리항목 값 실존 판정(ok/off/bad/unknown). 화면 즉시검증·저장·제출·ERP전송이 공유하는 단일 기준. 정본 33_gl_ctrl_ref_check.sql';

-- 호출은 Edge Function(service_role)만. 브라우저가 직접 부르지 않는다 —
-- 사번·계좌 등 민감 관리항목의 존재 여부를 익명으로 캐물을 수 있게 되면 안 된다.
revoke execute on function public.gl_ctrl_ref_check(jsonb) from public, anon, authenticated;
grant  execute on function public.gl_ctrl_ref_check(jsonb) to service_role;
