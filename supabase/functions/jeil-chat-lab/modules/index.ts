// 자동 생성(_port_modules.py) — 모듈 등록 목록. 새 모듈은 META 에 한 줄 + 모듈 파일.
import type { ToolModule } from "../core/types.ts";
import * as m0 from "./portal/get_order_summary.ts";
import * as m1 from "./portal/get_order_detail.ts";
import * as m2 from "./portal/get_inspection_pending.ts";
import * as m3 from "./sales/get_erp_sales_monthly.ts";
import * as m4 from "./purchase/get_erp_purchase_monthly.ts";
import * as m5 from "./inventory/get_erp_inventory_status.ts";
import * as m6 from "./item/get_erp_item.ts";
import * as m7 from "./purchase/get_erp_item_orders.ts";
import * as m8 from "./purchase/get_erp_pur_order.ts";
import * as m9 from "./purchase/get_erp_po_pr.ts";
import * as m10 from "./purchase/get_erp_pur_top.ts";
import * as m11 from "./purchase/get_erp_receipt_pending.ts";
import * as m12 from "./purchase/get_erp_pur_req.ts";
import * as m13 from "./common/get_my_access.ts";
import * as m14 from "./hr/get_hr_headcount.ts";
import * as m15 from "./hr/get_hr_payroll.ts";
import * as m16 from "./common/get_my_requests.ts";
import * as m17 from "./docs/search_my_documents.ts";
import * as m18 from "./docs/read_document.ts";
import * as m19 from "./regulation/search_regulation.ts";
import * as m20 from "./regulation/get_regulation.ts";

export const MODULES: ToolModule[] = [m0, m1, m2, m3, m4, m5, m6, m7, m8, m9, m10, m11, m12, m13, m14, m15, m16, m17, m18, m19, m20];
