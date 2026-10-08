// jeil-chat — 사내 AI 챗봇 게이트웨이 (OpenAI 프록시 + 포털DB 조회 도구 + 토큰·비용 기록)
// 배포: verify_jwt=false (Entra 토큰은 Supabase JWT가 아니므로 내부에서 직접 검증)
// 호출: POST /functions/v1/jeil-chat  Authorization: Bearer <Entra access_token(User.Read)>
//   body: { messages: [{role,content},...], session_id?, work_id?, save? } — 세션 필드는 대화 저장 opt-in(없으면 구버전과 동일 동작)
//   관리자 점검(REQ-0095): body { action:"test_model", model_id, force?, relearn? } → JSON — 관리자(portal_admin) 전용,
//     실제 호출 모양(지시문·도구·적응 루프) 그대로 시험 질문 1건 · 도구 미실행 · chat_log/세션 미기록 · 결과는 ai_model.last_check_* 에 기록.
//   응답: SSE — {"choices":[{"delta"}]} · {"jeilax": 뷰} · {"jeilax_meta": 세션정보(최초 1회)} · [DONE]
//   중지: 클라이언트 fetch abort → (A) req.signal / (B) writer.write 실패 이중 감지 → OpenAI 업스트림 abort(비용 차단), 부분 응답은 저장.
// 원칙(CLAUDE.md §1·§4·§6):
//   - API 키는 서버 시크릿(OPENAI_API_KEY)에만 존재. 프론트 미노출.
//   - 데이터 접근은 사전 등록된 읽기전용 도구만(모델의 임의 SQL 금지). 포털DB + ERP 중간DB 사본(public.v_erp_* 뷰) — ERP 운영DB 직접 조회는 없음.
//   - chat_log에 사용 이력 + 토큰·추정비용·사용도구 기록. 대화 원문은 chat_session/chat_message에 저장 —
//     열람·참여는 본인 또는 공유 work(작업 폴더) 팀원만(ADR-009, v25 팀 공유). 조회·삭제·팀 관리는
//     jeil-chat-history 경유, 킬스위치 ai_gateway_config.chat_save_enabled.
//   - 도구 결과는 SSE 'jeilax' 이벤트로 구조화 뷰(5종)를 병행 송출 — 프론트 카드 직결(모델 미경유·수치 환각 차단, 11_제품기획/10).
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

// 입력 상한 폴백 기본값 (DB ai_gateway_config 미설정/조회실패 시에만 사용)
const MAX_MESSAGES = 20;
const MAX_MSG_CHARS = 8000;
const MAX_TOTAL_CHARS = 24000;
const MAX_TOKENS = 1024;
const DEFAULT_TEMP = 0.3;

// 모델 단가표 폴백 (USD / 1M 토큰). 실제 단가는 DB ai_model(price_in/price_out) 우선.
const PRICES: Record<string, { inp: number; out: number }> = {
  "gpt-4o-mini": { inp: 0.15, out: 0.60 },
  "gpt-4o": { inp: 2.50, out: 10.00 },
  "gpt-4.1-mini": { inp: 0.40, out: 1.60 },
};

const SYSTEM_PROMPT =
  "당신은 제일엠앤에스(JEIL M&S)의 사내 AI 어시스턴트 'jeil-chat'입니다. " +
  "업무 문서 초안(주간보고·메일·공지), 규정 질의, 데이터 요약을 한국어로 간결하고 정확하게 돕습니다. " +
  "협력사 외주 '검사' 현황은 포털 도구(get_order_summary/get_order_detail 등)로 답하고, 답변에 조회 기준 시각을 표기하세요. " +
  "매출·매입·재고·품목·발주 등 ERP 데이터는 ERP 중간DB 조회 도구(get_erp_*)를 사용하되, 유니포인트 매핑 확정 전 '파일럿 데이터'임을 답변에 밝히세요. " +
  "'발주'는 기본적으로 ERP 전체 구매발주(get_erp_pur_order)를 의미합니다. 특정 발주번호(PO)·구매요청번호(PR) 조회는 get_erp_po_pr, '가장 금액이 큰/최대/상위(top) 발주·구매요청'은 get_erp_pur_top 을 쓰세요(임의 레코드를 최대라고 답하지 말 것). 구매요청 자체엔 금액 컬럼이 없어 연결된 발주금액 기준으로 판단합니다. 협력사 외주 검사 관련일 때만 get_order_summary(포털)를 쓰고, 서로 다른 발주 데이터를 혼동하지 마세요. " +
  "★번호 형식 구분(매우 중요): 발주번호는 'PO'+날짜+일련(예 PO202607210001), 구매요청번호는 'PR'+…(예 PR202607020013), 품목코드는 '문자-숫자'(예 S3041-00065)로 서로 다릅니다. " +
  "★'품목코드(예: S3041-00065)나 품목명으로 그 품목의 발주·구매요청·매입 이력을 조회'하려면 반드시 get_erp_item_orders 를 쓰세요. 품목코드는 발주번호가 아니므로 get_erp_po_pr 의 po_no/pr_no 에 품목코드를 절대 넣지 마세요(넣으면 '없음'으로 오답). 품목코드로 물었는데 발주가 있으면 있다고 정확히 답하고, 품목코드를 발주번호처럼 답하지 마세요. 도구가 '재시도도구'를 반환하면 그 도구로 다시 조회하세요. " +
  "월별 표를 그릴 때는 도구가 반환한 '월별' 배열의 각 월 값을 그대로 사용하고, 값이 없는 월을 임의로 '미제공'으로 적지 마세요. " +
  "ERP 발주·구매요청의 진행단계 코드는 반드시 한글로 풀어 답하세요: RQ(요청)→CF(확정)→PO(발주완료·입고전)→GR(입고완료)→IV(매입/송장완료). 진행수량은 요청(req_qty)→발주(ord_qty)→입고(rcpt_qty)→매입(iv_qty) 순이며, 도구가 준 이 수량으로 '어디까지 진행됐는지'를 설명하세요. " +
  "'매입'의 공식 집계는 송장 기준 get_erp_purchase_monthly(거래처×월)입니다. 개별 발주의 상태 IV는 그 발주의 '매입완료' 진행표시로만 해석하고, 두 수치를 합산·혼동하지 마세요. " +
  "재고·입고 수치(get_erp_inventory_status)는 현재 중간DB에 출고만 유효하고 입고량·재고량은 미적재입니다 — '입고 0/재고 없음'을 실적으로 단정하지 말고 미적재 상태임을 밝히며, 특정 발주의 입고 여부는 발주 조회(get_erp_po_pr)의 입고수량으로 답하세요. 매출의 수금액·수주액도 미매핑(0)이니 매출액만 답하세요. " +
  "품목명에 '사용금지' 표기가 있는 코드는 신규 발주용으로 제시하지 말고 대체코드 확인을 안내하세요. " +
  "도구가 '접근제한'(요청안내)을 반환하면 데이터를 지어내지 말고, 반환된 '안내' 문구 그대로 사용자에게 관리자 권한 요청 방법을 안내하세요. " +
  "'내 권한 확인', '나 뭐 볼 수 있어?', '이 페이지 왜 안 보여?' 류 권한 질의는 일반론으로 답하지 말고 반드시 get_my_access 도구로 로그인 본인의 실제 역할·부서·ERP 모듈·페이지 권한을 조회해 답하세요(관리자면 관리자라고 정확히 알릴 것). 본인 외 타인의 권한은 조회할 수 없습니다. " +
  "인원현황(재적·급여대상 인원)은 get_hr_headcount, 급여 총액 집계는 get_hr_payroll을 쓰세요. 인원 수치는 급여대장(HDF070T) 기준 '급여대상 인원'이며 마감 전 변동 가능함을 밝히세요. 부서별 인원 분포·급여액은 인사팀·관리자만 열람 가능하고, 그 외에는 전사 총원만 제공됩니다 — 권한 밖 수치를 추정·역산하지 마세요. " +
  "도구로 조회할 수 없는 사내 수치·규정은 추측하지 말고 원본 확인을 권하세요. " +
  "도구 조회 수치는 화면에 표·카드(구조화 뷰)로 자동 표시되므로, 동일 수치를 표로 길게 반복 나열하지 말고 핵심 요약·해석·비교·시사점 중심으로 간결히 답하세요. " +
  "요청자·사용자 아이디는 도구가 '부서_이름_아이디' 형식(예: 총무팀_최동혁_dh.choi@jeilm.co.kr)으로 제공하므로 그 표기를 그대로 쓰고 임의로 분해·재구성하지 마세요(미매핑 계정은 아이디만 표시됨). " +
  "사용자의 OneDrive·SharePoint 문서 관련 질의('내 문서', '회의록 찾아', '이 파일 요약' 등)는 search_my_documents(검색)로 파일을 찾고, 상세·본문이 필요하면 검색결과의 driveId·itemId로 read_document를 호출하세요. 문서 검색은 회사가 승인한 프로젝트 폴더(화이트리스트) 안에서, 그중에서도 로그인한 본인 권한 범위만 조회됩니다(Microsoft 보안 트리밍) — 이를 답변에 밝히고 출처(파일명·링크)를 표기하세요. 검색 결과가 없으면 '승인된 AI 연동 범위에 해당 문서가 없다'고 정직하게 안내하세요. 본문 판독은 Excel·텍스트 파일만 가능하며, 그 외 형식은 링크 안내로 대체하세요. " +
  "급여·주민번호 등 개인정보나 비밀값을 답변에 포함하지 마세요.";

