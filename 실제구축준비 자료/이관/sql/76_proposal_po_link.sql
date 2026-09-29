-- 76_proposal_po_link.sql — 기안서 ↔ 발주(PO) 연결 뷰 + 기안서 대사 상세 래퍼(REQ-0092 · 12_에이전트관리/04)
--
-- 기안서 대장(비ERP 엑셀)에는 발주번호 칸이 없다. 두 길로 잇는다(2026-09-29 실측 830건):
--   ① 전표 경유(확정) — 대장 전표번호 → ERP 전표(TG).ref_no 또는 IV 번호 → 매입(iv_dtl).po_no     479건
--   ② 추정 — 대장 JOB번호 = 발주통합 LIST P-CODE(같은 형식) + 거래처명 + 금액(공급가 ±2%)으로 1건이 딱 떨어질 때  540건
--   두 길이 모두 되는 351건 중 345건(98.3%)이 같은 발주 → 추정도 믿을 만하다. 합치면 668건(80%).
--   ①이 있는 기안은 ①만 쓴다(추정을 덧붙이지 않는다). ①이 없을 때만 ②.
--
-- 읽기 전용 뷰 — 테이블을 만들지 않는다. security_invoker 라 사내 사용자는 원 테이블 RLS 를 그대로 받는다.
-- 롤백: 76_proposal_po_link_rollback.sql

create or replace view public.v_pur_proposal_po_link with (security_invoker = true) as
with tok as (          -- 대장 전표 칸(선급·중도·잔금) → 토큰(한 칸에 여러 개 · 공백·쉼표·슬래시 구분)
  select p.vol, p.no, s.stage, btrim(t) as slip
    from public.pur_proposal p
   cross join lateral (values ('dp', p.dp_slip), ('mp', p.mp_slip), ('bp', p.bp_slip)) s(stage, slip)
   cross join lateral unnest(regexp_split_to_array(coalesce(s.slip, ''), '[\s,/]+')) t
   where btrim(t) ~ '^(TG|IV)'
), ivs as (            -- 결의전표(TG)는 ref_no 가 IV 면 매입에서 올라온 전표
  select t.vol, t.no, t.stage, t.slip,
         coalesce(case when t.slip like 'IV%' then t.slip end,
                  case when g.ref_no like 'IV%' then g.ref_no end) as iv_no
    from tok t
    left join erp_ro.gl_slip_s g on g.temp_gl_no = t.slip
), via_slip as (
  select i.vol, i.no, d.po_no,
         array_agg(distinct i.slip order by i.slip) as slips,
         array_agg(distinct i.iv_no order by i.iv_no) as iv_nos
    from ivs i
    join erp_ro.iv_dtl_s d on d.iv_no = i.iv_no
   where d.po_no is not null
   group by i.vol, i.no, d.po_no
), c as (              -- 추정 대상: 전표 경유가 없는 기안
  select k.vol, k.no, k.job_no, nullif(btrim(k.vendor), '') as vendor, k.amt
    from public.v_pur_proposal_case k
   where k.job_no is not null and k.job_no <> '9999-999'
     and not exists (select 1 from via_slip v where v.vol = k.vol and v.no = k.no)
), po as (
  select p_code, bp_name, po_no, sum(amt) as po_amt
    from public.v_erp_pur_list
   where po_no is not null and p_code is not null
   group by p_code, bp_name, po_no
), cand as (
  select c.vol, c.no, po.po_no,
         (c.amt > 0 and abs(po.po_amt - c.amt) <= greatest(c.amt * 0.02, 1000)) as amt_ok,
         count(*) over (partition by c.vol, c.no) as n_all,
         count(*) filter (where c.amt > 0 and abs(po.po_amt - c.amt) <= greatest(c.amt * 0.02, 1000))
           over (partition by c.vol, c.no) as n_amt
    from c
    join po on po.p_code = c.job_no
           and c.vendor is not null and po.bp_name is not null
           and (po.bp_name ilike '%' || c.vendor || '%' or c.vendor ilike '%' || po.bp_name || '%')
)
select v.vol, v.no, v.vol || '-' || v.no as key, v.po_no,
       '전표 경유'::text as method, '확정'::text as confidence, v.slips, v.iv_nos
  from via_slip v
union all
select x.vol, x.no, x.vol || '-' || x.no, x.po_no,
       case when x.n_amt = 1 then '프로젝트·거래처·금액' else '프로젝트·거래처' end,
       '추정'::text, null::text[], null::text[]
  from cand x
 where (x.n_amt = 1 and x.amt_ok) or (x.n_amt <> 1 and x.n_all = 1);

comment on view public.v_pur_proposal_po_link is
  '기안서(권-번호) ↔ 발주(PO) 연결 — 전표 경유(확정: 대장 전표→ERP 전표 ref_no/IV→매입→PO) 우선, 없으면 추정(JOB번호=P-CODE+거래처+금액±2%). REQ-0092';

grant select on public.v_pur_proposal_po_link to authenticated, service_role;
revoke all on public.v_pur_proposal_po_link from anon;

-- 기안서 대사 상세(전표 분개·세금계산서) — 게이트웨이용 래퍼. 74번 agent_proposal_recon 과 같은 방식:
-- 원 함수 proposal_recon_detail() 이 auth.jwt() 로 권한을 보므로, 검증된 upn 을 트랜잭션 한정 클레임으로 넣고 그대로 부른다.
create or replace function public.agent_proposal_recon_detail(p_upn text, p_vol smallint, p_no integer)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if coalesce(p_upn, '') !~ '^[a-z0-9._-]+@jeilm\.co\.kr$' then
    raise exception 'invalid upn' using errcode = '22023';
  end if;
  perform set_config('request.jwt.claims',
    jsonb_build_object('email', p_upn, 'app_metadata', jsonb_build_object('role', 'internal'))::text, true);
  return public.proposal_recon_detail(p_vol, p_no);
end $function$;
revoke all on function public.agent_proposal_recon_detail(text, smallint, integer) from public, anon, authenticated;
grant execute on function public.agent_proposal_recon_detail(text, smallint, integer) to service_role;

-- ── 확인 ─────────────────────────────────────────────────────────────────────
-- select confidence, method, count(distinct key) 건, count(*) 연결 from public.v_pur_proposal_po_link group by 1,2;
--   -- 확정·전표 경유 479건 / 추정 약 190건(전표 경유가 없는 기안만) → 합계 약 668건
