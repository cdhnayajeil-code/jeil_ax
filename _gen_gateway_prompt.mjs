// _gen_gateway_prompt.mjs — 운영 챗봇(jeil-chat) 시스템 지시문을 jeil-chat-lab 의 조립 규칙으로 생성한다(REQ-0114).
//
// 실행:  node _gen_gateway_prompt.mjs            → 정본 SQL 94 재생성 + 글자 수 출력
//        node _gen_gateway_prompt.mjs --print    → 지시문 본문만 표준출력(관리자 콘솔 「모델 설정」 지시문 칸에 붙여 넣을 때)
//
// 왜 생성하나
//   운영 챗봇은 DB 지시문(ai_gateway_config.system_prompt) 한 덩어리를 쓴다. 2026-07-09 이후 손으로만 고쳐 와서
//   코드 상수·실험실 조립 문구와 네 도구(get_erp_item_orders·get_hr_headcount·get_my_access·get_my_requests) 안내가 어긋나 있었다(13 기획 §1).
//   이제는 core/prompt.ts(공통 머리말·도메인 안내) + 운영 도구 19종의 prompt_hint 로 **같은 규칙에서** 운영 지시문을 만든다.
//   운영 jeil-chat 은 오늘 날짜를 주입하지 않으므로 연도 해석 절을 끝에 덧붙인다(후속: 운영 코드에도 날짜 주입 — 09 문서 §7).
//   손으로 SQL 을 고치지 않는다 — prompt.ts 를 고치고 이 스크립트를 다시 돌린다(`node _test_prompt_assembly.mjs` 가 동기화를 검사).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const LAB = join(ROOT, "supabase/functions/jeil-chat-lab");
const SQL = join(ROOT, "실제구축준비 자료/이관/sql/94_gateway_system_prompt_v2.sql");

const { assemblePrompt, joinPrompt } = await import(`file://${LAB.replace(/\\/g, "/")}/core/prompt.ts`);
const { MODULES: PORTED } = await import(`file://${LAB.replace(/\\/g, "/")}/modules/index.ts`);

/** 운영 jeil-chat 에만 붙는 꼬리 — 날짜 주입이 없어서 연도 해석을 글로 준다(기존 DB 지시문의 문장을 절로 옮김). */
export const GATEWAY_TAIL =
  "■ 날짜\n이 대화에는 오늘 날짜가 주어지지 않습니다. 연도 없이 '6월'·'이번 달'처럼 말하면 2026년으로 해석하세요(ERP 실데이터 가용 범위 2026-01~). " +
  "특정 월 상세가 0건이면 도구의 '월별' 배열에서 데이터가 있는 월을 확인해 그 값으로 답하거나 가용 월을 안내하세요.";

export function gatewayPrompt() {
  const mods = PORTED.map((m) => m.manifest).filter((m) => m.status !== "off");
  const parts = assemblePrompt(mods, []);
  return joinPrompt(parts) + "\n\n" + GATEWAY_TAIL;
}

const main = () => {
  const text = gatewayPrompt();
  if (process.argv.includes("--print")) { process.stdout.write(text + "\n"); return; }
  const tools = PORTED.map((m) => m.manifest.id).sort().join(", ");
  const sql = [
    "-- 94_gateway_system_prompt_v2.sql — 운영 챗봇(jeil-chat) 시스템 지시문 개편(REQ-0114 · 2026-10-07)",
    "--",
    "-- 생성물이다. `node _gen_gateway_prompt.mjs` 가 jeil-chat-lab/core/prompt.ts 의 공통 머리말(정체·답변 원칙·도구 사용 원칙·안전)",
    "-- + ERP·도메인 안내 + 운영 도구 19종의 prompt_hint 로 조립한다. 손으로 고치지 않는다 — prompt.ts 를 고치고 다시 생성한다.",
    "-- 바뀐 것(이전 DB 값 대비): 한 덩어리 평문 → 절(■)+번호 규칙 · 도구 사용 원칙 7(조회 순서·0건 재조회·반복 금지·한도 안내) ·",
    "--   지시문 비공개·주입 방어 · 누락됐던 도구 4종 안내(get_erp_item_orders·get_hr_headcount·get_my_access·get_my_requests) · 연도 해석 절.",
    "-- 적용 범위: 운영 jeil-chat 전 사용자(ai.jeilm.co.kr /main 챗봇). 관리자 콘솔 「모델 설정」 지시문 칸에 같은 본문을 붙여 넣어도 결과는 같다.",
    "-- 적용 전 확인: 콘솔 「모델 설정」의 「점검」(action test_model)으로 기본 모델이 새 지시문을 400 없이 받는지 1회.",
    "-- 되돌리기: 94_gateway_system_prompt_v2_rollback.sql (적용 직전 값 보존 · 2026-10-07 조회본)",
    `-- 포함 도구(${PORTED.length}): ${tools}`,
    `-- 글자 수: ${text.length.toLocaleString()}`,
    "",
    "update public.ai_gateway_config",
    "   set system_prompt = $jeilax$" + text + "$jeilax$",
    " where id = 1;",
    "",
  ].join("\n");
  writeFileSync(SQL, sql, "utf8");
  console.log(`정본 SQL 94 생성: ${text.length.toLocaleString()}자 · 도구 ${PORTED.length}종 → ${SQL}`);
};
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