/* ===== 1단계 포털DB 조회 도구 (읽기전용 · 집계/요약만 반환) ===== */
const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_order_summary",
      description: "협력사 '외주 검사' 발주 현황(포털DB — 협력사 포털에 등록된 외주 검사 대상 발주, 소수 건). 상태별 건수·검사 진행·납기임박. ※ ERP 전체 구매발주(수천 건·월별)는 get_erp_pur_order 를 쓸 것.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_order_detail",
      description: "협력사 '외주 검사' 발주 상세만 조회(포털DB, 소수 건) — 진행상태(10단계)·검사결과·검수요청·사진·메시지 건수. ※일반 ERP 구매발주(PO…번호)의 발주 상세·품목·금액·거래처·구매요청은 이 도구가 아니라 get_erp_po_pr 를 쓸 것. 협력사 검사 대상이 아닌 발주번호는 여기서 조회되지 않는다.",
      parameters: {
        type: "object",
        properties: { po_no: { type: "string", description: "발주번호 (예: PO202607010128)" } },
        required: ["po_no"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_inspection_pending",
      description: "검수요청이 접수됐지만 아직 합/부 판정이 나지 않은(검사 대기) 발주 목록 — 발주번호, 협력사, 납기, 요청일시.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  /* ===== 2단계 ERP 중간DB 조회 도구 (사내 실데이터 · 읽기전용 뷰 v_erp_* · 파일럿) ===== */
  {
    type: "function",
    function: {
      name: "get_erp_sales_monthly",
      description: "ERP 매출 월집계(중간DB 사내 실데이터) — 거래처×월 매출액·건수(현재 가용 2026-01~). '이번달 매출', '거래처별 매출' 류 질의에 사용. ※수금액·수주액은 미매핑(0)이니 매출액만 답할 것. 파일럿(유니포인트 매핑 확정 전).",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_erp_purchase_monthly",
      description: "ERP 매입 월집계(중간DB 사내 실데이터, 송장 M_IV 기준) — 거래처×월 매입액·전표건수(현재 가용 2026-01~). '매입 현황', '거래처별 매입', '특정 거래처/특정 월 매입' 류 질의에 사용. bp(거래처명·코드)·ym(YYYY-MM) 지정 시 해당 거래처×월 상세 반환.",
      parameters: { type: "object", properties: { bp: { type: "string", description: "거래처명 또는 코드(선택)" }, ym: { type: "string", description: "조회 월 YYYY-MM(선택)" } }, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_erp_inventory_status",
      description: "ERP 재고 입출고 현황(중간DB 사내 실데이터) — 품목×창고, 최근 31일. '재고', '입출고' 류 질의에 사용. ※현재 중간DB는 출고만 유효하고 입고량·재고량은 미적재(0/미표기) — 특정 발주의 입고 여부는 get_erp_po_pr(입고수량)로 답할 것.",
      parameters: { type: "object", properties: { item_code: { type: "string", description: "품목코드(선택, 특정 품목만)" } }, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_erp_item",
      description: "ERP 품목 조회(중간DB 사내 실데이터) — 코드/명 부분일치로 품목 마스터 검색(규격·단위·분류·사용금지 여부). '품목 있어?', '품목코드 뭐야' 류 질의에 사용. 품목명에 '사용금지' 표기가 있으면 신규 발주 제시 금지. ※그 품목의 발주·구매요청·매입 이력은 get_erp_item_orders 를 쓸 것.",
      parameters: { type: "object", properties: { keyword: { type: "string", description: "품목코드 또는 품목명 키워드" } }, required: ["keyword"] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_erp_item_orders",
      description: "특정 '품목'의 구매요청·발주·매입 이력 조회(중간DB 사내 실데이터, 2026 전체). 품목코드(예: S3041-00065)나 품목명으로 그 품목이 언제·누가·얼마에 요청/발주/매입됐는지 반환(구매요청 PR·발주 PO·연결관계·수량·금액·상태). '이 품목(코드) 발주됐어?', '품목코드로 구매요청/발주 조회', 'S3041-00065 발주·구매요청 알려줘' 류에 반드시 이 도구를 쓸 것. ※품목코드는 발주번호(PO…)·구매요청번호(PR…)가 아니므로 get_erp_po_pr 에 품목코드를 넣지 말 것.",
      parameters: { type: "object", properties: { item: { type: "string", description: "품목코드(예: S3041-00065) 또는 품목명 키워드" } }, required: ["item"] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_erp_pur_order",
      description: "ERP 전체 구매발주 현황(중간DB 사내 실데이터, 2026년 수천 건) — 월별 발주건수·발주금액·거래처수, 특정 월 상세(거래처Top·상태분포). '1월 발주', 'ERP 발주 현황', '월별 발주 얼마' 류 질의에 사용. (협력사 외주 검사 발주는 get_order_summary)",
      parameters: { type: "object", properties: { ym: { type: "string", description: "조회 월 YYYY-MM(선택, 예 2026-01). 없으면 월별 전체 요약" } }, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_erp_po_pr",
      description: "ERP 구매발주 상세 + 발주↔구매요청 연결 조회(중간DB 사내 실데이터, 2026 전체 수천 건). 발주번호(PO…) 또는 구매요청번호(PR…)로 발주 상세(거래처·품목·수량·발주금액·발주일·상태)와 연결 구매요청(요청일·필요납기·요청자·부서) 조회. 특정 발주번호(예: PO202606230022)의 상세·품목·금액·거래처 질의는 반드시 이 도구를 쓸 것(협력사 검사 발주가 아니면 get_order_detail 로는 조회 안 됨). 'PO… 발주 상세/내역/품목/금액', 'PO… 구매요청 뭐야', 'PR… 발주됐어?' 류. po_no 또는 pr_no 중 하나 필수. ※이 도구는 PO/PR '번호' 전용 — 품목코드(예: S3041-00065)를 넣지 말 것(품목 이력은 get_erp_item_orders).",
      parameters: { type: "object", properties: { po_no: { type: "string", description: "발주번호(예: PO202607080001)" }, pr_no: { type: "string", description: "구매요청번호(예: PR202607060009)" } }, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_erp_pur_top",
      description: "ERP 발주 금액 상위(top N) 조회 — 발주번호별 총액(라인 합산) 큰 순으로 발주번호·거래처·발주총액·라인수·대표품목. '가장 금액이 큰 발주', '발주 top 5', '최대 금액 구매' 류. 동일 발주 중복 없이 발주 총액 기준(라인 단위 아님).",
      parameters: { type: "object", properties: { n: { type: "integer", description: "상위 몇 건(기본 10, 최대 30)" } }, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_erp_receipt_pending",
      description: "ERP 미입고 발주 목록(중간DB 사내 실데이터) — 발주완료(상태 PO)됐지만 아직 입고(GR) 전인 발주 라인. '미입고 발주', '납기 지난 미입고', '입고 안 된 발주' 류 질의에 사용. overdue_only=true면 납기경과·미입고만.",
      parameters: { type: "object", properties: { overdue_only: { type: "boolean", description: "납기경과·미입고만(선택)" }, limit: { type: "integer", description: "최대 건수(기본 30, 최대 100)" } }, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_erp_pur_req",
      description: "ERP 구매요청(PR) 목록 조회(중간DB 사내 실데이터) — 상태·부서별 구매요청. '미발주 구매요청 몇 건/목록'(status=unordered), '우리 팀 구매요청', 'RQ(요청)/CF(확정) 상태 PR' 류. 특정 PR 단건 상세는 get_erp_po_pr(pr_no)를 쓸 것.",
      parameters: { type: "object", properties: { status: { type: "string", description: "unordered(미발주)/RQ/CF 등(선택)" }, dept: { type: "string", description: "요청부서 키워드(선택)" }, limit: { type: "integer", description: "최대 건수(기본 30, 최대 100)" } }, required: [] },
    },
  },
  /* ===== 4단계 인사·권한 도구 (본인 권한 조회 = 전 직원 / 인원·급여 = 등급별) ===== */
  {
    type: "function",
    function: {
      name: "get_my_access",
      description: "로그인한 '본인'의 포털 권한 조회 — 역할(관리자/부서관리자/일반), 소속 부서, 열람 가능한 ERP 데이터 모듈, 접근 가능/불가 운영페이지 목록, 권한 요청 방법. '내 권한 뭐야', '나 관리자야?', '어떤 데이터 볼 수 있어?', '이 페이지 왜 안 보여' 류 질의에 반드시 사용(추측 답변 금지). 타인의 권한은 조회 불가.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_hr_headcount",
      description: "인원현황 조회(급여대장 HDF070T 기준 급여대상 인원, 2026-01~). 월별 전사 총원은 전 직원 조회 가능하고, 부서별 인원 분포는 인사팀·관리자만 반환된다. '2026년 인원현황', '이번달 몇 명', '부서별 인원' 류 질의에 사용. 급여 금액은 포함하지 않음(금액은 get_hr_payroll).",
      parameters: { type: "object", properties: { ym: { type: "string", description: "조회 월 YYYY-MM(선택). 없으면 월별 전체 추이" } }, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_hr_payroll",
      description: "인사 급여 집계 조회(민감 — 인사팀·관리자 전용, 접근 감사 기록됨). 월별·부서별 급여대상 인원·급여총액·퇴직급여 집계. 개인별 급여·주민번호·계좌는 중간DB에 없으며 조회 불가. '급여총액', '인건비 추이' 류 질의에 사용.",
      parameters: { type: "object", properties: { ym: { type: "string", description: "조회 월 YYYY-MM(선택)" } }, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_my_requests",
      description: "로그인한 '본인'이 접수한 포털 요청의 진행상황 조회 — 접수번호·유형(권한/데이터 적재범위 등)·상태·대상·처리 회신. '내 요청 어떻게 됐어?', '권한 요청 진행상황', '내가 낸 요청 보여줘' 류 질의에 사용. 본인이 낸 건과 동조자로 참여한 건만 조회되며 타인의 요청은 조회할 수 없다.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  /* ===== 3단계 문서 도구 (사용자 OneDrive/SharePoint · 위임 토큰 · 보안 트리밍) ===== */
  {
    type: "function",
    function: {
      name: "search_my_documents",
      description: "사용자의 OneDrive·SharePoint 문서 검색(Microsoft Graph). 단, AI 연동이 승인된 프로젝트 폴더(화이트리스트) 안에서만, 그중에서도 본인 권한 범위만 자동 트리밍된다. '내 문서/회의록/보고서/특정 파일 찾아줘' 류 질의에 사용. 파일명·수정일·링크와 함께 read_document 호출용 driveId·itemId를 반환한다. 승인 범위 밖 문서는 조회되지 않는다.",
      parameters: { type: "object", properties: { query: { type: "string", description: "검색어(파일명·키워드)" }, limit: { type: "integer", description: "최대 건수(기본 8, 최대 15)" } }, required: ["query"] },
    },
  },
  {
    type: "function",
    function: {
      name: "read_document",
      description: "특정 문서의 상세·본문 조회(사용자 위임 토큰). search_my_documents가 준 driveId·itemId로 호출. 승인 프로젝트 폴더(화이트리스트) 밖 문서는 열람되지 않는다. Excel(.xlsx)은 셀 값(최대 40행), 텍스트(.txt/.csv/.md/.json)는 본문(최대 8000자)을 반환하고, 그 외 형식(docx/pdf 등)은 메타데이터+링크만 반환한다(본문 추출 미지원).",
      parameters: { type: "object", properties: { driveId: { type: "string", description: "드라이브 ID(search 결과)" }, itemId: { type: "string", description: "항목 ID(search 결과)" } }, required: ["driveId", "itemId"] },
    },
  },
  /* ===== 사내규정 도구 2종 (REQ-0124 · 포털DB public.reg_* 사본 · 정본 SQL 103 · 전 직원) =====
     정본 서열: 그룹웨어 규정 게시판(원본·첨부는 NAS) > 포털DB 사본(규칙 파싱 조문). 결과마다 출처를 밝힌다.
     실험실(jeil-chat-lab)에는 _port_modules.py 가 이 정의와 runTool 분기를 그대로 옮긴다(도메인 regulation). */
  {
    type: "function",
    function: {
      name: "search_regulation",
      description: "사내규정(취업규칙·인사·복무·휴가·경비·출장·결재권한 등 전사 규정류) 조문 검색 — 그룹웨어 규정 게시판의 포털DB 사본에서 규정명·조문 제목·본문을 찾아 규정명·조문 번호·제목·발췌·시행일·원본 링크를 돌려준다. '연차 며칠', '출장비 기준', '결재 한도', '규정에 어떻게 돼 있어' 류 질의에 반드시 먼저 사용(일반론 답변 금지). 결과의 reg_key·article_no 로 get_regulation 을 부르면 조문 전문을 읽는다. 규정 질의에 OneDrive 문서 검색(search_my_documents)은 쓰지 않는다.",
      parameters: { type: "object", properties: { q: { type: "string", description: "검색어 — 핵심 낱말 1~3개(예: '연차', '출장 숙박비', '전결')" }, limit: { type: "integer", description: "최대 건수(기본 10, 최대 30)" } }, required: ["q"] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_regulation",
      description: "사내규정 1건의 조문 전문 또는 특정 조문 1개 읽기(포털DB 사본). reg(search_regulation 결과의 reg_key 또는 규정명 일부)로 찾고, article_no 를 주면 그 조문만, 없으면 목차 전체와 앞부분 조문을 돌려준다(길면 '다음조문' 값을 start 에 넣어 이어 읽는다). 답할 때 규정명·조문 번호(제n조)·시행일을 밝히고, 해석·개별 적용은 담당 부서(인사팀·총무팀) 확인을 안내한다.",
      parameters: { type: "object", properties: { reg: { type: "string", description: "reg_key(예: 'rules:취업규칙') 또는 규정명 일부(예: '취업규칙', '출장여비')" }, article_no: { type: "string", description: "조문 번호(예: '15', '15의2', '부칙-1'). 생략하면 목차+앞부분" }, start: { type: "integer", description: "이어 읽기 시작 조문 순번(이전 결과의 '다음조문')" } }, required: ["reg"] },
    },
  },
];

const STATUS_KO: Record<string, string> = { new: "신규", prod: "생산중", insp: "검사", done: "완료" };

// ERP 발주·구매요청 진행단계 코드(원천 po_sts/pr_sts) → 한글 해석. 진행순서: RQ→CF→PO→GR→IV
const ERP_STS_KO: Record<string, string> = {
  RQ: "요청", CF: "확정", PO: "발주완료(입고전)", GR: "입고완료", IV: "매입/송장완료",
};
const stsKo = (c: unknown): string => {
  const s = String(c ?? "").trim();
  return s ? (ERP_STS_KO[s] ? `${s}(${ERP_STS_KO[s]})` : s) : "-";
};

// Tool → 데이터 모듈 매핑 (부서별 erp_scope 강제용, dept_erp_scope와 동일 키)
// 포털(협력사 외주검사) 도구도 pur_order 권한으로 강제 — 발주번호·금액·납기가 담기므로 무권한 열람 금지.
const ERP_TOOL_MODULE: Record<string, string> = {
  get_erp_sales_monthly: "sales", get_erp_purchase_monthly: "purchase",
  get_erp_inventory_status: "inventory", get_erp_item: "item",
  get_erp_pur_order: "pur_order", get_erp_po_pr: "pur_order", get_erp_pur_top: "pur_order",
  get_erp_receipt_pending: "pur_order", get_erp_pur_req: "pur_order", get_erp_item_orders: "pur_order",
  get_order_summary: "pur_order", get_order_detail: "pur_order", get_inspection_pending: "pur_order",
  get_hr_payroll: "payroll",
  // get_hr_headcount 는 부분 허용(전사 총원=전 직원 / 부서별=payroll)이라 여기 매핑하지 않고 도구 내부에서 판정
};
// 모듈 키 → 한글 라벨 (접근제한 안내 문구용)
const MODULE_KO: Record<string, string> = {
  sales: "매출", purchase: "매입", inventory: "재고", item: "품목", pur_order: "발주·구매요청",
  payroll: "급여·인사", user_dept: "사용자·부서", finance: "자금·회계",
};

type PagePerm = { page_key: string; title: string; path: string; dept_nm: string | null; visibility: string; allowed: boolean; reason: string };
type ErpScope = {
  upn: string; isAdmin: boolean; modules: Set<string>; dept: string | null; empNm: string | null;
  depts: string[]; deptAdminOf: string[]; pages: PagePerm[]; grants: Record<string, unknown>[];
};
// 호출자 UPN → 유효 권한 판정. v2(2026-07-22): DB 통합 함수 public.perm_effective(SSOT) 호출로 일원화.
//   부서축(dept_erp_scope) + 개인 예외(perm_grant: 겸직부서·모듈 가감·기간 만료)가 여기 한 곳에서 계산된다.
// deno-lint-ignore no-explicit-any
async function resolveErpScope(admin: any, upn: string): Promise<ErpScope> {
  const { data: eff } = await admin.rpc("perm_effective", { p_upn: upn });
  const e = (eff || {}) as Record<string, unknown>;
  return {
    upn,
    isAdmin: !!e.is_admin,
    modules: new Set<string>((e.erp_modules as string[]) || []),
    dept: (e.dept_nm as string) ?? null,
    empNm: (e.emp_nm as string) ?? null,
    depts: (e.depts as string[]) || [],
    deptAdminOf: (e.dept_admin_of as string[]) || [],
    pages: (e.pages as PagePerm[]) || [],
    grants: (e.grants as Record<string, unknown>[]) || [],
  };
}
// 모듈 보유 여부(관리자는 전 모듈)
const hasModule = (s: ErpScope, m: string) => s.isAdmin || s.modules.has(m);

/* ===== P2 구조화 뷰(11_제품기획/10) — 도구 결과를 SSE 'jeilax' 이벤트로 프론트 카드에 직결(모델 미경유) =====
   뷰 5종 고정: series/ranking/record/list/notice. 도구별 신규 템플릿 신설 금지 — 데이터 "형태"로 추상화한다.
   각 도구 반환의 __view 는 모델 전달 전 제거되므로 토큰 비용 0. 구버전 프론트는 이벤트를 무시(하위호환).
   P3 액션(선택): actions?: [{kind:"link",label,url} | {kind:"ask",label,prompt}] — 카드당 최대 4개.
     link = 포털 내 pages/ 상대경로 또는 https 링크(프론트가 화이트리스트 검증).
     ask  = 클릭 시 해당 질문을 사용자가 챗봇에 보내는 것(후속질문·요청 "초안 작성"까지만 — 전송·승인 등 실거래 액션 금지, CLAUDE.md §1.6). */
type ViewPayload = Record<string, unknown> & { view: "series" | "ranking" | "record" | "list" | "notice" };
const comma = (n: number) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const won = (n: number) => comma(n) + "원";
// ERP 진행단계 → steps 뷰 인덱스(요청 RQ → 확정 CF → 발주 PO → 입고 GR → 매입 IV)
const STEP_IX: Record<string, number> = { RQ: 0, CF: 1, PO: 2, GR: 3, IV: 4 };
const STEP_LABELS = ["요청", "확정", "발주완료", "입고", "매입"];

/* ===== 사용자 표기 규약 — 아이디(사내 이메일)는 '부서_이름_아이디'로 표시 =====
   예: 총무팀_최동혁_dh.choi@jeilm.co.kr (v_erp_user_dept 매핑). 미매핑(퇴사자·시스템 계정)·비이메일 값은 원본 유지.
   표시용 변환일 뿐 — 감사 로그(chat_log·hr_access_log)의 원본 upn은 바꾸지 않는다. */
// deno-lint-ignore no-explicit-any
async function userLabelMap(admin: any, ids: unknown[]): Promise<Map<string, string>> {
  const uniq = [...new Set(ids.map((s) => String(s || "").trim().toLowerCase()).filter((s) => s.includes("@")))];
  if (!uniq.length) return new Map();
  const { data } = await admin.from("v_erp_user_dept").select("email,dept_nm,emp_nm").in("email", uniq);
  const m = new Map<string, string>();
  // deno-lint-ignore no-explicit-any
  for (const r of (data || []) as any[]) {
    const e = String(r.email || "").toLowerCase();
    if (e && r.emp_nm) m.set(e, `${r.dept_nm || "미매핑"}_${r.emp_nm}_${e}`);
  }
  return m;
}
const userLbl = (m: Map<string, string>, id: unknown): string | null => {
  const s = String(id || "").trim();
  return s ? (m.get(s.toLowerCase()) || s) : null;
};

const TOOLS_JSON_LEN = JSON.stringify(TOOLS).length;   // 점검 비용 상한 추정용(REQ-0095)

/* ===== 사용모델 설정 로드·라우팅 (SSOT: ai_gateway_config / ai_model / ai_routing_rule) =====
   원칙: 조회 실패·미설정이면 기존 하드코딩 기본값으로 안전 폴백 → 설정이 비어도 챗봇은 정상 동작한다. */
type AiModelRow = { model_id: string; vendor: string; active: boolean; callable: boolean; price_in: number; price_out: number };
type AiRuleRow = { seq: number; rule_type: string; match_keywords: string[] | null; min_chars: number | null; model_id: string; active: boolean };
type AiConfig = {
  default_model: string; max_tokens: number; temperature: number;
  max_messages: number; max_total_chars: number; system_prompt: string;
  // work 컨텍스트 적용범위·대화 저장 정책(관리자 콘솔 설정)
  work_context_mode: string; work_context_max_chars: number; work_history_turns: number;
  chat_save_enabled: boolean; chat_retention_days: number; session_max_messages: number;
  models: AiModelRow[]; rules: AiRuleRow[];
};

function fallbackConfig(): AiConfig {
  return {
    default_model: Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini",
    max_tokens: MAX_TOKENS, temperature: DEFAULT_TEMP,
    max_messages: MAX_MESSAGES, max_total_chars: MAX_TOTAL_CHARS,
    system_prompt: SYSTEM_PROMPT,
    work_context_mode: "memo", work_context_max_chars: 2000, work_history_turns: 10,
    chat_save_enabled: true, chat_retention_days: 180, session_max_messages: 400,
    models: [], rules: [],
  };
}

// deno-lint-ignore no-explicit-any
async function loadAiConfig(admin: any): Promise<AiConfig> {
  try {
    const [cfgR, modR, rulR, shpR] = await Promise.all([
      admin.from("ai_gateway_config").select("*").eq("id", 1).maybeSingle(),
      admin.from("ai_model").select("model_id,vendor,active,callable,price_in,price_out"),
      admin.from("ai_routing_rule").select("seq,rule_type,match_keywords,min_chars,model_id,active").eq("active", true).order("seq"),
      // REQ-0095: 점검이 기록한 요청 모양으로 콜드스타트 재학습을 줄인다. 별도 select 라 SQL 80 전이면 error 만 나고 위 3개는 무관.
      admin.from("ai_model").select("model_id,request_shape").not("request_shape", "is", null),
    ]);
    if (modR.error) console.error("ai_model 조회 실패 — 기본 모델이 env OPENAI_MODEL 로 조용히 떨어진다:", modR.error.message);
    if (!shpR.error) {
      for (const r of ((shpR.data || []) as { model_id: string; request_shape: unknown }[])) {
        const sh = sanitizeShape(r.request_shape);
        if (sh && !OA_SHAPE.has(r.model_id)) OA_SHAPE.set(r.model_id, sh);   // 메모리 학습이 있으면 DB 로 덮지 않는다
      }
    }
    const c = cfgR.data;
    if (!c) return fallbackConfig();
    return {
      default_model: c.default_model || fallbackConfig().default_model,
      max_tokens: Number(c.max_tokens) || MAX_TOKENS,
      temperature: c.temperature != null ? Number(c.temperature) : DEFAULT_TEMP,
      max_messages: Number(c.max_messages) || MAX_MESSAGES,
      max_total_chars: Number(c.max_total_chars) || MAX_TOTAL_CHARS,
      system_prompt: c.system_prompt || SYSTEM_PROMPT,
      work_context_mode: ["off", "memo", "memo_summary"].includes(String(c.work_context_mode)) ? String(c.work_context_mode) : "memo",
      work_context_max_chars: Number(c.work_context_max_chars) > 0 ? Number(c.work_context_max_chars) : 2000,
      work_history_turns: Number(c.work_history_turns) > 0 ? Number(c.work_history_turns) : 10,
      chat_save_enabled: c.chat_save_enabled !== false,
      chat_retention_days: Number.isFinite(Number(c.chat_retention_days)) ? Number(c.chat_retention_days) : 180,
      session_max_messages: Number(c.session_max_messages) || 400,
      models: (modR.data as AiModelRow[]) || [],
      rules: (rulR.data as AiRuleRow[]) || [],
    };
  } catch {
    return fallbackConfig();
  }
}

// 실제 호출 가능한(active+callable+OpenAI) 모델 맵
function usableModels(ai: AiConfig): Map<string, AiModelRow> {
  return new Map(
    ai.models.filter((m) => m.active && m.callable && String(m.vendor).toLowerCase() === "openai")
      .map((m) => [m.model_id, m]),
  );
}

// 라우팅: keyword_length 규칙만 실제 적용(대상 모델이 usable일 때). 미매칭이면 기본 모델(usable 검증·폴백).
function pickModel(userText: string, ai: AiConfig): string {
  const usable = usableModels(ai);
  const envModel = Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini";
  const safeDefault = usable.has(ai.default_model)
    ? ai.default_model
    : (usable.size ? [...usable.keys()][0] : envModel);
  const text = String(userText || "");
  for (const rule of ai.rules) {
    if (rule.rule_type !== "keyword_length") continue;            // 게이트웨이 실제 적용 유형만
    const kwHit = (rule.match_keywords || []).some((k) => k && text.includes(k));
    const lenHit = rule.min_chars != null && rule.min_chars > 0 && text.length >= rule.min_chars;
    if ((kwHit || lenHit) && usable.has(rule.model_id)) return rule.model_id;
  }
  return safeDefault;
}

// 단가 조회: DB ai_model 우선 → 폴백 PRICES 표
function priceFor(model: string, ai: AiConfig): { inp: number; out: number } {
  const m = ai.models.find((x) => x.model_id === model);
  if (m && (m.price_in || m.price_out)) return { inp: Number(m.price_in), out: Number(m.price_out) };
  return PRICES[model] || PRICES["gpt-4o-mini"];
}

// ===== Microsoft Graph 호출(사용자 위임 토큰) — 문서 도구 전용. 보안 트리밍은 Graph가 처리 =====
async function graphGet(userToken: string, url: string): Promise<Record<string, unknown>> {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${userToken}` } });
  if (!r.ok) throw new Error(`Graph ${r.status}`);
  return await r.json();
}
async function graphSearchDocs(userToken: string, q: string, size: number): Promise<Record<string, unknown>> {
  const r = await fetch("https://graph.microsoft.com/v1.0/search/query", {
    method: "POST",
    headers: { Authorization: `Bearer ${userToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests: [{ entityTypes: ["driveItem"], query: { queryString: q }, from: 0, size }] }),
  });
  if (!r.ok) throw new Error(`Graph search ${r.status}`);
  return await r.json();
}

// ===== AI 문서 연계 화이트리스트 로드 (SSOT: ai_document_scope, 02_MS연동 §8) =====
// 승인 범위를 site/library/folder 3단계로 지정: 각 범위는 driveId + pathPrefix(폴더/라이브러리/사이트 웹URL)로 구성.
// 조회실패·빈 목록이면 null → 문서 도구는 fail-closed(검색·판독 비활성). 사용자 권한 트리밍은 Graph가 별도 처리(이중 게이트).
type DocScope = { driveId: string; pathPrefix: string; webUrl: string };
// URL 접두 비교용 정규화(퍼센트 디코드 + 소문자) — Graph webUrl 인코딩 편차 흡수
function normUrl(u: string): string {
  try { return decodeURIComponent(String(u || "")).toLowerCase(); } catch { return String(u || "").toLowerCase(); }
}
// deno-lint-ignore no-explicit-any
async function loadDocScope(admin: any): Promise<DocScope[] | null> {
  try {
    const { data, error } = await admin.from("ai_document_scope")
      .select("drive_id, web_url, path_prefix").eq("active", true);
    if (error || !Array.isArray(data) || data.length === 0) return null;
    // deno-lint-ignore no-explicit-any
    const scopes: DocScope[] = data.map((r: any) => ({
      driveId: String(r.drive_id || ""),
      pathPrefix: normUrl(String(r.path_prefix || r.web_url || "")),
      webUrl: String(r.web_url || ""),
    })).filter((s: DocScope) => s.driveId && s.pathPrefix);
    return scopes.length ? scopes : null;
  } catch { return null; }
}
// hit(driveId,webUrl)이 승인 범위 안인지 — driveId 일치 AND 경로가 승인 접두로 시작(폴더 레벨 강제)
function inScope(scopes: DocScope[], driveId: string, webUrl: string): boolean {
  const du = String(driveId || "");
  const wu = normUrl(webUrl);
  return scopes.some((s) => s.driveId === du && (!s.pathPrefix || wu.startsWith(s.pathPrefix)));
}

/* ===== 적재범위 레지스트리(erp_load_scope) — "무엇이 어디까지 적재됐나"의 단일 출처 =====
   설계 11 §16. 결측 배지 문구를 코드 상수로 들고 있으면 문구 하나 바꾸는 데도 재배포가 필요하고
   같은 사실이 프롬프트·도구설명·카드각주에 복제돼 어긋난다. 여기서는 표만 읽는다.
   조회 실패는 빈 배열 → 배지가 사라질 뿐 조회 자체는 정상 동작(부가 정보이므로 fail-soft). */
type ScopeRow = { field_key: string; label_ko: string; state: string; gap_label: string | null; gap_why: string | null; fix_type: string | null };
// deno-lint-ignore no-explicit-any
async function loadLoadScope(admin: any, mod: string): Promise<ScopeRow[]> {
  try {
    const { data } = await admin.from("erp_load_scope")
      .select("field_key,label_ko,state,gap_label,gap_why,fix_type").eq("module", mod);
    return (data || []) as ScopeRow[];
  } catch { return []; }
}
// 해당 항목이 '미해결(loaded 아님)'이면 그 행을, 아니면 null
const gapOf = (rows: ScopeRow[], key: string): ScopeRow | null =>
  rows.find((r) => r.field_key === key && r.state !== "loaded") || null;
// 결측 행들 → 카드 필드에 얹을 배지 속성
const gapAttr = (g: ScopeRow | null) => (g ? { gap: g.gap_label || "미연계", gap_why: g.gap_why || "", fix_type: g.fix_type || "" } : {});

// deno-lint-ignore no-explicit-any
async function runTool(admin: any, name: string, argsJson: string, scope: ErpScope, userToken: string): Promise<unknown> {
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(argsJson || "{}"); } catch { /* 빈 인자 */ }
  const asOf = new Date().toISOString();

  // ERP 데이터 도구는 소속 부서 erp_scope로 강제(관리자 예외). 범위 밖이면 데이터 대신 안내 반환.
  const erpMod = ERP_TOOL_MODULE[name];
  if (erpMod && !scope.isAdmin && !scope.modules.has(erpMod)) {
    const modKo = MODULE_KO[erpMod] || erpMod;
    const dept = scope.dept || "소속 부서";
    const 안내 = `요청하신 ERP '${modKo}' 데이터는 회원님 소속 부서(${dept})에 아직 열람 권한이 없습니다. 열람이 필요하시면 포털 관리자에게 '${dept}의 ${modKo}(${erpMod}) ERP 모듈 권한'을 요청해 주세요. (관리자 콘솔 › 사용자·부서 › 부서별 ERP 모듈 권한에서 부여)`;
    return {
      접근제한: true, 요청안내: true, 모듈: erpMod, 부서: scope.dept || "미지정", 안내,
      // notice 뷰 — 서버 안내 문구를 그대로 카드 표시(전 게이트 도구 공통 1곳)
      __view: { view: "notice", title: "데이터 접근 권한 안내", kind: "deny", text: 안내,
        request: { ui: "perm", kind: "perm", module: erpMod, moduleKo: modKo, dept },
        actions: [{ kind: "ask", label: "권한 요청 초안 작성",
          prompt: `포털 관리자에게 보낼 '${dept}의 ${modKo}(${erpMod}) ERP 모듈 권한' 요청 메시지 초안을 사내 메신저용으로 간결하게 작성해줘. 요청 사유 한 줄을 포함하고, 내가 복사해서 직접 보낼 수 있는 형태로.` }] } satisfies ViewPayload,
    };
  }

  if (name === "get_order_summary") {
    const [{ data: heads }, { data: states }] = await Promise.all([
      admin.from("sp_order_header").select("po_no,vendor_name,due_date,amt"),
      admin.from("sp_order_state").select("po_no,status,step"),
    ]);
    const st: Record<string, { status: string; step: number }> = {};
    (states || []).forEach((s: { po_no: string; status: string; step: number }) => (st[s.po_no] = s));
    const byStatus: Record<string, number> = {};
    let totalAmt = 0;
    const vendors = new Set<string>();
    const dueSoon: unknown[] = [];
    const in7 = Date.now() + 7 * 86400000;
    for (const h of heads || []) {
      const s = st[h.po_no]?.status || "new";
      byStatus[STATUS_KO[s] || s] = (byStatus[STATUS_KO[s] || s] || 0) + 1;
      totalAmt += Number(h.amt || 0);
      vendors.add(h.vendor_name || "");
      if (s !== "done" && h.due_date && new Date(h.due_date).getTime() <= in7) {
        dueSoon.push({ 발주번호: h.po_no, 협력사: h.vendor_name, 납기: h.due_date, 상태: STATUS_KO[s] || s });
      }
    }
    return { 기준시각: asOf, 총발주: (heads || []).length, 상태별건수: byStatus, 총발주금액_원: totalAmt, 협력사수: vendors.size, 납기7일내_미완료: dueSoon,
      __view: { view: "record", title: "협력사 외주검사 발주 현황", asOf,
        fields: [
          { k: "총 발주", v: `${(heads || []).length}건` },
          { k: "총 발주금액", v: won(totalAmt) },
          { k: "협력사", v: `${vendors.size}곳` },
          { k: "납기 7일내 미완료", v: `${dueSoon.length}건` },
          ...Object.entries(byStatus).map(([k, v]) => ({ k: `상태 · ${k}`, v: `${v}건` })),
        ] } satisfies ViewPayload };
  }

  if (name === "get_order_detail") {
    const po = String(args.po_no || "").trim();
    if (!po) return { 오류: "po_no가 필요합니다." };
    const [{ data: h }, { data: s }, { data: insp }, { data: reqs }, { data: photos }, { data: msgs }] = await Promise.all([
      admin.from("sp_order_header").select("*").eq("po_no", po).maybeSingle(),
      admin.from("sp_order_state").select("status,step,updated_at").eq("po_no", po).maybeSingle(),
      admin.from("sp_inspection").select("result,judge_id,opinion,judged_at").eq("po_no", po).maybeSingle(),
      admin.from("sp_insp_request").select("insp_req_no,requested_at").eq("po_no", po).eq("cancelled", false),
      admin.from("sp_photo").select("id").eq("po_no", po),
      admin.from("sp_message").select("id").eq("po_no", po),
    ]);
    if (!h) return { 기준시각: asOf, 오류: `발주번호 ${po} 는 협력사 외주검사 포털에 없습니다.`, 안내: "ERP 구매발주(PO…)일 수 있습니다. get_erp_po_pr 도구로 다시 조회하세요.", 재시도도구: "get_erp_po_pr", 재시도인자: { po_no: po } };
    return {
      기준시각: asOf, 발주번호: h.po_no, 협력사: h.vendor_name, 발주일: h.order_date, 납기: h.due_date,
      금액_원: Number(h.amt || 0), 품목수: Array.isArray(h.items) ? h.items.length : 0,
      상태: STATUS_KO[s?.status || ""] || s?.status || "미확인", 진행단계_10: s?.step ?? null,
      검사결과: insp ? { 판정: insp.result, 판정자: insp.judge_id, 의견: insp.opinion, 판정일: insp.judged_at } : "판정 전",
      검수요청건수: (reqs || []).length, 사진건수: (photos || []).length, 메시지건수: (msgs || []).length,
      __view: { view: "record", title: `외주검사 발주 ${h.po_no}`, asOf,
        fields: [
          { k: "협력사", v: String(h.vendor_name || "-") },
          { k: "발주일 / 납기", v: `${h.order_date || "-"} / ${h.due_date || "-"}` },
          { k: "금액", v: won(Number(h.amt || 0)) },
          { k: "품목수", v: `${Array.isArray(h.items) ? h.items.length : 0}종` },
          { k: "상태", v: `${STATUS_KO[s?.status || ""] || s?.status || "미확인"}${s?.step != null ? ` (${s.step}/10단계)` : ""}` },
          { k: "검사결과", v: insp ? `${insp.result}${insp.judged_at ? ` · ${String(insp.judged_at).slice(0, 10)}` : ""}` : "판정 전" },
          { k: "검수요청/사진/메시지", v: `${(reqs || []).length}건 / ${(photos || []).length}장 / ${(msgs || []).length}건` },
        ] } satisfies ViewPayload,
    };
  }

  if (name === "get_inspection_pending") {
    const [{ data: reqs }, { data: insps }, { data: heads }] = await Promise.all([
      admin.from("sp_insp_request").select("po_no,insp_req_no,requested_at").eq("cancelled", false),
      admin.from("sp_inspection").select("po_no"),
      admin.from("sp_order_header").select("po_no,vendor_name,due_date"),
    ]);
    const judged = new Set((insps || []).map((r: { po_no: string }) => r.po_no));
    const hm: Record<string, { vendor_name: string; due_date: string }> = {};
    (heads || []).forEach((h: { po_no: string; vendor_name: string; due_date: string }) => (hm[h.po_no] = h));
    const seen = new Set<string>();
    const pending = (reqs || [])
      .filter((r: { po_no: string }) => !judged.has(r.po_no) && !seen.has(r.po_no) && seen.add(r.po_no))
      .map((r: { po_no: string; insp_req_no: string; requested_at: string }) => ({
        발주번호: r.po_no, 협력사: hm[r.po_no]?.vendor_name || "-", 납기: hm[r.po_no]?.due_date || "-",
        검수요청번호: r.insp_req_no, 요청일시: r.requested_at,
      }));
    return { 기준시각: asOf, 판정대기건수: pending.length, 목록: pending,
      __view: { view: "list", title: `검사 판정 대기 ${pending.length}건`, asOf,
        columns: [
          { key: "발주번호", label: "발주번호" }, { key: "협력사", label: "협력사" },
          { key: "납기", label: "납기" }, { key: "요청일시", label: "검수요청일시" },
        ], rows: pending.slice(0, 30) } satisfies ViewPayload };
  }

  /* ===== 2단계 ERP 중간DB 도구 (public.v_erp_* 뷰, service_role 조회 · 사내 실데이터) ===== */
  if (name === "get_erp_sales_monthly") {
    const { data } = await admin.from("v_erp_sales_monthly").select("*").order("ym", { ascending: false });
    const rows = data || [];
    let amt = 0, cnt = 0;
    const byBp: Record<string, { name: string; amt: number }> = {};
    const byMo: Record<string, { amt: number; cnt: number; bps: Set<string> }> = {};
    for (const r of rows) {
      amt += Number(r.sales_amt || 0); cnt += Number(r.order_cnt || 0);
      const b = (byBp[r.bp_code] = byBp[r.bp_code] || { name: r.bp_name || r.bp_code, amt: 0 });
      b.amt += Number(r.sales_amt || 0);
      const m = (byMo[r.ym] = byMo[r.ym] || { amt: 0, cnt: 0, bps: new Set() });
      m.amt += Number(r.sales_amt || 0); m.cnt += Number(r.order_cnt || 0); m.bps.add(r.bp_code);
    }
    const top = Object.values(byBp).sort((a, b) => b.amt - a.amt).slice(0, 10);
    const 월별 = Object.keys(byMo).sort().map((ym) => ({ 월: ym, 매출액_원: byMo[ym].amt, 건수: byMo[ym].cnt, 거래처수: byMo[ym].bps.size }));
    return { 기준시각: asOf, 월별, 매출액합계_원: amt, 매출건수: cnt, 거래처수: Object.keys(byBp).length,
      거래처Top10: top.map((t) => ({ 거래처: t.name, 매출액_원: t.amt })),
      안내: "ERP 중간DB 파일럿(유니포인트 매핑 확정 전). 월별 값은 각 월 실적재분이며, 미마감 최근월은 값이 작을 수 있음.",
      __view: { view: "series", title: "월별 매출액(전사)", unit: "원", asOf,
        rows: 월별.slice(-24).map((m) => ({ k: m.월, v: m.매출액_원 })),
        note: "ERP 중간DB 파일럿 · 미마감 최근월은 값이 작을 수 있음" } satisfies ViewPayload };
  }

  if (name === "get_erp_purchase_monthly") {
    const { data } = await admin.from("v_erp_purchase_monthly").select("*").order("ym", { ascending: false });
    const rows = data || [];
    let amt = 0, cnt = 0;
    const byBp: Record<string, { name: string; amt: number; cnt: number }> = {};
    const byMo: Record<string, { amt: number; cnt: number; bps: Set<string> }> = {};
    for (const r of rows) {
      amt += Number(r.purchase_amt || 0); cnt += Number(r.iv_cnt || 0);
      const b = (byBp[r.bp_code] = byBp[r.bp_code] || { name: r.bp_name || r.bp_code, amt: 0, cnt: 0 });
      b.amt += Number(r.purchase_amt || 0); b.cnt += Number(r.iv_cnt || 0);
      const m = (byMo[r.ym] = byMo[r.ym] || { amt: 0, cnt: 0, bps: new Set() });
      m.amt += Number(r.purchase_amt || 0); m.cnt += Number(r.iv_cnt || 0); m.bps.add(r.bp_code);
    }
    const top = Object.values(byBp).sort((a, b) => b.amt - a.amt).slice(0, 10);
    const 월별 = Object.keys(byMo).sort().map((ym) => ({ 월: ym, 매입액_원: byMo[ym].amt, 전표건수: byMo[ym].cnt, 거래처수: byMo[ym].bps.size }));
    // 거래처·월 필터(선택) — Top10 밖 거래처/특정 월 매입 조회
    const bpKw = String(args.bp || "").replace(/[,()*%]/g, "").trim();
    const ymF = String(args.ym || "").replace(/[^0-9-]/g, "").slice(0, 7);
    let 필터결과: unknown = null;
    if (bpKw || /^\d{4}-\d{2}$/.test(ymF)) {
      const f = rows.filter((r: Record<string, unknown>) =>
        (!bpKw || String(r.bp_name || "").includes(bpKw) || String(r.bp_code || "") === bpKw) &&
        (!/^\d{4}-\d{2}$/.test(ymF) || r.ym === ymF));
      let famt = 0; for (const r of f) famt += Number(r.purchase_amt || 0);
      필터결과 = { 조건: { 거래처: bpKw || null, 월: ymF || null }, 건수: f.length, 매입액합계_원: famt,
        목록: f.map((r: Record<string, unknown>) => ({ 월: r.ym, 거래처: r.bp_name || r.bp_code, 매입액_원: Number(r.purchase_amt || 0), 전표건수: Number(r.iv_cnt || 0) })) };
    }
    // 뷰: 거래처·월 필터 조회면 그 목록(list), 아니면 월별 추이(series)
    const purView: ViewPayload = 필터결과
      ? { view: "list", title: `매입 조회${bpKw ? " — " + bpKw : ""}${/^\d{4}-\d{2}$/.test(ymF) ? " " + ymF : ""}`, asOf,
          columns: [
            { key: "월", label: "월" }, { key: "거래처", label: "거래처" },
            { key: "매입액_원", label: "매입액(원)", num: true }, { key: "전표건수", label: "전표", num: true },
          ],
          // deno-lint-ignore no-explicit-any
          rows: ((필터결과 as any).목록 || []).slice(0, 30), note: "송장(M_IV) 기준" }
      : { view: "series", title: "월별 매입액(전사)", unit: "원", asOf,
          rows: 월별.slice(-24).map((m) => ({ k: m.월, v: m.매입액_원 })),
          note: "송장(M_IV) 기준 · 미마감 최근월은 값이 작을 수 있음" };
    return { 기준시각: asOf, 월별, 매입액합계_원: amt, 전표건수: cnt, 거래처수: Object.keys(byBp).length,
      거래처Top10: top.map((t) => ({ 거래처: t.name, 매입액_원: t.amt, 전표건수: t.cnt })), 필터결과,
      안내: "ERP 중간DB 매입(송장 M_IV 기준) 파일럿. 월별 값은 각 월 실적재분이며, 미마감 최근월은 값이 작을 수 있음. 발주 상태 IV와는 별개 집계.",
      __view: purView };
  }

  if (name === "get_erp_inventory_status") {
    const code = String(args.item_code || "").replace(/[,()*%]/g, "").trim();
    let q = admin.from("v_erp_inventory_daily").select("*").order("ymd", { ascending: false }).limit(2000);
    if (code) q = q.eq("item_code", code);
    const { data } = await q; const rows = data || [];
    let inq = 0, outq = 0; const items = new Set<string>();
    for (const r of rows) { inq += Number(r.in_qty || 0); outq += Number(r.out_qty || 0); items.add(r.item_code); }
    return { 기준시각: asOf, 대상: code || "전체(최근31일)", 품목수: items.size, 입고합계: inq, 출고합계: outq, 표본행수: rows.length,
      데이터주의: "현재 중간DB 재고는 출고만 유효하며 입고량·재고량은 미적재(0/미표기)입니다 — '입고 0/재고 없음'을 실적으로 단정하지 말 것. 특정 발주의 입고 여부는 get_erp_po_pr(입고수량)로 확인.",
      안내: "ERP 중간DB 재고 일집계 파일럿(입출고 분류는 협의 전 초안, 수집범위 일부 품목·약 1개월)",
      __view: await (async () => {
        // 결측 배지는 레지스트리에서 온다(§16) — 코드 상수 제거. 적재가 끝나 state=loaded 가 되면 배지가 자동으로 사라진다.
        const sc = await loadLoadScope(admin, "inventory");
        const gIn = gapOf(sc, "in_qty"), gStock = gapOf(sc, "stock_qty");
        const gaps = [gIn, gStock].filter(Boolean) as ScopeRow[];
        const fixes = [...new Set(gaps.map((g) => g.fix_type).filter(Boolean))].join(",");
        return { view: "record", title: `재고 입출고 — ${code || "전체(최근 31일)"}`, asOf,
          fields: [
            { k: "품목수", v: comma(items.size) },
            { k: "출고합계", v: comma(outq) },
            { k: "입고합계", v: comma(inq), ...gapAttr(gIn) },
            ...(gStock ? [{ k: "재고합계", v: "-", ...gapAttr(gStock) }] : []),
            { k: "표본행수", v: comma(rows.length) },
          ],
          // 데이터 적용요청(2분류 중 '데이터' 축) — 결측이 있을 때만 붙인다.
          ...(gaps.length ? { request: { ui: "data", kind: "data", module: "inventory", moduleKo: "재고",
            dept: scope.dept || "미지정",
            gap: { type: "field", detail: gaps.map((g) => g.label_ko).join("·"), fix_type: fixes } } } : {}),
          note: gaps.length ? `${gaps.map((g) => g.label_ko).join("·")}은 중간DB 미적재 — 실적으로 단정 금지` : undefined,
        } satisfies ViewPayload;
      })() };
  }

  if (name === "get_erp_item") {
    const kw = String(args.keyword || "").replace(/[,()*%]/g, "").trim();
    if (!kw) return { 오류: "keyword가 필요합니다." };
    const { data } = await admin.from("v_erp_item")
      .select("item_code,item_name,spec,unit,item_class,use_yn")
      .or(`item_code.ilike.%${kw}%,item_name.ilike.%${kw}%`).limit(30);
    const rows = data || [];
    // deno-lint-ignore no-explicit-any
    const 목록 = rows.map((r: any) => ({ 품목코드: r.item_code, 품목명: r.item_name, 규격: r.spec, 단위: r.unit, 분류: r.item_class, 사용: r.use_yn, 사용금지: /사용\s*금지/.test(String(r.item_name || "")) }))
      .sort((a: { 사용금지: boolean }, b: { 사용금지: boolean }) => (a.사용금지 ? 1 : 0) - (b.사용금지 ? 1 : 0));
    return { 기준시각: asOf, 검색어: kw, 건수: 목록.length, 목록,
      안내: "품목명에 '사용금지' 표기가 있는 코드는 신규 발주용으로 제시 금지(대체코드 확인 안내).",
      __view: { view: "list", title: `품목 검색 — "${kw}" (${목록.length}건)`, asOf,
        columns: [
          { key: "품목코드", label: "품목코드" }, { key: "품목명", label: "품목명" },
          { key: "규격", label: "규격" }, { key: "단위", label: "단위" }, { key: "금지", label: "" },
        ],
        // deno-lint-ignore no-explicit-any
        rows: 목록.slice(0, 30).map((r: any) => ({ 품목코드: r.품목코드, 품목명: r.품목명, 규격: r.규격 || "", 단위: r.단위 || "", 금지: r.사용금지 ? "⚠ 사용금지" : "" })),
        note: "사용금지 품목은 신규 발주 제시 금지" } satisfies ViewPayload };
  }

  if (name === "get_erp_pur_order") {
    const ym = String(args.ym || "").replace(/[^0-9-]/g, "").slice(0, 7);
    const { data: mrows } = await admin.from("v_erp_pur_order_monthly").select("*").order("ym");
    const 월별 = (mrows || []).map((r: Record<string, unknown>) => ({
      월: r.ym, 발주건수: Number(r.po_cnt || 0), 품목라인: Number(r.line_cnt || 0),
      거래처수: Number(r.bp_cnt || 0), 발주금액_원: Number(r.amt || 0),
    }));
    let 상세: unknown = null;
    if (/^\d{4}-\d{2}$/.test(ym)) {
      const [y, m] = ym.split("-").map(Number);
      const nm = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
      const { data } = await admin.from("v_erp_pur_order")
        .select("po_no,bp_name,po_amt,po_sts").gte("po_dt", ym + "-01").lt("po_dt", nm + "-01").limit(3000);
      const rows = data || [];
      const byBp: Record<string, number> = {}; const bySts: Record<string, { 건수: number; 금액_원: number }> = {};
      const pos = new Set<string>(); let amt = 0;
      for (const r of rows) {
        pos.add(r.po_no); amt += Number(r.po_amt || 0);
        const nmk = r.bp_name || r.po_no; byBp[nmk] = (byBp[nmk] || 0) + Number(r.po_amt || 0);
        const s = stsKo(r.po_sts); const e = (bySts[s] = bySts[s] || { 건수: 0, 금액_원: 0 });
        e.건수 += 1; e.금액_원 += Number(r.po_amt || 0);
      }
      const top = Object.entries(byBp).sort((a, b) => b[1] - a[1]).slice(0, 10)
        .map(([거래처, 금액]) => ({ 거래처, 발주금액_원: 금액 }));
      상세 = { 월: ym, 발주건수: pos.size, 품목라인: rows.length, 발주금액_원: amt, 거래처Top10: top, 상태분포_금액: bySts };
    }
    // 뷰: 특정 월 상세 조회면 거래처 Top10(ranking), 아니면 월별 추이(series)
    // deno-lint-ignore no-explicit-any
    const d상세 = 상세 as any;
    const poView: ViewPayload = d상세
      ? { view: "ranking", title: `${ym} 거래처별 발주금액 Top10`, unit: "원", asOf,
          rows: (d상세.거래처Top10 || []).map((t: Record<string, unknown>, i: number) => ({ rank: i + 1, label: String(t.거래처), v: Number(t.발주금액_원 || 0) })),
          note: `${ym} 발주 ${comma(Number(d상세.발주건수 || 0))}건 · 총 ${won(Number(d상세.발주금액_원 || 0))}` }
      : { view: "series", title: "월별 발주금액(전사)", unit: "원", asOf,
          rows: 월별.slice(-24).map((m: Record<string, unknown>) => ({ k: String(m.월), v: Number(m.발주금액_원 || 0) })),
          note: "발주건수는 고유 발주번호 기준 · 파일럿" };
    return { 기준시각: asOf, 월별, 상세, 안내: "ERP 중간DB 구매발주(pur_order_s, 2026 전체). 발주건수=고유 발주번호 기준. 파일럿 데이터.",
      __view: poView };
  }

  // 품목코드/품목명 → 그 품목의 구매요청·발주·매입 이력(요청→발주→입고→매입 추적).
  // 배경: 품목코드로 발주/구매요청을 조회하는 경로가 없어 챗봇이 '없음'·발주번호 오인으로 답하던 이슈 해소.
  if (name === "get_erp_item_orders") {
    const raw = String(args.item || "").trim();
    const key = raw.replace(/[,()*%]/g, "").trim();
    if (!key) return { 오류: "item(품목코드 또는 품목명)이 필요합니다." };
    // 1) 품목 확정: 정확 코드 매칭 우선, 없으면 코드/명 부분일치로 후보 조회
    const { data: exact } = await admin.from("v_erp_item").select("item_code,item_name,spec,unit,use_yn").eq("item_code", key).limit(1);
    let items = exact || [];
    if (!items.length) {
      const { data: cand } = await admin.from("v_erp_item").select("item_code,item_name,spec,unit,use_yn")
        .or(`item_code.ilike.%${key}%,item_name.ilike.%${key}%`).limit(10);
      items = cand || [];
    }
    if (!items.length) {
      return { 기준시각: asOf, 검색어: raw, 건수: 0, 안내: `"${raw}"에 해당하는 품목을 찾지 못했습니다. 품목코드·품목명을 확인하세요(중간DB는 2026년 기준).` };
    }
    // 후보가 여러 개면(부분일치) 목록만 안내 — 어느 품목인지 사용자 확인
    if (items.length > 1) {
      // deno-lint-ignore no-explicit-any
      const 후보 = items.map((r: any) => ({ 품목코드: r.item_code, 품목명: r.item_name, 규격: r.spec, 단위: r.unit }));
      return { 기준시각: asOf, 검색어: raw, 후보건수: 후보.length, 후보, 안내: "여러 품목이 검색됐습니다. 어느 품목인지 품목코드로 다시 알려주세요.",
        __view: { view: "list", title: `품목 후보 — "${raw}" (${후보.length}건)`, asOf,
          columns: [{ key: "품목코드", label: "품목코드" }, { key: "품목명", label: "품목명" }, { key: "규격", label: "규격" }, { key: "단위", label: "단위" }],
          rows: 후보, note: "품목코드를 지정해 다시 조회하세요" } satisfies ViewPayload };
    }
    const it = items[0] as Record<string, unknown>;
    const code = String(it.item_code);
    // 2) 확정 품목코드로 구매요청·발주·매입 조회(각 최신순)
    const [reqR, ordR, ivR] = await Promise.all([
      admin.from("v_erp_pur_req").select("pr_no,req_dt,req_qty,ord_qty,rcpt_qty,iv_qty,pr_sts,req_dept_resolved,req_prsn,sppl_name").eq("item_code", code).order("req_dt", { ascending: false }).limit(50),
      admin.from("v_erp_pur_order").select("po_no,po_dt,bp_name,po_qty,po_amt,po_sts,rcpt_qty,pr_no,dlvy_dt").eq("item_code", code).order("po_dt", { ascending: false }).limit(50),
      admin.from("v_erp_iv_dtl").select("iv_no,iv_dt,bp_name,iv_qty,iv_loc_amt,po_no").eq("item_code", code).order("iv_dt", { ascending: false }).limit(50),
    ]);
    const uMap = await userLabelMap(admin, (reqR.data || []).map((r: Record<string, unknown>) => r.req_prsn));
    // deno-lint-ignore no-explicit-any
    const 구매요청 = (reqR.data || []).map((r: any) => ({ 구매요청번호: r.pr_no, 요청일: r.req_dt, 요청수량: Number(r.req_qty || 0), 발주수량: Number(r.ord_qty || 0), 요청부서: r.req_dept_resolved || "", 요청자: userLbl(uMap, r.req_prsn), 진행: stsKo(r.pr_sts) }));
    // deno-lint-ignore no-explicit-any
    const 발주 = (ordR.data || []).map((r: any) => ({ 발주번호: r.po_no, 발주일: r.po_dt, 거래처: r.bp_name || "", 발주수량: Number(r.po_qty || 0), 발주금액_원: Number(r.po_amt || 0), 입고수량: Number(r.rcpt_qty || 0), 진행: stsKo(r.po_sts), 연결_구매요청: r.pr_no || null }));
    // deno-lint-ignore no-explicit-any
    const 매입 = (ivR.data || []).map((r: any) => ({ 매입번호: r.iv_no, 매입일: r.iv_dt, 거래처: r.bp_name || "", 매입수량: Number(r.iv_qty || 0), 매입금액_원: Number(r.iv_loc_amt || 0), 연결_발주: r.po_no || null }));
    const 사용금지 = /사용\s*금지/.test(String(it.item_name || ""));
    // __view: 발주 목록을 list 뷰로(있으면), 없고 구매요청만 있으면 구매요청을 list로
    const hasPo = 발주.length > 0;
    const view: ViewPayload = {
      view: "list",
      title: `${code} ${it.item_name || ""} — ${hasPo ? "발주" : "구매요청"} 이력`,
      asOf,
      columns: hasPo
        ? [{ key: "발주번호", label: "발주번호" }, { key: "발주일", label: "발주일" }, { key: "거래처", label: "거래처" }, { key: "발주수량", label: "수량" }, { key: "발주금액", label: "금액(원)" }, { key: "진행", label: "진행" }]
        : [{ key: "구매요청번호", label: "구매요청" }, { key: "요청일", label: "요청일" }, { key: "요청부서", label: "부서" }, { key: "요청수량", label: "수량" }, { key: "진행", label: "진행" }],
      rows: hasPo
        // deno-lint-ignore no-explicit-any
        ? 발주.slice(0, 30).map((r: any) => ({ 발주번호: r.발주번호, 발주일: r.발주일, 거래처: r.거래처, 발주수량: comma(r.발주수량), 발주금액: comma(r.발주금액_원), 진행: r.진행 }))
        // deno-lint-ignore no-explicit-any
        : 구매요청.slice(0, 30).map((r: any) => ({ 구매요청번호: r.구매요청번호, 요청일: r.요청일, 요청부서: r.요청부서, 요청수량: comma(r.요청수량), 진행: r.진행 })),
      note: `구매요청 ${구매요청.length} · 발주 ${발주.length} · 매입 ${매입.length}건 (2026 기준)`,
    };
    return {
      기준시각: asOf,
      품목: { 품목코드: code, 품목명: it.item_name, 규격: it.spec, 단위: it.unit, 사용금지 },
      구매요청건수: 구매요청.length, 발주건수: 발주.length, 매입건수: 매입.length,
      구매요청, 발주, 매입,
      안내: (구매요청.length || 발주.length || 매입.length)
        ? "요청→발주→입고→매입 진행순. 진행상태 코드는 요청RQ→확정CF→발주완료PO→입고GR→매입IV. 수량·금액은 ERP 중간DB(2026) 기준."
        : `이 품목(${code})은 중간DB(2026년)에 등록된 구매요청·발주·매입이 없습니다. 2025년 이전 건은 미적재이니 있으면 원본 ERP를 확인하세요.`,
      // 이력 0건은 "없다"가 아니라 "적재범위 밖일 수 있다" — 평문으로 끝내지 않고 카드로 원인과 요청 경로를 준다(§14-6 P2b).
      // 조건 오입력(ⓓ)일 가능성이 있으므로 '품목 다시 확인'을 앞에 두고 요청 버튼은 뒤로 보낸다(confirm_first).
      __view: (구매요청.length || 발주.length) ? view : await (async () => {
        const p = gapOf(await loadLoadScope(admin, "pur_order"), "*");
        return { view: "notice", title: `${code} — 등록된 발주·구매요청 이력 없음`, kind: "info",
          text: `중간DB(${p ? "2026년 이후 적재" : "현재 적재범위"})에 이 품목의 구매요청·발주·매입이 없습니다. 품목코드가 맞는지 먼저 확인하시고, 2025년 이전 건이라면 적재범위 밖입니다.`,
          actions: [{ kind: "ask", label: "품목 정보 다시 확인", prompt: `품목 ${code} 정보 확인해줘` }],
          ...(p ? { request: { ui: "data", kind: "data", module: "pur_order", moduleKo: "발주·구매요청",
            dept: scope.dept || "미지정", confirm_first: true,
            gap: { type: "period", detail: p.label_ko, fix_type: p.fix_type } } } : {}),
        } satisfies ViewPayload;
      })(),
    };
  }

  if (name === "get_erp_po_pr") {
    const po = String(args.po_no || "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 20);
    const pr = String(args.pr_no || "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 20);
    if (!po && !pr) return { 오류: "po_no 또는 pr_no가 필요합니다." };
    // 입력 가드: PO/PR 번호 형식이 아니면(예: 품목코드 S3041-00065를 발주번호로 오인) 0건 무응답 대신 재안내.
    if ((po && !/^PO/i.test(po)) || (pr && !/^PR/i.test(pr))) {
      return { 오류: `입력값 "${po || pr}"은(는) 발주(PO…)/구매요청(PR…) 번호 형식이 아닙니다.`,
        재시도도구: "get_erp_item_orders",
        안내: "품목코드(예: S3041-00065)나 품목명이라면 get_erp_item_orders 로 그 품목의 발주·구매요청 이력을 조회하세요. 발주/구매요청 번호는 PO…/PR… 로 시작합니다." };
    }
    let q = admin.from("v_erp_po_pr_link").select("*").limit(50);
    if (po) q = q.eq("po_no", po);
    if (pr) q = q.eq("pr_no", pr);
    const { data } = await q; const rows = data || [];
    // 요청자 표기: '부서_이름_아이디' (미매핑은 원본 아이디 유지)
    const uMap = await userLabelMap(admin, rows.map((r: Record<string, unknown>) => r.req_prsn));
    // deno-lint-ignore no-explicit-any
    const 발주_구매요청 = rows.map((r: any) => ({
      발주번호: r.po_no, 구매요청번호: r.pr_no || null, 발주일: r.po_dt, 거래처: r.po_vendor,
      품목코드: r.item_code, 품목: r.item_name, 발주수량: Number(r.po_qty || 0), 발주금액_원: Number(r.po_amt || 0),
      발주상태: stsKo(r.po_sts), 입고수량: Number(r.po_rcpt_qty || 0), 매입수량: Number(r.iv_qty || 0),
      진행: `요청 ${Number(r.req_qty || 0)} → 발주 ${Number(r.ord_qty || 0)} → 입고 ${Number(r.po_rcpt_qty || 0)} → 매입 ${Number(r.iv_qty || 0)}`,
      납기: r.po_dlvy_dt, 납기경과_미입고: r.overdue_unreceived === true,
      외주구분: r.subcontra_flg === "Y" ? "외주" : "일반", 연결수주번호: r.so_no || null,
      요청일: r.req_dt, 필요납기: r.pr_dlvy_dt, 요청수량: Number(r.req_qty || 0),
      요청부서: r.req_dept_resolved || "미상", 요청자: userLbl(uMap, r.req_prsn), 구매요청상태: stsKo(r.pr_sts),
    }));
    // PR 조회인데 발주 라인이 없으면(미발주 PR) 구매요청 자체 상세로 답
    let 구매요청상세: unknown = null;
    let poPrView: ViewPayload | null = null;
    if (pr && !rows.length) {
      const { data: rd } = await admin.from("v_erp_pur_req").select("*").eq("pr_no", pr).maybeSingle();
      // deno-lint-ignore no-explicit-any
      const r: any = rd;
      const uMap2 = await userLabelMap(admin, [r?.req_prsn]);
      구매요청상세 = r ? {
        구매요청번호: r.pr_no, 구매요청상태: stsKo(r.pr_sts), 품목코드: r.item_code, 품목: r.item_name,
        요청수량: Number(r.req_qty || 0), 발주수량: Number(r.ord_qty || 0), 입고수량: Number(r.rcpt_qty || 0), 매입수량: Number(r.iv_qty || 0),
        진행: `요청 ${Number(r.req_qty || 0)} → 발주 ${Number(r.ord_qty || 0)} → 입고 ${Number(r.rcpt_qty || 0)} → 매입 ${Number(r.iv_qty || 0)}`,
        미발주: Number(r.ord_qty || 0) === 0, 요청일: r.req_dt, 필요납기: r.dlvy_dt,
        요청부서: r.req_dept_resolved || "미상", 요청자: userLbl(uMap2, r.req_prsn), 연결수주번호: r.so_no || null, 공급처: r.sppl_name || null,
      } : null;
      if (r) {
        poPrView = { view: "record", title: `구매요청 ${r.pr_no}`, asOf,
          fields: [
            { k: "품목", v: String(r.item_name || "-") },
            { k: "요청수량", v: comma(Number(r.req_qty || 0)) },
            { k: "요청일 / 필요납기", v: `${r.req_dt || "-"} / ${r.dlvy_dt || "-"}` },
            { k: "요청부서", v: String(r.req_dept_resolved || "미상") },
            { k: "요청자", v: userLbl(uMap2, r.req_prsn) || "-" },
            { k: "발주 여부", v: Number(r.ord_qty || 0) === 0 ? "미발주" : `발주 ${comma(Number(r.ord_qty || 0))}` },
          ],
          steps: { labels: STEP_LABELS, current: STEP_IX[String(r.pr_sts || "").trim()] ?? -1 } };
      }
    }
    // 발주 라인이 있으면 첫 라인 기준 record + 진행단계 steps
    // deno-lint-ignore no-explicit-any
    const f0: any = rows[0];
    if (f0) {
      poPrView = { view: "record", title: `발주 ${f0.po_no}`, asOf,
        fields: [
          { k: "거래처", v: String(f0.po_vendor || "-") },
          { k: "품목", v: String(f0.item_name || "-") + (rows.length > 1 ? ` 외 ${rows.length - 1}건` : "") },
          { k: "발주일", v: String(f0.po_dt || "-") },
          { k: "납기", v: String(f0.po_dlvy_dt || "-") + (f0.overdue_unreceived === true ? " ⚠경과·미입고" : "") },
          { k: "발주금액", v: won(Number(f0.po_amt || 0)) + (rows.length > 1 ? " (첫 라인)" : "") },
          { k: "수량 진행", v: `요청 ${comma(Number(f0.req_qty || 0))} → 발주 ${comma(Number(f0.ord_qty || 0))} → 입고 ${comma(Number(f0.po_rcpt_qty || 0))} → 매입 ${comma(Number(f0.iv_qty || 0))}` },
          { k: "구매요청", v: String(f0.pr_no || "-") + (f0.req_prsn ? ` · ${userLbl(uMap, f0.req_prsn)}` : (f0.req_dept_resolved ? ` · ${f0.req_dept_resolved}` : "")) },
          { k: "외주구분", v: f0.subcontra_flg === "Y" ? "외주" : "일반" },
        ],
        steps: { labels: STEP_LABELS, current: STEP_IX[String(f0.po_sts || "").trim()] ?? -1 } };
    }
    return { 기준시각: asOf, 조회조건: { po_no: po || null, pr_no: pr || null }, 연결건수: rows.length,
      발주_구매요청, 구매요청상세,
      안내: "ERP 중간DB 발주↔구매요청 연결(파일럿). 진행단계: 요청(RQ)→확정(CF)→발주(PO)→입고(GR)→매입(IV). 요청부서는 요청자 이메일→부서 매핑으로 보완됨.",
      ...(poPrView ? { __view: poPrView } : {}) };
  }

  if (name === "get_erp_pur_top") {
    const n = Math.min(Math.max(Number(args.n) || 10, 1), 30);
    const { data } = await admin.from("v_erp_pur_top_po")
      .select("po_no,po_dt,po_vendor,line_cnt,po_total,top_item,pr_no,has_open_line")
      .order("po_total", { ascending: false, nullsFirst: false }).limit(n);
    const rows = data || [];
    return { 기준시각: asOf, 상위N: n,
      // deno-lint-ignore no-explicit-any
      상위목록: rows.map((r: any) => ({
        발주번호: r.po_no, 발주일: r.po_dt, 거래처: r.po_vendor,
        발주총액_원: Number(r.po_total || 0), 라인수: Number(r.line_cnt || 0), 대표품목: r.top_item,
        구매요청번호: r.pr_no || null, 진행: r.has_open_line ? "진행중(일부 입고전)" : "입고/매입 진행",
      })),
      안내: "ERP 중간DB 발주 총액(발주번호별 라인 합산) 상위. 동일 발주 중복 없음. 파일럿 데이터.",
      __view: { view: "ranking", title: `발주 총액 상위 ${n}건`, unit: "원", asOf,
        // deno-lint-ignore no-explicit-any
        rows: rows.map((r: any, i: number) => ({ rank: i + 1, label: `${r.po_no} · ${r.po_vendor || "-"}`, v: Number(r.po_total || 0), sub: String(r.top_item || "") })),
        note: "발주번호별 라인 합산 총액 기준",
        ...(rows.length ? { actions: [{ kind: "ask", label: `1위 ${(rows[0] as Record<string, unknown>).po_no} 상세 보기`,
          prompt: `발주 ${(rows[0] as Record<string, unknown>).po_no} 상세 조회해줘` }] } : {}) } satisfies ViewPayload };
  }

  if (name === "get_erp_receipt_pending") {
    const overdueOnly = args.overdue_only === true || String(args.overdue_only) === "true";
    const lim = Math.min(Math.max(Number(args.limit) || 30, 1), 100);
    let q = admin.from("v_erp_po_pr_link")
      .select("po_no,po_vendor,item_name,po_qty,po_rcpt_qty,po_dlvy_dt,po_amt,overdue_unreceived")
      .eq("po_sts", "PO");
    if (overdueOnly) q = q.eq("overdue_unreceived", true);
    const { data } = await q.order("po_dlvy_dt", { ascending: true }).limit(lim);
    const rows = data || [];
    let amt = 0; for (const r of rows) amt += Number(r.po_amt || 0);
    // deno-lint-ignore no-explicit-any
    const 목록 = rows.map((r: any) => ({ 발주번호: r.po_no, 거래처: r.po_vendor, 품목: r.item_name,
      발주수량: Number(r.po_qty || 0), 입고수량: Number(r.po_rcpt_qty || 0), 납기: r.po_dlvy_dt,
      발주금액_원: Number(r.po_amt || 0), 납기경과: r.overdue_unreceived === true }));
    return { 기준시각: asOf, 조건: overdueOnly ? "납기경과·미입고" : "미입고(발주완료 PO상태)", 표시건수_라인: rows.length, 표시금액합_원: amt,
      목록,
      안내: "발주상태 PO=발주완료·입고전. 발주 라인 단위 목록(limit 제한). 파일럿 데이터.",
      __view: { view: "list", title: overdueOnly ? "납기경과·미입고 발주" : "미입고 발주(발주완료·입고전)", asOf,
        columns: [
          { key: "발주번호", label: "발주번호" }, { key: "거래처", label: "거래처" }, { key: "품목", label: "품목" },
          { key: "발주수량", label: "발주수량", num: true }, { key: "입고수량", label: "입고", num: true },
          { key: "납기", label: "납기" }, { key: "발주금액_원", label: "금액(원)", num: true }, { key: "경과", label: "" },
        ],
        rows: 목록.slice(0, 30).map((r) => ({ ...r, 경과: r.납기경과 ? "⚠" : "" })),
        note: `표시 ${rows.length}라인 · 합계 ${won(amt)}` } satisfies ViewPayload };
  }

  if (name === "get_erp_pur_req") {
    const status = String(args.status || "").trim();
    const dept = String(args.dept || "").replace(/[,()*%]/g, "").trim();
    const lim = Math.min(Math.max(Number(args.limit) || 30, 1), 100);
    let q = admin.from("v_erp_pur_req")
      .select("pr_no,pr_sts,item_name,req_qty,ord_qty,rcpt_qty,iv_qty,req_dt,dlvy_dt,req_dept_resolved,req_prsn,so_no");
    if (status === "unordered" || status === "미발주") q = q.or("ord_qty.eq.0,ord_qty.is.null");
    else if (status) q = q.eq("pr_sts", status.toUpperCase());
    if (dept) q = q.ilike("req_dept_resolved", `%${dept}%`);
    const { data } = await q.order("req_dt", { ascending: false }).limit(lim);
    const rows = data || [];
    // 요청자 표기: '부서_이름_아이디' (미매핑은 원본 아이디 유지)
    const uMap = await userLabelMap(admin, rows.map((r: Record<string, unknown>) => r.req_prsn));
    // deno-lint-ignore no-explicit-any
    const 목록 = rows.map((r: any) => ({ 구매요청번호: r.pr_no, 상태: stsKo(r.pr_sts), 품목: r.item_name,
      요청수량: Number(r.req_qty || 0), 발주수량: Number(r.ord_qty || 0), 미발주: Number(r.ord_qty || 0) === 0,
      요청일: r.req_dt, 필요납기: r.dlvy_dt, 요청부서: r.req_dept_resolved || "미상", 요청자: userLbl(uMap, r.req_prsn) }));
    return { 기준시각: asOf, 조건: { 상태: status || "전체", 부서: dept || "전체" }, 표시건수: rows.length,
      목록,
      안내: "구매요청 목록. status=unordered(미발주,ord_qty=0)/RQ(요청)/CF(확정). 요청부서는 요청자 이메일→부서 매핑 보완. 파일럿 데이터.",
      __view: { view: "list", title: `구매요청 — ${status || "전체"} / ${dept || "전부서"} (${rows.length}건)`, asOf,
        columns: [
          { key: "구매요청번호", label: "구매요청번호" }, { key: "상태", label: "상태" }, { key: "품목", label: "품목" },
          { key: "요청수량", label: "요청수량", num: true }, { key: "미발주표시", label: "" },
          { key: "요청일", label: "요청일" }, { key: "필요납기", label: "필요납기" },
          { key: "요청자", label: "요청자(부서_이름_아이디)" },
        ],
        rows: 목록.slice(0, 30).map((r) => ({ ...r, 미발주표시: r.미발주 ? "미발주" : "" })) } satisfies ViewPayload };
  }

  /* ===== 4단계 인사·권한 도구 ===== */
  if (name === "get_my_access") {
    // 본인 권한만(호출자 UPN 고정 — 모델이 타인 UPN을 지정할 수 없음).
    // v2: 판정은 이미 perm_effective(SSOT)가 끝냈다 — 여기서는 표현만 한다(중복 판정 제거).
    const deptAdminOf = scope.deptAdminOf;
    const role = scope.isAdmin ? "관리자(전권)" : (deptAdminOf.length ? "부서관리자" : "일반 사용자");
    const modules = [...scope.modules];
    const pages = scope.pages.map((p) => ({
      페이지: p.title, 담당부서: p.dept_nm, 공개범위: p.visibility,
      접근가능: p.allowed, 사유: p.reason, 경로: String(p.path || ""),
    }));
    // 개인 예외(겸직 부서·모듈 가감·기간 권한) — 본인에게 무엇이 왜 적용 중인지 투명하게 보여준다
    const 개인예외 = scope.grants.map((g) => ({
      유형: String(g.scope_type), 대상: String(g.scope_key),
      효과: g.effect === "deny" ? "차단" : "허용",
      만료: g.valid_to ? String(g.valid_to).slice(0, 10) : "무기한",
      사유: String(g.reason || ""),
    }));
    // deno-lint-ignore no-explicit-any
    const okPages = pages.filter((p: any) => p.접근가능);
    // deno-lint-ignore no-explicit-any
    const noPages = pages.filter((p: any) => !p.접근가능);
    // 계정 표기 규약: '부서_이름_아이디'
    const 계정표기 = `${scope.dept || "미매핑"}_${scope.empNm || "-"}_${scope.upn}`;
    return {
      기준시각: asOf, 계정: 계정표기, 이름: scope.empNm || "-", 소속부서: scope.dept || "미매핑",
      적용부서: scope.depts,
      역할: role, 관리자여부: scope.isAdmin, 부서관리자_담당부서: deptAdminOf,
      열람가능_ERP모듈: modules.map((m) => `${MODULE_KO[m] || m}(${m})`),
      개인예외권한: 개인예외,
      // deno-lint-ignore no-explicit-any
      접근가능_페이지: okPages.map((p: any) => p.페이지),
      // deno-lint-ignore no-explicit-any
      접근불가_페이지: noPages.map((p: any) => ({ 페이지: p.페이지, 담당부서: p.담당부서, 공개범위: p.공개범위, 사유: p.사유 })),
      __view: { view: "record", title: "내 포털 권한", asOf,
        fields: [
          { k: "계정", v: 계정표기 },
          { k: "소속부서", v: scope.depts.length > 1 ? scope.depts.join(" · ") + " (겸직·대행 포함)" : (scope.dept || "미매핑") },
          { k: "역할", v: role },
          { k: "ERP 모듈", v: modules.length ? modules.map((m) => MODULE_KO[m] || m).join(" · ") : "없음" },
          { k: "운영페이지", v: `접근가능 ${okPages.length} / 전체 ${pages.length}` },
          ...(개인예외.length ? [{ k: "개인 예외", v: 개인예외.map((g) => `${g.대상}(${g.효과}·${g.만료})`).join(", ") }] : []),
          ...(deptAdminOf.length ? [{ k: "부서관리자", v: deptAdminOf.join(", ") }] : []),
        ],
        // 접근 가능한 운영페이지 바로가기(상위 3) — 실제 열람 차단은 각 페이지 게이트(jeil-me)가 재판정
        // deno-lint-ignore no-explicit-any
        actions: okPages.filter((p: any) => p.경로).slice(0, 3)
          // deno-lint-ignore no-explicit-any
          .map((p: any) => ({ kind: "link", label: String(p.페이지), url: String(p.경로) })) } satisfies ViewPayload,
      권한요청방법: scope.isAdmin
        ? "관리자(전권) 계정이므로 별도 권한 요청이 필요 없습니다. 타 사용자 권한 부여는 관리자 콘솔 › 권한 설정에서 수행하세요(부서 단위 = 부서별 ERP 모듈, 개인 단위 = 개인 예외 권한)."
        : "필요한 데이터 모듈·페이지를 지정해 포털 관리자에게 요청하세요. 부서 전체가 필요하면 부서 권한으로, 본인만 필요하면 개인 예외 권한(기간 지정 가능)으로 부여됩니다. 급여·자금은 민감 모듈이라 별도 승인이 필요합니다.",
      안내: "본인 권한만 조회됩니다(타인 권한 조회 불가). 판정 기준(단일 출처 public.perm_effective): 전체 관리자(portal_admin) › 개인 예외(perm_grant, deny>allow) › 소속·겸직 부서 ERP 모듈(dept_erp_scope) + 페이지 공개범위(portal_page).",
    };
  }

  if (name === "get_hr_headcount" || name === "get_hr_payroll") {
    const wantsPay = name === "get_hr_payroll";
    const canDetail = hasModule(scope, "payroll");   // 부서별 분포·금액 열람 가능 여부(인사팀·관리자)
    // 민감 데이터 접근은 허용·거부 모두 감사 기록(jeil-hr와 동일 원장)
    try { await admin.rpc("hr_access_log_add", { p_upn: scope.upn, p_dept: scope.dept, p_ok: canDetail }); } catch { /* 무시 */ }
    if (wantsPay && !canDetail) {
      const 안내 = `급여 집계는 인사팀(또는 포털 관리자)만 열람할 수 있습니다. 회원님 소속(${scope.dept || "미지정"})은 권한 범위 밖입니다. 인원 수만 필요하시면 '인원현황'으로 다시 물어보세요(전사 총원은 조회 가능).`;
      return { 접근제한: true, 요청안내: true, 모듈: "payroll", 부서: scope.dept || "미지정", 안내,
        __view: { view: "notice", title: "급여 데이터 접근 제한", kind: "deny", text: 안내,
          request: { ui: "perm", kind: "perm_sensitive", module: "payroll", moduleKo: "급여·인사", dept: scope.dept || "미지정" },
          actions: [
            { kind: "ask", label: "전사 인원현황만 보기", prompt: "2026년 월별 전사 인원현황 보여줘" },
            { kind: "ask", label: "권한 요청 초안 작성", prompt: "포털 관리자에게 보낼 급여·인사(payroll) ERP 모듈 권한 요청 메시지 초안을 사내 메신저용으로 간결하게 작성해줘. 요청 사유 한 줄을 포함하고, 내가 복사해서 직접 보낼 수 있는 형태로." },
          ] } satisfies ViewPayload };
    }
    const ymF = String(args.ym || "").replace(/[^0-9]/g, "").slice(0, 6);   // 'YYYY-MM'·'YYYYMM' 모두 수용
    // erp_secure 는 REST 미노출 → service_role RPC로만 조회
    // deno-lint-ignore no-explicit-any
    const { data: pr, error } = await admin.rpc("hr_payroll_get");
    if (error) return { 오류: "인사 집계 조회 실패: " + error.message };
    // deno-lint-ignore no-explicit-any
    const rows = ((pr || []) as any[]).filter((r) => !ymF || String(r.ym) === ymF);
    if (!rows.length) {
      // 기간 밖 무데이터 — 평문 대신 카드 + 적용요청 경로(§14-6 P2b)
      const p = gapOf(await loadLoadScope(admin, "payroll"), "*");
      const 안내 = "해당 기간 인사 집계 데이터가 없습니다. 현재 중간DB는 2026년 이후만 월별 적재되어 있습니다.";
      return { 기준시각: asOf, 조건: ymF || "전체", 건수: 0, 안내,
        __view: { view: "notice", title: "인사 집계 — 적재범위 밖", kind: "info", text: 안내,
          actions: [{ kind: "ask", label: "2026년 인원현황 보기", prompt: "2026년 월별 전사 인원현황 보여줘" }],
          ...(p ? { request: { ui: "data", kind: "data", module: "payroll", moduleKo: "급여·인사",
            dept: scope.dept || "미지정", confirm_first: true,
            gap: { type: "period", detail: p.label_ko, fix_type: p.fix_type } } } : {}),
        } satisfies ViewPayload };
    }
    const byYm: Record<string, { hc: number; pay: number; ret: number; depts: number }> = {};
    for (const r of rows) {
      const m = (byYm[r.ym] = byYm[r.ym] || { hc: 0, pay: 0, ret: 0, depts: 0 });
      m.hc += Number(r.headcount || 0); m.pay += Number(r.pay_tot_amt || 0);
      m.ret += Number(r.retire_amt || 0); m.depts += 1;
    }
    const 월별 = Object.keys(byYm).sort().map((y) => ({
      월: `${y.slice(0, 4)}-${y.slice(4, 6)}`, 급여대상인원: byYm[y].hc, 부서수: byYm[y].depts,
      ...(wantsPay && canDetail ? { 급여총액_원: byYm[y].pay, 퇴직급여_원: byYm[y].ret } : {}),
    }));
    // 뷰: 인원(명) 또는 급여총액(원) 월별 시리즈 — 전사 총원은 전 직원, 급여는 권한 통과자만 이 지점에 도달
    const hrView: ViewPayload = { view: "series",
      title: wantsPay ? "월별 급여총액(전사)" : "월별 급여대상 인원(전사)",
      unit: wantsPay ? "원" : "명", asOf,
      // deno-lint-ignore no-explicit-any
      rows: (월별 as any[]).slice(-24).map((m) => ({ k: String(m.월), v: wantsPay ? Number(m.급여총액_원 || 0) : Number(m.급여대상인원 || 0) })),
      note: "급여대장(HDF070T) 기준 · 마감 전 변동 가능" + (wantsPay ? " · 집계만(개인별 없음)" : ""),
      // 후속질문 칩 — 권한 보유자(인사팀·관리자)에게만 급여 방향 유도(비권한자에게 차단 질문 유도 금지)
      ...(!wantsPay && canDetail ? { actions: [{ kind: "ask", label: "월별 급여총액 추이 보기", prompt: "2026년 월별 급여총액 추이 보여줘" }] } : {}) };
    const base = { 기준시각: asOf, 조건: ymF ? `${ymF.slice(0, 4)}-${ymF.slice(4, 6)}` : "전체 기간", 월별 };
    if (!canDetail) {
      return { ...base, 부서별: "권한 없음(비표시)",
        안내: "전사 총원(월별)만 제공됩니다. 부서별 인원 분포·급여액은 인사팀·관리자 전용입니다 — 필요 시 포털 관리자에게 요청하세요. 인원은 급여대장(HDF070T) 기준 급여대상 인원이며 마감 전 변동될 수 있습니다. 이 수치로 부서별 인원을 추정하지 마세요.",
        __view: hrView };
    }
    const 부서별 = rows
      // deno-lint-ignore no-explicit-any
      .map((r: any) => ({ 월: `${String(r.ym).slice(0, 4)}-${String(r.ym).slice(4, 6)}`, 부서: r.dept_nm, 인원: Number(r.headcount || 0),
        ...(wantsPay ? { 급여총액_원: Number(r.pay_tot_amt || 0), 퇴직급여_원: Number(r.retire_amt || 0) } : {}) }))
      .sort((a, b) => (a.월 === b.월 ? b.인원 - a.인원 : (a.월 < b.월 ? 1 : -1)))
      .slice(0, 120);
    return { ...base, 부서별, 열람권한: scope.isAdmin ? "관리자" : "인사팀",
      안내: `인원은 급여대장(HDF070T) 기준 급여대상 인원으로 마감 전 변동될 수 있습니다. ${wantsPay ? "급여는 집계(총액·인원)만이며 개인별·주민번호·계좌는 중간DB에 없습니다. " : ""}민감 데이터 접근은 감사 기록(hr_access_log)됩니다 — 답변에 개인 식별 정보를 포함하지 마세요.`,
      __view: hrView };
  }

  /* 내 요청 진행상황 — 완료 통보를 못 받아 재요청하던 문제(설계 §15-4)의 조회 경로.
     본인 접수분 + 동조 참여분만. 타인 요청은 조회 불가(요청자는 호출자 UPN으로 고정). */
  if (name === "get_my_requests") {
    const KIND_KO_REQ: Record<string, string> = {
      perm: "권한", perm_sensitive: "민감권한(급여·인사)", data: "데이터 적재범위",
      doc: "문서 연동범위", feature: "기능 요청", quality: "데이터 품질",
    };
    const ST_KO: Record<string, string> = {
      open: "접수", ack: "확인", doing: "처리중", done: "완료", rejected: "반려", duplicate: "중복", cancelled: "취소",
    };
    const cols = "req_no,kind,status,target_module,target_detail,reason,handled_note,created_at,closed_at";
    const [own, sup] = await Promise.all([
      admin.from("portal_request").select(cols).eq("requester_upn", scope.upn)
        .order("created_at", { ascending: false }).limit(20),
      admin.from("portal_request").select(cols).contains("supporters", [scope.upn])
        .order("created_at", { ascending: false }).limit(20),
    ]);
    const seen = new Set<string>();
    // deno-lint-ignore no-explicit-any
    const merged = ([...(own.data || []), ...(sup.data || [])] as any[])
      .filter((r) => (seen.has(r.req_no) ? false : (seen.add(r.req_no), true)))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    if (!merged.length) {
      return { 기준시각: asOf, 건수: 0,
        안내: "접수하신 요청이 없습니다. 챗봇이 '조회할 수 없다'고 답한 카드에서 「열람 권한 요청」 또는 「데이터 적용 요청」 버튼으로 접수할 수 있습니다." };
    }
    // deno-lint-ignore no-explicit-any
    const 목록 = merged.map((r: any) => ({
      접수번호: r.req_no, 유형: KIND_KO_REQ[r.kind] || r.kind, 상태: ST_KO[r.status] || r.status,
      대상: r.target_detail?.module_ko || r.target_module || "-",
      항목: r.target_detail?.gap?.detail || null,
      접수일: String(r.created_at).slice(0, 10), 사유: r.reason,
      처리회신: r.handled_note || null,
    }));
    return { 기준시각: asOf, 건수: 목록.length, 목록,
      안내: "본인이 접수했거나 동조자로 참여한 요청만 조회됩니다. 처리 결과는 '처리회신'에 표시되며, 권한 요청은 완료 후 재로그인하면 반영됩니다.",
      __view: { view: "list", title: `내 요청 ${목록.length}건`, asOf,
        columns: [
          { key: "접수번호", label: "접수번호" }, { key: "유형", label: "유형" },
          { key: "대상", label: "대상" }, { key: "상태", label: "상태" },
          { key: "접수일", label: "접수일" }, { key: "처리회신", label: "처리 회신" },
        ],
        // deno-lint-ignore no-explicit-any
        rows: 목록.map((r: any) => ({ ...r, 처리회신: r.처리회신 || "" })),
        note: "본인 접수·동조분만 표시" } satisfies ViewPayload };
  }

  /* ===== 3단계 문서 도구 (사용자 위임 토큰 · OneDrive/SharePoint 보안 트리밍) ===== */
  if (name === "search_regulation") {
    // 사내규정 조문 검색(REQ-0124) — 포털DB 사본(public.reg_* · definer RPC reg_search · 사내 전원). 본문은 HELPERS 만 쓴다(_port_modules 이식).
    // 2차(10-08 관리자 지시): 카드에 발췌(검색어 둘레 150자)를 같이 싣고, 「조문 ↗」은 조회 화면의 그 조문, 「PDF ↗」는 원본 파일
    // (비공개 버킷 사본 · 정본 SQL 108 · 화면이 사내 로그인 서명 URL 로 연다)로 보낸다. 그룹웨어 링크는 싣지 않는다(SSO 되돌림 · 10-08 실측).
    const SRC_LABEL = "사내규정 사본(그룹웨어 게시판 · 시행일 기준)";
    const q = String(args.q || "").replace(/[\u0000-\u001f\u007f%_\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
    if (q.length < 2) return { 오류: "검색어(q)는 두 글자 이상이어야 합니다." };
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 30);
    const link = `https://ai.jeilm.co.kr/work/regulations?q=${encodeURIComponent(q)}`;
    const pageOf = (key: string, no: string | null, pdf: boolean) =>
      `https://ai.jeilm.co.kr/work/regulations?reg=${encodeURIComponent(key)}${no ? "&art=" + encodeURIComponent(no) : ""}${pdf ? "&view=pdf" : ""}`;
    // 엔진에 도구 타임아웃이 없다 — 도구가 스스로 8초 상한을 건다(NAS 도구와 같은 값). 초과는 「오류」가 아니라 「확인하지 못함」(개선 대장 자동 적재 방지).
    const timeout = new Promise<{ data: null; error: { message: string } }>((r) => setTimeout(() => r({ data: null, error: { message: "timeout" } }), 8000));
    // deno-lint-ignore no-explicit-any
    const { data, error } = (await Promise.race([admin.rpc("reg_search", { p_q: q, p_limit: limit }), timeout])) as { data: any; error: any };
    if (error) {
      const msg = String(error.message || "");
      if (msg === "timeout") return { 확인여부: "확인하지 못함", 검색어: q, 안내: "사내규정 검색이 8초 안에 끝나지 않았습니다. 낱말을 줄여 한 번만 다시 시도하고, 그래도 안 되면 규정 조회 화면에서 확인하도록 안내하세요.",
        __view: { view: "notice", title: "사내규정 검색 지연", kind: "info", text: "검색이 제한 시간 안에 끝나지 않았습니다. 낱말을 줄여 다시 시도해 보세요.",
          actions: [{ kind: "link", label: "규정 조회 화면에서 보기", url: link }] } satisfies ViewPayload };
      if (error.code === "42501" || /forbidden|permission denied/i.test(msg)) return { 접근제한: true, 안내: "사내 계정으로 로그인한 사용자만 사내규정을 조회할 수 있습니다.",
        __view: { view: "notice", title: "사내규정 접근 안내", kind: "deny", text: "사내 계정으로 로그인한 사용자만 사내규정을 조회할 수 있습니다." } satisfies ViewPayload };
      return { 오류: "사내규정 검색 실패: " + msg };
    }
    // deno-lint-ignore no-explicit-any
    const res = (data || {}) as any;
    if (res.allowed === false) return { 접근제한: true, 안내: "사내 계정으로 로그인한 사용자만 사내규정을 조회할 수 있습니다.",
      __view: { view: "notice", title: "사내규정 접근 안내", kind: "deny", text: "사내 계정으로 로그인한 사용자만 사내규정을 조회할 수 있습니다." } satisfies ViewPayload };
    const asOfReg = res.as_of ? String(res.as_of).slice(0, 16).replace("T", " ") : null;
    const term0 = String(((res.terms || []) as unknown[])[0] || q.split(" ")[0] || "").toLowerCase();
    const snip = (s: string) => {   // 카드용 발췌 — 검색어 둘레 150자(도구 결과의 발췌는 320자 그대로 모델에 준다)
      const t = String(s || "").replace(/\s+/g, " ").trim();
      if (t.length <= 150) return t;
      const i = term0 ? t.toLowerCase().indexOf(term0) : -1;
      const st = Math.max(0, (i >= 0 ? i : 0) - 50);
      return (st > 0 ? "…" : "") + t.slice(st, st + 150) + (st + 150 < t.length ? "…" : "");
    };
    // deno-lint-ignore no-explicit-any
    const 목록 = ((res.rows || []) as any[]).map((r) => ({
      규정: r.name, reg_key: r.reg_key, 조문: r.article_no ? `제${r.article_no}조` : "전문", article_no: r.article_no || null,
      제목: r.title || "", 발췌: r.excerpt || "", 시행일: r.effective_date || null,
      조문보기: pageOf(String(r.reg_key), r.article_no || null, false),
      원본PDF: r.file_path ? pageOf(String(r.reg_key), r.article_no || null, true) : null, 원본파일: r.file_name || null,
    }));
    const columns = [{ key: "규정", label: "규정" }, { key: "조문", label: "조문" }, { key: "제목", label: "제목" }, { key: "발췌", label: "발췌", wrap: true },
                     { key: "시행일", label: "시행일" }, { key: "조문보기", label: "보기", link: true, linkLabel: "조문 ↗" }, { key: "원본PDF", label: "원본", link: true, linkLabel: "PDF ↗" }];
    const actions: { kind: string; label: string; url: string }[] = [{ kind: "link", label: "규정 조회 화면에서 보기", url: link }];
    if (!목록.length) return { 출처: SRC_LABEL, 기준시각: asOfReg || asOf, 검색어: q, 건수: 0, 목록: [],
      안내: `포털에 수집된 규정 조문에서 '${q}' 를 찾지 못했습니다. 낱말을 줄여 한 번만 다시 찾고, 그래도 없으면 '포털의 규정 사본에서 찾지 못함'이라고 답하고 담당 부서(인사팀·총무팀) 확인을 안내하세요. 조문을 추측해 만들지 마세요.`,
      __view: { view: "list", title: `사내규정 검색 — "${q}" (0건)`, asOf, columns, rows: [],
        note: "수집된 규정 사본 기준" + (asOfReg ? ` · 기준 ${asOfReg}` : "") + " — 낱말을 줄여 다시 찾아 보세요", actions } satisfies ViewPayload };
    const top = 목록[0];
    if (top.원본PDF) actions.push({ kind: "link", label: `원본 PDF — ${top.규정}`, url: top.원본PDF });
    return { 출처: SRC_LABEL, 기준시각: asOfReg || asOf, 검색어: q, 건수: 목록.length, 목록,
      안내: "답변 형식: ① 첫 줄에 결론 한 문장 ② 근거는 「규정명 제n조(제목) · 시행 YYYY-MM-DD」 꼴로 적고 해당 조문 문장을 짧게 그대로 인용 ③ 필요하면 유의사항 한두 줄. 위 목록은 카드(표)로 함께 보이니 글에서 표를 다시 만들지 마세요. 발췌 범위 밖은 추측하지 말고, 전문이 필요하면 get_regulation(reg=reg_key, article_no). 규정의 해석·예외 인정·개별 산정(금액·일수 계산)은 담당 부서(인사팀·총무팀) 확인을 안내하세요. 이 값은 그룹웨어 게시판의 포털 사본이라 수집 뒤 개정됐을 수 있습니다. 원본 PDF 는 카드의 「PDF ↗」로 열립니다.",
      __view: { view: "list", title: `사내규정 검색 — "${q}" (${목록.length}건)`, asOf, columns,
        rows: 목록.map((x) => ({ 규정: x.규정, 조문: x.조문, 제목: x.제목, 발췌: snip(x.발췌), 시행일: String(x.시행일 || "").slice(0, 10), 조문보기: x.조문보기, 원본PDF: x.원본PDF })),
        note: "그룹웨어 규정 게시판의 포털 사본" + (asOfReg ? ` · 기준 ${asOfReg}` : "") + " — 「조문 ↗」은 조회 화면의 그 조문, 「PDF ↗」는 원본 파일",
        actions } satisfies ViewPayload };
  }

  if (name === "get_regulation") {
    // 사내규정 조문 읽기(REQ-0124) — reg_key 또는 규정명 부분일치 → definer RPC reg_get. 본문은 8,000자 창으로 잘라 이어 읽는다.
    // 2차(10-08): 조문 1개 카드는 짧은 메타 + 긴 본문 칸(long) · 「원본 PDF 열기」(비공개 버킷 사본 · SQL 108) · 그룹웨어 링크는 싣지 않는다.
    const SRC_LABEL = "사내규정 사본(그룹웨어 게시판 · 시행일 기준)";
    const regIn = String(args.reg || "").replace(/[\u0000-\u001f\u007f%\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
    if (!regIn) return { 오류: "규정(reg)이 필요합니다 — search_regulation 결과의 reg_key 또는 규정명 일부." };
    const artNo = String(args.article_no || "").trim().slice(0, 20) || null;
    const start = Math.max(1, Number(args.start) || 1);
    const WINDOW = 8000;
    const timeout = () => new Promise<{ data: null; error: { message: string } }>((r) => setTimeout(() => r({ data: null, error: { message: "timeout" } }), 8000));
    const deny = () => ({ 접근제한: true, 안내: "사내 계정으로 로그인한 사용자만 사내규정을 조회할 수 있습니다.",
      __view: { view: "notice", title: "사내규정 접근 안내", kind: "deny", text: "사내 계정으로 로그인한 사용자만 사내규정을 조회할 수 있습니다." } satisfies ViewPayload });
    let regKey = regIn;
    if (!/^[a-z0-9_]{1,40}:.+$/i.test(regIn)) {
      // 규정명으로 들어왔다 — 현행 목록에서 부분일치로 찾는다(후보가 여럿이면 되묻기)
      // deno-lint-ignore no-explicit-any
      const { data: ld, error: le } = (await Promise.race([admin.rpc("reg_list", { p_category: null, p_q: regIn }), timeout()])) as { data: any; error: any };
      if (le) return le.message === "timeout" ? { 확인여부: "확인하지 못함", 안내: "사내규정 목록 조회가 8초 안에 끝나지 않았습니다. 잠시 뒤 다시 시도하세요." } : { 오류: "사내규정 목록 조회 실패: " + String(le.message || "") };
      if (ld && ld.allowed === false) return deny();
      // deno-lint-ignore no-explicit-any
      const cands = ((ld && ld.rows) || []) as any[];
      if (!cands.length) return { 출처: SRC_LABEL, 기준시각: asOf, 규정: regIn, 건수: 0,
        안내: `'${regIn}' 에 맞는 규정이 포털 사본에 없습니다. search_regulation 으로 낱말을 바꿔 찾거나, '포털의 규정 사본에서 찾지 못함'이라고 답하고 담당 부서 확인을 안내하세요.`,
        __view: { view: "notice", title: "사내규정 없음", kind: "info", text: `'${regIn}' 에 맞는 규정이 포털 사본에 없습니다.` } satisfies ViewPayload };
      if (cands.length > 1) return { 출처: SRC_LABEL, 기준시각: asOf, 규정: regIn, 건수: cands.length,
        후보: cands.slice(0, 10).map((c) => ({ 규정: c.name, reg_key: c.reg_key, 분류: c.category || null, 시행일: c.effective_date || null, 조문수: c.article_count })),
        안내: "규정이 여럿입니다 — 사용자에게 어느 규정인지 묻거나, 가장 맞는 reg_key 로 get_regulation 을 다시 부르세요.",
        __view: { view: "list", title: `사내규정 후보 — "${regIn}" (${cands.length}건)`, asOf,
          columns: [{ key: "규정", label: "규정" }, { key: "분류", label: "분류" }, { key: "시행일", label: "시행일" }, { key: "조문수", label: "조문" }, { key: "보기", label: "보기", link: true, linkLabel: "열기 ↗" }],
          rows: cands.slice(0, 10).map((c) => ({ 규정: c.name, 분류: c.category || "", 시행일: String(c.effective_date || "").slice(0, 10), 조문수: c.article_count,
                                                보기: `https://ai.jeilm.co.kr/work/regulations?reg=${encodeURIComponent(String(c.reg_key))}` })) } satisfies ViewPayload };
      regKey = String(cands[0].reg_key);
    }
    // deno-lint-ignore no-explicit-any
    const { data, error } = (await Promise.race([admin.rpc("reg_get", { p_reg_key: regKey, p_article_no: artNo, p_from_seq: start, p_limit: 300 }), timeout()])) as { data: any; error: any };
    if (error) {
      const msg = String(error.message || "");
      if (msg === "timeout") return { 확인여부: "확인하지 못함", 안내: "사내규정 읽기가 8초 안에 끝나지 않았습니다. 조문 번호(article_no)를 지정해 다시 시도하세요." };
      if (error.code === "42501" || /forbidden|permission denied/i.test(msg)) return deny();
      return { 오류: "사내규정 읽기 실패: " + msg };
    }
    // deno-lint-ignore no-explicit-any
    const res = (data || {}) as any;
    if (res.allowed === false) return deny();
    if (!res.found) return { 출처: SRC_LABEL, 기준시각: asOf, 규정: regKey, 건수: 0,
      안내: "이 규정의 현행 판이 포털 사본에 없습니다(삭제됐거나 아직 수집 전). 담당 부서 확인을 안내하세요.",
      __view: { view: "notice", title: "사내규정 없음", kind: "info", text: "이 규정의 현행 판이 포털 사본에 없습니다." } satisfies ViewPayload };
    const r = res.reg || {};
    const asOfReg = res.as_of ? String(res.as_of).slice(0, 16).replace("T", " ") : null;
    const linkOf = (no: string | null, pdf = false) => `https://ai.jeilm.co.kr/work/regulations?reg=${encodeURIComponent(regKey)}${no ? "&art=" + encodeURIComponent(no) : ""}${pdf ? "&view=pdf" : ""}`;
    const 규정 = { 규정명: r.name, reg_key: r.reg_key, 분류: r.category || null, 제정일: r.enact_date || null, 개정일: r.revise_date || null, 시행일: r.effective_date || null,
      개정차수: r.revision_no || null, 주관부서: r.owner_dept || null, 판독: r.parse_status, 조문원천: r.text_source,
      원본파일: r.file_name || null, 원본PDF: r.file_path ? linkOf(null, true) : null };
    // deno-lint-ignore no-explicit-any
    const 첨부 = ((res.attachments || []) as any[]).map((a) => ({ 파일: a.file_name, 판독: a.text_status, 사유: a.text_reason || null, 포털사본: a.storage_path ? "있음" : "없음" }));
    // deno-lint-ignore no-explicit-any
    const arts = (res.articles || []) as any[];
    const 안내공통 = "답변 형식: 결론 한 문장 → 근거 「규정명 제n조(제목) · 시행 YYYY-MM-DD」 + 조문 문장 짧은 인용 → 유의사항 한두 줄. 조문은 카드에 보이니 본문을 통째로 다시 적지 마세요. 해석·예외 인정·개별 산정은 담당 부서(인사팀·총무팀) 확인을 안내하세요. 이 값은 그룹웨어 게시판의 포털 사본이라 수집 뒤 개정됐을 수 있습니다(판독 불가 첨부의 내용은 들어 있지 않습니다). 원본 PDF 는 카드의 「원본 PDF 열기」로 볼 수 있습니다.";
    const pdfAct = (no: string | null) => (r.file_path ? [{ kind: "link", label: "원본 PDF 열기", url: linkOf(no, true) }] : []);
    if (artNo) {
      const a = arts[0];
      if (!a) return { 출처: SRC_LABEL, 기준시각: asOfReg || asOf, 규정, 조문번호: artNo, 건수: 0,
        안내: `제${artNo}조가 이 규정의 사본에 없습니다. get_regulation(reg) 으로 목차를 보고 번호를 확인하세요.`,
        __view: { view: "notice", title: `${r.name} 제${artNo}조 없음`, kind: "info", text: "그 조문 번호가 사본에 없습니다 — 목차에서 확인하세요.",
          actions: [{ kind: "link", label: "목차 보기", url: linkOf(null) }] } satisfies ViewPayload };
      const body = String(a.body || "");
      return { 출처: SRC_LABEL, 기준시각: asOfReg || asOf, 규정,
        조문: { 조문번호: a.article_no, 장: a.chapter || null, 절: a.section || null, 제목: a.title || null, 본문: body.slice(0, WINDOW), 개정꼬리표: a.amended_tag || null, 삭제됨: !!a.is_deleted },
        첨부, 안내: 안내공통,
        __view: { view: "record", title: `${r.name} 제${a.article_no}조${a.title ? "(" + a.title + ")" : ""}`, asOf,
          fields: [{ k: "규정", v: String(r.name || "") + (r.category ? ` · ${r.category}` : "") }, { k: "조문", v: `제${a.article_no}조` + (a.title ? ` ${a.title}` : "") + (a.chapter ? ` · ${a.chapter}` : "") },
                   { k: "시행일", v: String(r.effective_date || "").slice(0, 10) || "—" }, { k: "개정", v: a.amended_tag || (r.revise_date ? String(r.revise_date).slice(0, 10) + (r.revision_no ? ` (${r.revision_no}차)` : "") : "—") },
                   { k: "주관부서", v: r.owner_dept || "—" }, { k: "원본", v: r.file_name ? `${r.file_name} (PDF 사본)` : "포털 사본 없음 — 그룹웨어 게시판" },
                   { k: "본문", v: body.slice(0, 1200) + (body.length > 1200 ? " …(이하 생략 — 화면에서 전체 보기)" : ""), long: true }],
          note: "그룹웨어 규정 게시판의 포털 사본" + (asOfReg ? ` · 기준 ${asOfReg}` : ""),
          actions: [{ kind: "link", label: "화면에서 이 조문 보기", url: linkOf(String(a.article_no)) }, ...pdfAct(String(a.article_no))] } satisfies ViewPayload };
    }
    // 전체 — 목차는 전부, 본문은 start 부터 8,000자 창까지(결과 절단 12,000자 안쪽). 남으면 다음조문.
    // deno-lint-ignore no-explicit-any
    const 목차 = ((res.toc || []) as any[]).map((t) => ({ seq: t.seq, 조문번호: t.article_no, 제목: t.title || null, 장: t.chapter || null, 삭제됨: !!t.is_deleted }));
    const 조문: { seq: number; 조문번호: string | null; 제목: string | null; 본문: string; 개정꼬리표: string | null }[] = [];
    let used = 0, nextSeq: number | null = res.next_seq || null;
    for (const a of arts) {
      const body = String(a.body || "");
      if (조문.length && used + body.length > WINDOW) { nextSeq = a.seq; break; }
      조문.push({ seq: a.seq, 조문번호: a.article_no || null, 제목: a.title || null, 본문: body.slice(0, WINDOW), 개정꼬리표: a.amended_tag || null });
      used += body.length;
    }
    return { 출처: SRC_LABEL, 기준시각: asOfReg || asOf, 규정, 조문수: res.total_articles || 목차.length, 목차, 조문, 다음조문: nextSeq, 첨부,
      안내: 안내공통 + (nextSeq ? ` 조문이 더 있습니다 — 이어 읽으려면 start=${nextSeq} 로 다시 부르세요. 목차의 조문 번호를 article_no 로 바로 읽어도 됩니다.` : ""),
      __view: { view: "list", title: `${r.name} — 목차 (${목차.length}개 조문)`, asOf,
        columns: [{ key: "조문", label: "조문" }, { key: "제목", label: "제목" }, { key: "장", label: "장" }, { key: "보기", label: "보기", link: true, linkLabel: "조문 ↗" }],
        rows: 목차.slice(0, 60).map((t) => ({ 조문: t.조문번호 ? `제${t.조문번호}조` : "전문", 제목: (t.제목 || "") + (t.삭제됨 ? " (삭제)" : ""), 장: t.장 || "",
                                             보기: t.조문번호 ? linkOf(String(t.조문번호)) : linkOf(null) })),
        note: `시행 ${String(r.effective_date || "").slice(0, 10) || "—"} · 판독 ${r.parse_status}` + (asOfReg ? ` · 기준 ${asOfReg}` : "") + (목차.length > 60 ? ` · 표시 60건 / 전체 ${목차.length}건` : ""),
        actions: [{ kind: "link", label: "화면에서 보기", url: linkOf(null) }, ...pdfAct(null)] } satisfies ViewPayload };
  }

  if (name === "search_my_documents") {
    const q = String(args.query || "").trim();
    if (!q) return { 오류: "검색어(query)가 필요합니다." };
    const size = Math.min(Math.max(Number(args.limit) || 8, 1), 15);
    // 화이트리스트(§8): 승인 컨테이너로만 제한. 미설정이면 fail-closed(전 문서 노출 방지).
    const docScope = await loadDocScope(admin);
    if (!docScope) return { 오류: "문서 연동 범위 미설정",
      안내: "AI 문서 연동 범위(승인 프로젝트 폴더)가 설정되지 않아 검색을 제공하지 않습니다. 관리자에게 범위 등록을 요청하세요.",
      __view: { view: "notice", title: "문서 연동 범위 미설정", kind: "info",
        text: "AI 문서 연동 범위(승인 프로젝트 폴더)가 설정되지 않아 검색을 제공하지 않습니다. 관리자에게 범위 등록을 요청하세요.",
        // 문서 승인범위는 "문서는 있는데 못 본다" → 사용자 화면상 권한요청(ui:perm), 원장 유형은 doc(담당 분리)
        request: { ui: "perm", kind: "doc", module: "document", moduleKo: "문서 연동범위",
          dept: scope.dept || "미지정" } } satisfies ViewPayload };
    try {
      // 서버측 스코프: 승인 범위 경로(폴더/라이브러리/사이트)로 KQL path 한정 + 여유분 확보(후단 하드필터 대비)
      const pathClause = ` AND (${docScope.map((s) => `path:"${s.webUrl}"`).join(" OR ")})`;
      const data = await graphSearchDocs(userToken, q + pathClause, Math.min(Math.max(size * 4, size), 40));
      // deno-lint-ignore no-explicit-any
      const hc = (data as any).value?.[0]?.hitsContainers?.[0];
      // deno-lint-ignore no-explicit-any
      const 목록 = (hc?.hits || []).map((h: any) => ({
        이름: h.resource?.name, 수정일: h.resource?.lastModifiedDateTime, 링크: h.resource?.webUrl,
        driveId: h.resource?.parentReference?.driveId, itemId: h.resource?.id, 발췌: h.summary || null,
      }))
        // 이중 게이트: 승인 driveId 일치 AND 경로가 승인 접두로 시작(폴더 레벨 하드 필터 — 경로 스코프 누수 대비)
        // deno-lint-ignore no-explicit-any
        .filter((x: any) => inScope(docScope, String(x.driveId || ""), String(x.링크 || "")))
        .slice(0, size);
      return { 기준시각: asOf, 검색어: q, 승인범위_수: docScope.length, 반환수: 목록.length, 목록,
        안내: "AI 승인 범위(폴더/라이브러리 화이트리스트) ∩ 본인 권한 범위 문서만 검색됨(§8 이중 게이트). 본문·상세는 read_document(driveId,itemId). 답변에 출처(파일명·링크) 표기. 범위 밖이면 결과 없음이 정상.",
        __view: { view: "list", title: `문서 검색 — "${q}" (${목록.length}건)`, asOf,
          columns: [
            { key: "이름", label: "파일명" }, { key: "수정일", label: "수정일" }, { key: "링크", label: "열기", link: true },
          ],
          // deno-lint-ignore no-explicit-any
          rows: 목록.map((x: any) => ({ 이름: x.이름, 수정일: String(x.수정일 || "").slice(0, 10), 링크: x.링크 })),
          // 0건은 "없다"가 아니라 "승인 범위 밖일 수 있다" — 검색어 재확인을 먼저 권하고 요청 경로를 함께 준다.
          ...(목록.length === 0 ? { request: { ui: "perm", kind: "doc", module: "document", moduleKo: "문서 연동범위", dept: scope.dept || "미지정", confirm_first: true } } : {}),
          note: 목록.length === 0
            ? "검색 결과 없음 — 검색어를 바꿔보시고, 필요한 폴더가 AI 연동 범위에 없다면 아래로 요청하세요"
            : "AI 승인 범위 ∩ 본인 권한 문서만" } satisfies ViewPayload };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("401") || msg.includes("403")) return { 오류: "문서 접근 권한 없음", 안내: "MS 재로그인(파일 권한 포함)이 필요할 수 있습니다. 계속 실패하면 관리자에게 문의하세요." };
      return { 오류: "문서 검색 실패: " + msg };
    }
  }

  if (name === "read_document") {
    const driveId = String(args.driveId || "").trim();
    const itemId = String(args.itemId || "").trim();
    if (!driveId || !itemId) return { 오류: "driveId·itemId가 필요합니다(먼저 search_my_documents로 조회)." };
    // 화이트리스트(§8): 승인 범위의 문서만 판독 허용(범위 밖 driveId/폴더 직접 열람 차단)
    const docScope = await loadDocScope(admin);
    if (!docScope) return { 오류: "문서 연동 범위 미설정", 안내: "AI 문서 연동 범위가 설정되지 않아 본문을 제공하지 않습니다. 관리자에게 문의하세요." };
    // 1차 게이트: 승인 driveId가 하나도 없으면 Graph 호출 전 차단
    if (!docScope.some((s) => s.driveId === driveId)) {
      const 안내 = "이 문서는 AI 연동 승인 범위(프로젝트 폴더)에 없어 열람할 수 없습니다. search_my_documents로 승인 범위 내 문서를 찾으세요.";
      return { 오류: "범위 밖 문서", 안내,
        __view: { view: "notice", title: "문서 연동 승인범위 밖", kind: "deny", text: 안내,
          request: { ui: "perm", kind: "doc", module: "document", moduleKo: "문서 연동범위", dept: scope.dept || "미지정" } } satisfies ViewPayload };
    }
    const base = `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}`;
    try {
      const meta = await graphGet(userToken, `${base}?$select=name,size,file,webUrl,lastModifiedDateTime`);
      // 2차 게이트: 폴더 레벨 경로 검증(승인 폴더 하위인지) — 같은 라이브러리라도 범위 밖 폴더면 차단
      if (!inScope(docScope, driveId, String(meta.webUrl || ""))) {
        const 안내 = "이 문서는 승인된 AI 연동 폴더 하위가 아니어서 열람할 수 없습니다. search_my_documents로 승인 범위 내 문서를 찾으세요.";
        return { 오류: "범위 밖 폴더", 안내,
          __view: { view: "notice", title: "승인 폴더 밖 문서", kind: "deny", text: 안내,
            request: { ui: "perm", kind: "doc", module: "document", moduleKo: "문서 연동범위", dept: scope.dept || "미지정" } } satisfies ViewPayload };
      }
      const nm = String(meta.name || "");
      if (/\.xlsx?$/i.test(nm)) {
        const ws = await graphGet(userToken, `${base}/workbook/worksheets`);
        // deno-lint-ignore no-explicit-any
        const sid = (ws as any).value?.[0]?.id;
        // deno-lint-ignore no-explicit-any
        const sname = (ws as any).value?.[0]?.name;
        const ur = await graphGet(userToken, `${base}/workbook/worksheets('${sid}')/usedRange(valuesOnly=true)`);
        // deno-lint-ignore no-explicit-any
        const rows = ((ur as any).text || []).slice(0, 40);
        return { 기준시각: asOf, 파일: nm, 링크: meta.webUrl, 시트: sname, 범위: (ur as Record<string, unknown>).address,
          행수: (ur as Record<string, unknown>).rowCount, 열수: (ur as Record<string, unknown>).columnCount, 셀값: rows,
          안내: "Excel 셀 값(최대 40행). 본인 권한 내 파일만 판독됨. 개인정보(급여·주민번호 등)는 답변에 노출 금지." };
      }
      if (/\.(txt|csv|md|json)$/i.test(nm)) {
        const r = await fetch(`${base}/content`, { headers: { Authorization: `Bearer ${userToken}` } });
        if (!r.ok) throw new Error(`Graph ${r.status}`);
        const t = (await r.text()).slice(0, 8000);
        return { 기준시각: asOf, 파일: nm, 링크: meta.webUrl, 내용: t, 안내: "텍스트 본문(최대 8000자). 본인 권한 내 파일만." };
      }
      return { 기준시각: asOf, 파일: nm, 크기: meta.size, 링크: meta.webUrl,
        안내: "이 형식(docx/pdf 등)의 본문 추출은 현재 미지원(후속 과제) — Excel·텍스트만 본문 판독. 파일은 접근 가능하며 링크로 열람하세요." };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("401") || msg.includes("403")) return { 오류: "문서 접근 권한 없음", 안내: "본인 권한 밖 문서이거나 재로그인이 필요합니다." };
      return { 오류: "문서 읽기 실패: " + msg };
    }
  }

  return { 오류: `알 수 없는 도구: ${name}` };
}

/* ===== Entra 토큰 검증 ===== */
async function verifyEntraUser(token: string): Promise<{ upn: string } | null> {
  try {
    const r = await fetch("https://graph.microsoft.com/v1.0/me?$select=userPrincipalName,mail", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const me = await r.json();
    const upn = String(me.userPrincipalName || me.mail || "").toLowerCase();
    if (!upn.endsWith("@jeilm.co.kr")) return null;
    return { upn };
  } catch {
    return null;
  }
}

/* ===== OpenAI 스트림 호출·파싱 ===== */
/* ===== OpenAI 요청 모양 자동 적응 (모델 세대 차이 흡수) =====
   세대에 따라 `temperature` 를 거부하거나 `max_tokens` 대신 `max_completion_tokens` 를 요구하고,
   추론 모델은 도구와 함께 부를 때 `reasoning_effort:"none"` 을 요구한다(2026-09-30 gpt-6-luna 실측 · REQ-0095).
   모델 목록을 코드에 박지 않는다 — 400 응답의 사유를 읽어 고쳐 한 번 더 보내고, 통한 모양을 기억한다.
   (400 이 아닌 오류는 손대지 않는다. 재시도로 해결될 문제가 아니다.)
   ※ 아래 `type OaShape` ~ `oaAdjust` 는 jeil-chat-lab/llm/openai.ts 와 **글자 단위로 같아야 한다** — `node _test_oa_shape.mjs` 가 검사한다. */
type OaShape = { temp: boolean; maxKey: "max_tokens" | "max_completion_tokens"; reasoning: "none" | null };
const OA_SHAPE = new Map<string, OaShape>();
const oaShape = (model: string): OaShape => OA_SHAPE.get(model) || { temp: true, maxKey: "max_tokens", reasoning: null };

/** 400 사유의 파라미터 이름 — 본문 JSON 의 error.param 우선, JSON 이 아니면 문구 정규식 폴백(벤더 문구 변경 내성) */
function oaParam(detail: string): string {
  try {
    const p = JSON.parse(detail)?.error?.param;
    if (typeof p === "string" && p) return p.toLowerCase();
  } catch { /* JSON 아님 — 문구로 판독 */ }
  const d = detail.toLowerCase();
  if (/reasoning_effort/.test(d)) return "reasoning_effort";
  if (/max_completion_tokens|max_tokens/.test(d)) return "max_tokens";
  if (/temperature/.test(d)) return "temperature";
  return "";
}

/** 400 사유를 보고 요청 모양을 한 단계 고친다. 고칠 게 없으면 null(=포기).
    이미 적용한 손잡이를 또 요구하면 null — 같은 사유로 무한 재시도하지 않는다. */
function oaAdjust(model: string, detail: string): OaShape | null {
  const p = oaParam(detail);
  const cur = oaShape(model);
  if (p === "temperature" && cur.temp) {
    const next: OaShape = { ...cur, temp: false };
    OA_SHAPE.set(model, next);
    console.log("openai shape: " + model + " → temperature 미전송");
    return next;
  }
  if ((p === "max_tokens" || p === "max_completion_tokens") && cur.maxKey === "max_tokens") {
    const next: OaShape = { ...cur, maxKey: "max_completion_tokens" };
    OA_SHAPE.set(model, next);
    console.log("openai shape: " + model + " → max_completion_tokens 사용");
    return next;
  }
  // 추론 모델(gpt-6 계열)은 chat/completions 에서 도구와 reasoning_effort 를 함께 받지 않는다 — 벤더 오류문이 none 을 지시(2026-09-30 실측)
  if (p === "reasoning_effort" && !cur.reasoning) {
    const next: OaShape = { ...cur, reasoning: "none" };
    OA_SHAPE.set(model, next);
    console.log("openai shape: " + model + " → reasoning_effort none(도구 병용 · 추론 끔)");
    return next;
  }
  return null;
}

/** DB(ai_model.request_shape) 시드용 화이트리스트 — jsonb 를 그대로 믿지 않는다 */
function sanitizeShape(v: unknown): OaShape | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  return {
    temp: typeof o.temp === "boolean" ? o.temp : true,
    maxKey: o.maxKey === "max_completion_tokens" ? "max_completion_tokens" : "max_tokens",
    reasoning: o.reasoning === "none" ? "none" : null,
  };
}

function callOpenAIOnce(apiKey: string, model: string, messages: unknown[], withTools: boolean, maxTokens: number, temperature: number, shape: OaShape, signal?: AbortSignal) {
  return fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    signal,                                               // 중지 전파 — 클라이언트 disconnect 시 업스트림 소비 중단
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model, stream: true, messages,
      [shape.maxKey]: maxTokens,
      ...(shape.temp ? { temperature } : {}),
      ...(shape.reasoning ? { reasoning_effort: shape.reasoning } : {}),   // 학습된 뒤에는 도구 유무와 무관하게 유지(라운드 간 모양 일관)
      stream_options: { include_usage: true },            // U-1: 토큰 usage 수신
      ...(withTools ? { tools: TOOLS } : {}),
    }),
  });
}

/** 400 이면 요청 모양을 고쳐 최대 3회까지 다시 보낸다(temperature → max_completion_tokens → reasoning_effort). 그 외 오류는 그대로 돌려준다. */
const OA_MAX_ADJUST = 3;
async function callOpenAI(apiKey: string, model: string, messages: unknown[], withTools: boolean, maxTokens: number, temperature: number, signal?: AbortSignal): Promise<Response> {
  let res = await callOpenAIOnce(apiKey, model, messages, withTools, maxTokens, temperature, oaShape(model), signal);
  for (let i = 0; i < OA_MAX_ADJUST && res.status === 400; i++) {
    const detail = await res.clone().text().catch(() => "");
    const next = oaAdjust(model, detail);
    if (!next) break;
    res = await callOpenAIOnce(apiKey, model, messages, withTools, maxTokens, temperature, next, signal);
  }
  return res;
}

type ToolCallAcc = { id: string; name: string; args: string };
type PumpState = { pt: number; ct: number; toolCalls: Record<number, ToolCallAcc>; rt?: number; finish?: string | null };   // rt·finish: 점검 증거(REQ-0095)

// OpenAI SSE를 읽어 content는 emit, tool_calls·usage는 state에 축적
async function pumpStream(body: ReadableStream<Uint8Array>, emit: (c: string) => Promise<void>, state: PumpState) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const ln of lines) {
      const t = ln.trim();
      if (!t.startsWith("data:")) continue;
      const p = t.slice(5).trim();
      if (p === "[DONE]") continue;
      // deno-lint-ignore no-explicit-any
      let ev: any; try { ev = JSON.parse(p); } catch { continue; }
      if (ev.usage) {
        state.pt += ev.usage.prompt_tokens || 0; state.ct += ev.usage.completion_tokens || 0;
        state.rt = (state.rt || 0) + (ev.usage.completion_tokens_details?.reasoning_tokens || 0);
      }
      const fr = ev.choices?.[0]?.finish_reason; if (fr) state.finish = String(fr);
      const d = ev.choices?.[0]?.delta;
      if (!d) continue;
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const i = tc.index ?? 0;
          const cur = (state.toolCalls[i] = state.toolCalls[i] || { id: "", name: "", args: "" });
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name = tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
        }
      }
      if (typeof d.content === "string" && d.content) await emit(d.content);
    }
  }
}

/* ===== 관리자 「동작 점검」(REQ-0095) =====
   관리자 콘솔 「모델 설정」의 「점검」이 부른다. 실제 챗봇과 같은 방식(실제 지시문·max_tokens·temperature·TOOLS·400 적응 루프)으로
   시험 질문 1건을 보내 답이 오는지 본다. 도구는 실행하지 않고 개수만 센다. 키 값은 응답·DB·로그 어디에도 담지 않는다(§1.1·§1.8).
   판정은 사실만: 200 이라도 본문 0자·도구 0건이면 「빈 답」(정상 아님 — §16.6). 결과는 화면 안내용이며 pickModel 판정에는 쓰지 않는다. */
const PROBE_USER = "연결 점검입니다. 도구를 부르지 말고 '정상' 한 단어로만 답하세요.";
const SECRET_ENVS = ["OPENAI_API_KEY", "OPENAI_ADMIN_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_ADMIN_KEY"];
const CHECK_MIN_GAP_MS = 20_000;      // 같은 모델 연타 방지(DB last_check_at 기준 — 아이솔레이트 무관)
const CHECK_COST_CAP_USD = 0.10;      // 넉넉한 사전 추정이 이 값을 넘으면 force 없이는 실행하지 않는다

/** 벤더 오류 본문에서 키 값이 되비치지 않게 — env 값 치환 + sk- 형 문자열 마스킹 */
function maskSecrets(s: string): string {
  let t = String(s || "");
  for (const e of SECRET_ENVS) { const v = Deno.env.get(e); if (v && v.length >= 8) t = t.split(v).join("***"); }
  return t.replace(/sk-[A-Za-z0-9_-]{20,}/g, "sk-***");
}

/** 사람이 읽는 한 줄 — 서버가 만든다(화면은 문장을 만들지 않는다) */
function checkNote(status: number, detail: string, shape: OaShape): string {
  if (status === 0) return /timeout|abort/i.test(detail) ? "시간 초과(30초)" : "연결 실패";
  if (status === 400) {
    const p = oaParam(detail);
    if (p === "reasoning_effort") return shape.reasoning === "none"
      ? (/\/v1\/responses/i.test(detail) ? "거부됨: 도구 호출 불가 — Responses API 필요(켜도 답하지 못함)" : "거부됨: reasoning_effort 미지원(벤더 원문 참조)")
      : "거부됨: 도구+추론 조합 미지원(자동 보정 실패)";
    if (p === "temperature") return "거부됨: temperature 미지원(자동 보정 실패)";
    if (p === "max_tokens" || p === "max_completion_tokens") return "거부됨: max_tokens 미지원(자동 보정 실패)";
    if (/model_not_found|does not exist/i.test(detail)) return "거부됨: 모델 없음(이름 확인)";
    if (/insufficient_quota|billing|credit/i.test(detail)) return "거부됨: 결제·크레딧 문제(벤더 콘솔 확인)";
    return "거부됨(400)";
  }
  return status === 401 ? "키 오류(만료/오입력)"
       : status === 403 ? "권한 없음(키·프로젝트 확인)"
       : status === 404 ? "모델 없음(이름 확인)"
       : status === 429 ? (/insufficient_quota|billing/i.test(detail) ? "한도·결제 문제(벤더 콘솔 확인)" : "한도 초과 — 잠시 후 다시")
       : status >= 500 ? `벤더 장애(${status})` : `거부됨(${status})`;
}

// deno-lint-ignore no-explicit-any
async function testModel(admin: any, ai: AiConfig, apiKey: string, upn: string, body: Record<string, unknown>): Promise<Response> {
  try {
    // ① 관리자만 — 채팅과 달리 돈을 쓰는 진단이다
    const { data: pa } = await admin.from("portal_admin").select("email").eq("email", upn).maybeSingle();
    if (!pa) return json({ error: "forbidden: 관리자 전용" }, 403);
    // ② 카탈로그에 있는 모델만(임의 문자열로 벤더를 부르지 않는다)
    const modelId = String(body.model_id || "").trim().slice(0, 80);
    const m = ai.models.find((x) => x.model_id === modelId);
    if (!m) return json({ error: "카탈로그에 없는 모델입니다." }, 400);
    // ③ 운영 챗봇은 OpenAI 만 부른다 — 다른 벤더는 호출 0·기록 0, 사유만
    if (String(m.vendor).toLowerCase() !== "openai") {
      const env = String(m.vendor).toLowerCase() === "anthropic" ? "ANTHROPIC_API_KEY" : "";
      const hasKey = !!(env && Deno.env.get(env));
      return json({ ok: true, result: { model_id: modelId, checked: false, ok: null,
        note: hasKey ? "운영 챗봇은 OpenAI 만 부릅니다 — 이 모델은 부서 에이전트 경로용(에이전트 점검은 후속)" : "키 없음 — 점검 불가" } });
    }
    // ④ 단가 — 비어 있으면 비용을 만들어내지 않는다(§16.6). 상한도 판정할 수 없으므로 force 없이는 실행하지 않는다.
    const price = (Number(m.price_in) || Number(m.price_out)) ? { inp: Number(m.price_in) || 0, out: Number(m.price_out) || 0 } : null;
    if (!price && body.force !== true) {
      return json({ error: "단가가 비어 있어 점검 비용을 추정할 수 없습니다 — 「모델 목록」에 단가를 넣거나, 확인 후 실행하세요.", bound_usd: null, need_force: true }, 409);
    }
    // ⑤ 사전 비용 상한 — 넉넉한 추정(입력 ≈ (지시문+도구 JSON 글자수)/2 토큰, 출력 = max_tokens 전부). 화면에 「예상」으로 쓰지 않는다.
    const bound = price ? ((String(ai.system_prompt).length + TOOLS_JSON_LEN) / 2 + 64) * price.inp / 1e6 + ai.max_tokens * price.out / 1e6 : null;
    if (bound != null && bound > CHECK_COST_CAP_USD && body.force !== true) {
      return json({ error: `이 모델은 점검 1회 비용 상한이 $${bound.toFixed(2)} 입니다 — 확인 후 실행하세요.`, bound_usd: Number(bound.toFixed(4)), need_force: true }, 409);
    }
    // ⑥ 연타 방지 — 호출 **전에** 자리를 선점한다(조건부 갱신). 같은 20초 안의 두 번째 요청은 갱신 0행 → 429.
    //    SQL 80 전이면 갱신이 실패하고(컬럼 없음) 그냥 진행한다 — 기록도 실패해 recorded:false 로 알린다.
    const now = new Date(), cutoff = new Date(now.getTime() - CHECK_MIN_GAP_MS).toISOString();
    const claim = await admin.from("ai_model")
      .update({ last_check_at: now.toISOString(), last_check_ok: null, last_check_status: null, last_check_ms: null, last_check_note: "점검 중(응답 대기)", last_check_by: upn })
      .eq("model_id", modelId).or(`last_check_at.is.null,last_check_at.lt.${cutoff}`).select("model_id");
    if (!claim.error && !(claim.data || []).length) {
      return json({ error: "방금 점검했습니다 — 잠시 뒤 다시 누르세요.", retry_after_s: Math.ceil(CHECK_MIN_GAP_MS / 1000) }, 429);
    }
    // ⑦ 실제 호출 모양 그대로 1라운드. 지난 점검이 실패했던 모델은 화면이 relearn 을 보내 처음부터 다시 배운다.
    if (body.relearn === true) OA_SHAPE.delete(modelId);
    const before = oaShape(modelId);
    const convo = [{ role: "system", content: ai.system_prompt }, { role: "user", content: PROBE_USER }];
    const t0 = Date.now();
    let res: Response | null = null, netErr = "";
    try { res = await callOpenAI(apiKey, modelId, convo, true, ai.max_tokens, ai.temperature, AbortSignal.timeout(30_000)); }
    catch (e) { netErr = e instanceof Error ? (e.name + " " + e.message) : String(e); }
    // ⑧ 판정 — 사실만
    let ok = false, status = 0, note = "", raw = "", full = "", usage: Record<string, unknown> = {};
    if (!res) { status = 0; full = netErr; note = checkNote(0, full, oaShape(modelId)); raw = maskSecrets(full).slice(0, 200); }
    else if (!res.ok || !res.body) {
      status = res.status; full = await res.text().catch(() => "");
      raw = maskSecrets(full).slice(0, 200); note = checkNote(status, full, oaShape(modelId));
    } else {
      status = res.status; let text = "", pumpErr = "";
      const st: PumpState = { pt: 0, ct: 0, rt: 0, finish: null, toolCalls: {} };
      // 30초 신호는 헤더가 온 뒤 본문을 읽는 중에도 발화한다 — 여기서 잡아야 「시간 초과」로 기록된다(500 으로 새지 않게)
      try { await pumpStream(res.body, async (c) => { text += c; }, st); }
      catch (e) { pumpErr = e instanceof Error ? (e.name + " " + e.message) : String(e); }
      const toolN = Object.values(st.toolCalls).filter((c) => c.name).length;
      if (pumpErr) { status = 0; full = pumpErr; note = checkNote(0, full, oaShape(modelId)); raw = maskSecrets(full).slice(0, 200); }
      else {
        ok = text.trim().length > 0 || toolN > 0;
        note = ok ? "정상"
          : (st.finish === "length" && (st.rt || 0) > 0)
            ? `빈 답 — 답 최대 길이 ${ai.max_tokens}토큰을 추론에 모두 사용(추론 토큰 ${st.rt}) → 세부 설정 「답 최대 길이」를 올리세요`
            : `빈 답 — 본문 0자·도구 호출 0건(finish: ${st.finish || "?"})`;
      }
      usage = { pt: st.pt, ct: st.ct, rt: st.rt || 0, finish: st.finish || null, content_len: text.length, tool_calls: toolN,
                cost_usd: price ? Number(((st.pt * price.inp + st.ct * price.out) / 1e6).toFixed(6)) : null };
    }
    const ms = Date.now() - t0;                 // 본문까지 받은 실제 응답 지연(적응 재시도 포함)
    const shape = oaShape(modelId);
    const adjustments = [
      ...(before.temp && !shape.temp ? ["temperature 미전송"] : []),
      ...(before.maxKey !== shape.maxKey ? ["max_completion_tokens 사용"] : []),
      ...(!before.reasoning && shape.reasoning ? ["reasoning_effort none"] : []),
    ];
    const checkedAt = new Date().toISOString();
    const detail = { ...usage, adjustments, param: status === 400 ? oaParam(full) : null, raw: raw || null };
    // ⑨ 기록 — 화면용. active/callable 은 절대 바꾸지 않는다.
    //    400 으로 끝났으면 배운 모양을 메모리·DB 에서 지운다 — 틀린 모양이 콜드스타트 시드로 굳지 않고, 다음 호출이 처음부터 다시 배운다.
    const failed400 = status === 400;
    if (failed400) OA_SHAPE.delete(modelId);
    const { error: ue } = await admin.from("ai_model").update({
      last_check_at: checkedAt, last_check_ok: ok, last_check_status: status, last_check_ms: ms,
      last_check_note: note, last_check_by: upn, last_check_detail: detail, request_shape: failed400 ? null : shape,
    }).eq("model_id", modelId);
    if (ue) console.error("ai_model 점검 기록 실패(SQL 80 미적용?):", ue.message);
    return json({ ok: true, result: { model_id: modelId, checked: true, ok, status, ms, note, shape: failed400 ? null : shape, adjustments, detail, checked_at: checkedAt, recorded: !ue } });
  } catch (e) {
    return json({ error: "점검 실패: " + maskSecrets(e instanceof Error ? e.message : String(e)).slice(0, 200) }, 500);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) return json({ error: "서버 미설정: OPENAI_API_KEY 시크릿이 등록되지 않았습니다." }, 503);

  // 1) 사내 사용자 검증 (Entra 토큰 → Graph)
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "unauthorized: MS 로그인 토큰이 필요합니다." }, 401);
  const user = await verifyEntraUser(token);
  if (!user) return json({ error: "unauthorized: 사내(@jeilm.co.kr) 계정 인증 실패 — 다시 로그인하세요." }, 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // 1-b) 사용모델 설정 로드(관리자 콘솔 › 모델 설정 SSOT). 조회 실패 시 안전 폴백(기존 하드코딩값).
  const ai = await loadAiConfig(admin);

  // 2) 입력 검증 (상한은 DB 설정값 사용)
  let body: { messages?: Array<{ role: string; content: string }>; session_id?: unknown; work_id?: unknown; save?: unknown; action?: unknown; model_id?: unknown; force?: unknown; relearn?: unknown };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }

  // 1-c) 관리자 콘솔 「동작 점검」(REQ-0095) — 실제 호출 코드(callOpenAI·TOOLS·지시문·적응 루프)를 그대로 한 번 태운다.
  //      채팅 경로(action 없음)는 아래 그대로. 모르는 action 은 조용히 채팅으로 흘리지 않는다.
  if (body.action === "test_model") return await testModel(admin, ai, apiKey, user.upn, body as Record<string, unknown>);
  if (body.action !== undefined) return json({ error: "알 수 없는 action" }, 400);
  const raw = Array.isArray(body.messages) ? body.messages : [];
  const messages = raw
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-ai.max_messages)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MSG_CHARS) }));
  if (!messages.length) return json({ error: "messages가 비어 있습니다." }, 400);
  const total = messages.reduce((n, m) => n + m.content.length, 0);
  if (total > ai.max_total_chars) return json({ error: "대화가 너무 깁니다. 새 대화로 시작하세요." }, 400);

  // 2-b) 모델 라우팅 — 마지막 사용자 메시지 기준. 라우팅 규칙 미매칭 시 기본 모델(설정값).
  const lastUserText = [...messages].reverse().find((m) => m.role === "user")?.content || "";
  const model = pickModel(lastUserText, ai);

  // 2-c) ERP Tool 접근 범위(부서별 erp_scope) — 관리자는 전 모듈, 그 외 소속 부서 허용 모듈만
  const erpScope = await resolveErpScope(admin, user.upn);

  // 2-d) 대화 저장 세션 확정 — opt-in(세 필드 모두 없으면 저장 없이 기존 동작).
  //      v25 팀 공유: 접근 판정을 DB RPC(chat_session_access/chat_work_access)로 일원화 —
  //      본인 세션 또는 공유 work(소유자·팀원)의 세션이면 이어쓰기 허용. 발화자 upn은 본인으로 기록.
  //      원문 저장 정책(ADR-009 개정): 열람·삭제는 jeil-chat-history. 킬스위치 chat_save_enabled.
  let sessionId: string | null = null;
  let sessionWork: { id: string; name: string; memo: string | null } | null = null;
  let sessionTitle: string | null = null;
  if (ai.chat_save_enabled) {
    if (isUuid(body.session_id)) {
      const acc = await admin.rpc("chat_session_access", { p_session: body.session_id, p_upn: user.upn });
      if (acc.data !== true) return json({ error: "대화를 찾을 수 없습니다. 새 대화로 시작하세요." }, 404);
      const { data: s } = await admin.from("chat_session")
        .select("id,work_id,title,message_count")
        .eq("id", body.session_id).is("deleted_at", null).maybeSingle();
      if (!s) return json({ error: "대화를 찾을 수 없습니다. 새 대화로 시작하세요." }, 404);
      if (Number(s.message_count) >= ai.session_max_messages) {
        return json({ error: "이 대화가 너무 길어졌습니다. 새 대화로 시작하세요." }, 400);
      }
      sessionId = s.id; sessionTitle = s.title;
      if (s.work_id) {
        // 접근은 세션 판정으로 이미 성립 — work 컨텍스트(메모)는 공유 팀원에게도 동일 주입
        const { data: w } = await admin.from("chat_work").select("id,name,memo")
          .eq("id", s.work_id).is("deleted_at", null).maybeSingle();
        if (w) sessionWork = w;
      }
    } else if (isUuid(body.work_id) || body.save === true) {
      let workId: string | null = null;
      if (isUuid(body.work_id)) {
        const acc = await admin.rpc("chat_work_access", { p_work: body.work_id, p_upn: user.upn });
        if (acc.data !== true) return json({ error: "작업 폴더를 찾을 수 없습니다." }, 404);
        const { data: w } = await admin.from("chat_work").select("id,name,memo")
          .eq("id", body.work_id).is("deleted_at", null).maybeSingle();
        if (!w) return json({ error: "작업 폴더를 찾을 수 없습니다." }, 404);
        sessionWork = w; workId = w.id;
      }
      try {
        const { data: ns } = await admin.from("chat_session")
          .insert({ upn: user.upn, work_id: workId }).select("id").single();
        sessionId = ns?.id ?? null;
      } catch { sessionId = null; /* 세션 생성 실패가 챗 자체를 막지 않는다 */ }
    }
  }

  // 3) 감사 로그 선기록 (스트림 종료 후 토큰·비용·도구 갱신)
  let logId: number | null = null;
  try {
    const { data } = await admin.from("chat_log")
      .insert({ upn: user.upn, model, messages_count: messages.length, prompt_chars: total, session_id: sessionId })
      .select("id").single();
    logId = data?.id ?? null;
  } catch { /* 로그 실패는 무시 */ }

  // 3-b) 사용자 메시지 저장 — 마지막 user 1건만(클라이언트가 히스토리 전체를 보내므로 중복 방지). seq는 RPC 원자 채번.
  let userSeq: number | null = null;
  if (sessionId) {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (lastUser) {
      if (!sessionTitle) sessionTitle = lastUser.content.replace(/\s+/g, " ").slice(0, 60);
      try {
        const { data: seq } = await admin.rpc("chat_append_message", {
          p_session: sessionId, p_upn: user.upn, p_role: "user", p_content: lastUser.content,
          p_views: null, p_model: null, p_stopped: false, p_log_id: logId,
        });
        userSeq = typeof seq === "number" ? seq : null;
      } catch { /* 저장 실패는 무시 */ }
    }
  }

  // 4) 스트리밍 응답 (도구 호출 시 상한 멀티라운드: 라운드마다 도구 수집→실행→누적, 마지막 라운드는 도구 없이 최종답변)
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  // 중지 이중 감지: (A) req.signal — 런타임의 disconnect 발화가 문서상 미보장이라 방어적,
  //                (B) writer.write 실패 — readable cancel(클라이언트 disconnect)의 신뢰 신호.
  // 어느 쪽이든 upstream(OpenAI) fetch를 abort해 불필요한 토큰 소비를 즉시 중단한다.
  const upstream = new AbortController();
  let clientGone = false;
  const onGone = () => { clientGone = true; try { upstream.abort(); } catch { /* 무시 */ } };
  try { req.signal?.addEventListener("abort", onGone); } catch { /* 무시 */ }
  let assistantText = "";                                 // 저장용 본문 누적(중지 시 부분 응답 포함)
  const emit = (c: string) => {
    assistantText += c;
    return writer.write(enc.encode("data: " + JSON.stringify({ choices: [{ delta: { content: c } }] }) + "\n\n"))
      .catch((e: unknown) => { onGone(); throw e; });
  };

  const run = (async () => {
    const state: PumpState = { pt: 0, ct: 0, toolCalls: {} };
    const toolsUsed: string[] = [];
    const viewsSaved: unknown[] = [];                     // 저장용 구조화 뷰 누적(복원 시 카드 재현)
    let stopped = false;
    try {
      // 세션 메타 선송출 — 프론트가 새 세션 id·제목을 사이드바에 반영(구버전 프론트는 미지의 키라 무시)
      if (sessionId) {
        try {
          await writer.write(enc.encode("data: " + JSON.stringify({
            jeilax_meta: { session_id: sessionId, work_id: sessionWork?.id ?? null, title: sessionTitle, seq: userSeq },
          }) + "\n\n"));
        } catch { onGone(); }
      }
      // work 컨텍스트 주입(관리자 설정: work_context_mode·work_context_max_chars) — work 소속 세션만.
      // work 대화의 히스토리 턴수는 work_history_turns 적용(메모가 맥락을 보완하므로 축약 허용).
      const workCtx = ai.work_context_mode !== "off" && sessionWork && sessionWork.memo
        ? `[작업 컨텍스트: ${sessionWork.name}]\n${String(sessionWork.memo).slice(0, ai.work_context_max_chars)}\n(위는 이 작업 폴더의 배경 정보입니다. 이 대화의 답변에 참고하세요.)`
        : null;
      const histMsgs = workCtx && ai.work_history_turns > 0 ? messages.slice(-ai.work_history_turns * 2) : messages;
      // 도구 호출 상한 멀티라운드 — 리다이렉트형(도구가 다른 도구를 안내)·순차의존형 복합질문 대응.
      // 무한루프 3중 차단: MAX_ROUNDS 상한 + 직전 라운드와 동일 호출 반복 시 중단 + 마지막 라운드 강제 withTools=false.
      const convo: unknown[] = [
        { role: "system", content: ai.system_prompt },
        ...(workCtx ? [{ role: "system", content: workCtx }] : []),
        ...histMsgs,
      ];
      const MAX_ROUNDS = 4;
      let lastSig = "";
      for (let round = 0; round < MAX_ROUNDS; round++) {
        if (clientGone) { stopped = true; break; }        // 중지 감지 시 다음 라운드 진입 차단
        const lastRound = round === MAX_ROUNDS - 1;
        state.toolCalls = {};
        const res = await callOpenAI(apiKey, model, convo, !lastRound, ai.max_tokens, ai.temperature, upstream.signal);
        if (!res.ok || !res.body) {
          const detail = await res.text().catch(() => "");
          console.error("openai error", res.status, detail.slice(0, 500));
          await emit(res.status === 401 ? "⚠ OpenAI 키가 유효하지 않습니다(만료/오입력)."
            : res.status === 429 ? "⚠ OpenAI 사용량 한도 초과 — 잠시 후 다시 시도하세요."
            : res.status === 400 ? "⚠ 모델 " + model + " 이(가) 이 요청 형식을 받지 않습니다" + (oaParam(detail) ? "(사유: " + oaParam(detail) + ")" : "") + " — 관리자에게 알려 주세요. 관리자 콘솔 「모델 설정」의 「점검」으로 원인을 확인할 수 있습니다."
            : "⚠ AI 응답 생성에 실패했습니다.");
          break;
        }
        await pumpStream(res.body, emit, state);
        const calls = Object.values(state.toolCalls).filter((c) => c.name);
        if (!calls.length) break;                          // 도구 없이 최종답변 완료 → 종료
        const sig = calls.map((c) => c.name + ":" + c.args).sort().join("|");
        if (sig === lastSig) break;                        // 직전과 동일 호출 반복 → 무한루프 차단
        lastSig = sig;
        convo.push({
          role: "assistant", content: null,
          tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args || "{}" } })),
        });
        for (const c of calls) {
          toolsUsed.push(c.name);
          let result: unknown;
          try { result = await runTool(admin, c.name, c.args, erpScope, token); }
          catch (e) { result = { 오류: "조회 실패: " + (e instanceof Error ? e.message : String(e)) }; }
          // P2: 구조화 뷰 분리 송출 — 프론트 카드 렌더용(모델에는 미전달·토큰 0, 구버전 프론트는 무시).
          //     뷰는 부가 기능 — 실패해도 본문 스트림·모델 응답에 영향을 주지 않는다.
          try {
            const ro = result as Record<string, unknown> | null;
            const view = ro && typeof ro === "object" ? ro.__view : null;
            if (ro && view) {
              delete ro.__view;
              // 저장용 누적(복원 시 카드 재현) — 메시지당 8개·직렬화 64KB 상한
              if (viewsSaved.length < 8 && JSON.stringify(viewsSaved).length < 64000) viewsSaved.push(view);
              const payload = JSON.stringify({ jeilax: view });
              if (payload.length <= 16000) await writer.write(enc.encode("data: " + payload + "\n\n")).catch(() => onGone());
            }
          } catch { /* 무시 */ }
          convo.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(result).slice(0, 12000) });
        }
      }
    } catch (e) {
      // 사용자 중지(클라이언트 abort)는 오류가 아니라 정상 종료로 분류 — 오류 문구를 내보내지 않는다.
      if (clientGone || (e instanceof Error && e.name === "AbortError")) {
        stopped = true;
      } else {
        try { await emit("⚠ 오류: " + (e instanceof Error ? e.message : String(e))); } catch { /* 스트림 종료됨 */ }
      }
    } finally {
      try { req.signal?.removeEventListener("abort", onGone); } catch { /* 무시 */ }
      try { await writer.write(enc.encode("data: [DONE]\n\n")); } catch { /* 무시 */ }
      try { await writer.close(); } catch { /* 무시 */ }
      // U-1: 토큰·추정비용·사용도구 갱신 — 중지로 usage 미수신 시 보수적 추정(문자수/3)
      if (logId != null) {
        const price = priceFor(model, ai);
        let pt = state.pt, ct = state.ct;
        if (stopped && !pt && !ct) { pt = Math.ceil(total / 3); ct = Math.ceil(assistantText.length / 3); }
        const cost = (pt * price.inp + ct * price.out) / 1_000_000;
        try {
          await admin.from("chat_log").update({
            prompt_tokens: pt || null, completion_tokens: ct || null,
            est_cost_usd: pt || ct ? Number(cost.toFixed(6)) : null,
            tools_used: toolsUsed.length ? toolsUsed : null,
            stopped,
          }).eq("id", logId);
        } catch { /* 무시 */ }
      }
      // 어시스턴트 응답 저장(중지 시 부분 응답 포함) — EdgeRuntime.waitUntil이 응답 반환 후 완료 보장
      if (sessionId && (assistantText || viewsSaved.length)) {
        try {
          await admin.rpc("chat_append_message", {
            p_session: sessionId, p_upn: user.upn, p_role: "assistant",
            p_content: assistantText || "(뷰 응답)",
            p_views: viewsSaved.length ? viewsSaved : null,
            p_model: model, p_stopped: stopped, p_log_id: logId,
          });
        } catch { /* 저장 실패는 무시 */ }
      }
    }
  })();
  // @ts-ignore: Supabase Edge Runtime — 응답 반환 후에도 로그 갱신 완료 보장
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) EdgeRuntime.waitUntil(run);

  return new Response(readable, {
    headers: { ...cors, "Content-Type": "text/event-stream", "x-model": model },
  });
});
