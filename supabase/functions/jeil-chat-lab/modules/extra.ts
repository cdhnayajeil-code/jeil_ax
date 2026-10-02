// modules/extra.ts — 손으로 쓴 모듈 등록 목록(부서 에이전트 · REQ-0087).
// modules/index.ts 는 _port_modules.py 가 운영 jeil-chat 에서 **자동 생성**하므로 손대지 않는다 — 새 모듈은 여기에 한 줄.
import type { ToolModule } from "../core/types.ts";
import * as searchPurList from "./purchase/search_pur_list.ts";
import * as vendorPurchase from "./purchase/get_vendor_purchase.ts";
import * as purProposal from "./purchase/get_pur_proposal.ts";
import * as proposalRecon from "./purchase/get_proposal_recon.ts";
import * as vendorProfile from "./purchase/get_vendor_profile.ts";
import * as proposalChain from "./purchase/get_proposal_chain.ts";
// 사내 NAS 실시간 조회(REQ-0103 · 도메인 "nas" — 에이전트 버전에서 켜야 쓰인다)
import * as nasFiles from "./nas/list_company_files.ts";
import * as nasPastChats from "./nas/search_my_past_chats.ts";
import * as nasDocSearch from "./nas/search_company_docs.ts";   // 문서 내용 검색(REQ-0104 · D-95)
import * as nasDocRead from "./nas/read_company_doc.ts";

export const EXTRA_MODULES: ToolModule[] = [searchPurList, vendorPurchase, purProposal, proposalRecon, vendorProfile, proposalChain,
  nasFiles, nasPastChats, nasDocSearch, nasDocRead];
