/**
 * Procurement 前端展示工具（Sprint 7，展示层，非后端状态机事实源）：
 * - 采购申请 / 采购订单状态元数据（按钮显隐按 status 值 + 权限，
 *   前端不复制后端状态机；非法转换由后端 409 裁决）
 */

import type {
  PurchaseOrderStatus,
  PurchaseRequestStatus,
} from "@/lib/api/types";
import type { StatusMeta } from "@/lib/status";

export const PR_STATUS_META: Record<PurchaseRequestStatus, StatusMeta> = {
  DRAFT: {
    label: "草稿",
    badge: "bg-slate-100 text-slate-700 ring-slate-300",
  },
  SUBMITTED: {
    label: "待审批",
    badge: "bg-amber-100 text-amber-800 ring-amber-300",
  },
  APPROVED: {
    label: "已批准",
    badge: "bg-sky-100 text-sky-800 ring-sky-300",
  },
  ORDERED: {
    label: "已下单",
    badge: "bg-violet-100 text-violet-800 ring-violet-300",
  },
  REJECTED: {
    label: "已驳回",
    badge: "bg-red-100 text-red-800 ring-red-300",
  },
  CANCELLED: {
    label: "已取消",
    badge: "bg-slate-200 text-slate-700 ring-slate-400",
  },
};

export const PO_STATUS_META: Record<PurchaseOrderStatus, StatusMeta> = {
  DRAFT: {
    label: "草稿",
    badge: "bg-slate-100 text-slate-700 ring-slate-300",
  },
  ORDERED: {
    label: "已下达",
    badge: "bg-blue-100 text-blue-800 ring-blue-300",
  },
  PARTIALLY_RECEIVED: {
    label: "部分收货",
    badge: "bg-amber-100 text-amber-800 ring-amber-300",
  },
  RECEIVED: {
    label: "已收货",
    badge: "bg-emerald-100 text-emerald-800 ring-emerald-300",
  },
  CANCELLED: {
    label: "已取消",
    badge: "bg-slate-200 text-slate-700 ring-slate-400",
  },
};

export const PR_STATUSES = Object.keys(
  PR_STATUS_META,
) as PurchaseRequestStatus[];

export const PO_STATUSES = Object.keys(
  PO_STATUS_META,
) as PurchaseOrderStatus[];
