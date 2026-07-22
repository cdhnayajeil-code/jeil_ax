// jeil-chat — 사내 AI 챗봇 게이트웨이 (OpenAI 프록시 + 포털DB 조회 도구 + 토큰·비용 기록)
// 배포: verify_jwt=false (Entra 토큰은 Supabase JWT가 아니므로 내부에서 직접 검증)
// 호출: POST /functions/v1/jeil-chat  Authorization: Bearer <Entra access_token(User.Read)>
//   body: { messages: [{role,content},...], session_id?, work_id?, save? } — 세션 필드는 대화 저장 opt-in(없으면 구버전과 동일 동작)
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
  payroll: "급여·인사", user_dept: "사용자·부서",
};

type ErpScope = { upn: string; isAdmin: boolean; modules: Set<string>; dept: string | null; empNm: string | null };
// 호출자 UPN → 허용 ERP 모듈 판정 (관리자=전 모듈, 그 외=소속 부서 dept_erp_scope)
// deno-lint-ignore no-explicit-any
async function resolveErpScope(admin: any, upn: string): Promise<ErpScope> {
  const [{ data: pa }, { data: ud }] = await Promise.all([
    admin.from("portal_admin").select("email").eq("email", upn).maybeSingle(),
    admin.from("v_erp_user_dept").select("dept_nm,emp_nm").eq("email", upn).maybeSingle(),
  ]);
  const dept: string | null = ud?.dept_nm ?? null;
  const empNm: string | null = ud?.emp_nm ?? null;
  if (pa) return { upn, isAdmin: true, modules: new Set(), dept, empNm };
  const { data: es } = await admin.from("dept_erp_scope").select("module_key").eq("dept_nm", dept || "");
  return { upn, isAdmin: false, modules: new Set((es || []).map((r: { module_key: string }) => r.module_key)), dept, empNm };
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
    const [cfgR, modR, rulR] = await Promise.all([
      admin.from("ai_gateway_config").select("*").eq("id", 1).maybeSingle(),
      admin.from("ai_model").select("model_id,vendor,active,callable,price_in,price_out"),
      admin.from("ai_routing_rule").select("seq,rule_type,match_keywords,min_chars,model_id,active").eq("active", true).order("seq"),
    ]);
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
        request: { module: erpMod, moduleKo: modKo, dept },
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
      __view: { view: "record", title: `재고 입출고 — ${code || "전체(최근 31일)"}`, asOf,
        fields: [
          { k: "품목수", v: comma(items.size) },
          { k: "출고합계", v: comma(outq) },
          { k: "입고합계", v: `${comma(inq)} (미적재)` },
          { k: "표본행수", v: comma(rows.length) },
        ], note: "입고량·재고량은 중간DB 미적재 — 실적으로 단정 금지" } satisfies ViewPayload };
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
      __view: (구매요청.length || 발주.length) ? view : undefined,
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
    // 본인 권한만(호출자 UPN 고정 — 모델이 타인 UPN을 지정할 수 없음). 판정 기준은 jeil-me와 동일.
    const [{ data: da }, { data: pageRows }] = await Promise.all([
      admin.from("dept_permission").select("dept_nm").eq("dept_admin_email", scope.upn),
      admin.from("portal_page").select("*").eq("active", true).order("sort"),
    ]);
    const deptAdminOf: string[] = (da || []).map((r: { dept_nm: string }) => r.dept_nm);
    const role = scope.isAdmin ? "관리자(전권)" : (deptAdminOf.length ? "부서관리자" : "일반 사용자");
    const modules = scope.isAdmin
      ? Object.keys(MODULE_KO)
      : [...scope.modules];
    const daSet = new Set(deptAdminOf);
    // deno-lint-ignore no-explicit-any
    const pages = (pageRows || []).map((p: any) => {
      const vis = String(p.visibility || ""); const owner = String(p.dept_nm || "");
      const shared: string[] = p.shared_depts || [];
      let ok: boolean;
      if (scope.isAdmin) ok = true;
      else if (vis === "전사 공개") ok = true;
      else if (vis === "부서 전용") ok = (!!scope.dept && scope.dept === owner) || daSet.has(owner);
      else if (vis === "지정 부서 공유") ok = (!!scope.dept && (scope.dept === owner || shared.includes(scope.dept))) || daSet.has(owner);
      else ok = false;
      if (ok && p.erp_module && !scope.isAdmin) ok = scope.modules.has(String(p.erp_module));
      return { 페이지: p.title, 담당부서: p.dept_nm, 공개범위: p.visibility, 접근가능: ok, 경로: String(p.path || "") };
    });
    // deno-lint-ignore no-explicit-any
    const okPages = pages.filter((p: any) => p.접근가능);
    // deno-lint-ignore no-explicit-any
    const noPages = pages.filter((p: any) => !p.접근가능);
    // 계정 표기 규약: '부서_이름_아이디'
    const 계정표기 = `${scope.dept || "미매핑"}_${scope.empNm || "-"}_${scope.upn}`;
    return {
      기준시각: asOf, 계정: 계정표기, 이름: scope.empNm || "-", 소속부서: scope.dept || "미매핑",
      역할: role, 관리자여부: scope.isAdmin, 부서관리자_담당부서: deptAdminOf,
      열람가능_ERP모듈: modules.map((m) => `${MODULE_KO[m] || m}(${m})`),
      // deno-lint-ignore no-explicit-any
      접근가능_페이지: okPages.map((p: any) => p.페이지),
      // deno-lint-ignore no-explicit-any
      접근불가_페이지: noPages.map((p: any) => ({ 페이지: p.페이지, 담당부서: p.담당부서, 공개범위: p.공개범위 })),
      __view: { view: "record", title: "내 포털 권한", asOf,
        fields: [
          { k: "계정", v: 계정표기 },
          { k: "소속부서", v: scope.dept || "미매핑" },
          { k: "역할", v: role },
          { k: "ERP 모듈", v: modules.length ? modules.map((m) => MODULE_KO[m] || m).join(" · ") : "없음" },
          { k: "운영페이지", v: `접근가능 ${okPages.length} / 전체 ${pages.length}` },
          ...(deptAdminOf.length ? [{ k: "부서관리자", v: deptAdminOf.join(", ") }] : []),
        ],
        // 접근 가능한 운영페이지 바로가기(상위 3) — 실제 열람 차단은 각 페이지 게이트(jeil-me)가 재판정
        // deno-lint-ignore no-explicit-any
        actions: okPages.filter((p: any) => p.경로).slice(0, 3)
          // deno-lint-ignore no-explicit-any
          .map((p: any) => ({ kind: "link", label: String(p.페이지), url: String(p.경로) })) } satisfies ViewPayload,
      권한요청방법: scope.isAdmin
        ? "관리자(전권) 계정이므로 별도 권한 요청이 필요 없습니다. 타 사용자 권한 부여는 관리자 콘솔 › 사용자·부서에서 직접 수행하세요."
        : "필요한 데이터 모듈·페이지를 지정해 포털 관리자에게 요청하세요(관리자 콘솔 › 사용자·부서 › 부서별 ERP 모듈 권한에서 부여). 급여·인사 데이터는 인사팀 소속 또는 관리자만 가능합니다.",
      안내: "본인 권한만 조회됩니다(타인 권한 조회 불가). 판정 기준: 관리자(portal_admin) › 부서관리자(dept_permission) › 소속부서 ERP 모듈(dept_erp_scope) + 페이지 공개범위(portal_page).",
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
          request: { module: "payroll", moduleKo: "급여·인사", dept: scope.dept || "미지정" },
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
    if (!rows.length) return { 기준시각: asOf, 조건: ymF || "전체", 건수: 0,
      안내: "해당 기간 인사 집계 데이터가 없습니다. 현재 중간DB 적재 범위를 확인하세요(2026년 이후 월별 적재)." };
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

  /* ===== 3단계 문서 도구 (사용자 위임 토큰 · OneDrive/SharePoint 보안 트리밍) ===== */
  if (name === "search_my_documents") {
    const q = String(args.query || "").trim();
    if (!q) return { 오류: "검색어(query)가 필요합니다." };
    const size = Math.min(Math.max(Number(args.limit) || 8, 1), 15);
    // 화이트리스트(§8): 승인 컨테이너로만 제한. 미설정이면 fail-closed(전 문서 노출 방지).
    const docScope = await loadDocScope(admin);
    if (!docScope) return { 오류: "문서 연동 범위 미설정",
      안내: "AI 문서 연동 범위(승인 프로젝트 폴더)가 설정되지 않아 검색을 제공하지 않습니다. 관리자에게 범위 등록을 요청하세요.",
      __view: { view: "notice", title: "문서 연동 범위 미설정", kind: "info",
        text: "AI 문서 연동 범위(승인 프로젝트 폴더)가 설정되지 않아 검색을 제공하지 않습니다. 관리자에게 범위 등록을 요청하세요." } satisfies ViewPayload };
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
          note: "AI 승인 범위 ∩ 본인 권한 문서만" } satisfies ViewPayload };
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
    if (!docScope.some((s) => s.driveId === driveId)) return { 오류: "범위 밖 문서",
      안내: "이 문서는 AI 연동 승인 범위(프로젝트 폴더)에 없어 열람할 수 없습니다. search_my_documents로 승인 범위 내 문서를 찾으세요." };
    const base = `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}`;
    try {
      const meta = await graphGet(userToken, `${base}?$select=name,size,file,webUrl,lastModifiedDateTime`);
      // 2차 게이트: 폴더 레벨 경로 검증(승인 폴더 하위인지) — 같은 라이브러리라도 범위 밖 폴더면 차단
      if (!inScope(docScope, driveId, String(meta.webUrl || ""))) return { 오류: "범위 밖 폴더",
        안내: "이 문서는 승인된 AI 연동 폴더 하위가 아니어서 열람할 수 없습니다. search_my_documents로 승인 범위 내 문서를 찾으세요." };
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
function callOpenAI(apiKey: string, model: string, messages: unknown[], withTools: boolean, maxTokens: number, temperature: number, signal?: AbortSignal) {
  return fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    signal,                                               // 중지 전파 — 클라이언트 disconnect 시 업스트림 소비 중단
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model, stream: true, max_tokens: maxTokens, temperature, messages,
      stream_options: { include_usage: true },            // U-1: 토큰 usage 수신
      ...(withTools ? { tools: TOOLS } : {}),
    }),
  });
}

type ToolCallAcc = { id: string; name: string; args: string };
type PumpState = { pt: number; ct: number; toolCalls: Record<number, ToolCallAcc> };

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
      if (ev.usage) { state.pt += ev.usage.prompt_tokens || 0; state.ct += ev.usage.completion_tokens || 0; }
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
  let body: { messages?: Array<{ role: string; content: string }>; session_id?: unknown; work_id?: unknown; save?: unknown };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
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
