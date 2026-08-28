/**
 * Inventory 前端展示工具（Sprint 7，展示层，非后端事实源）：
 * - 分类 / 流水类型 / 领用目的地展示元数据
 * - 低库存状态计算（与后端 §19 规则一致，仅用于展示与测试锁定）
 */

import type {
  IssueDestinationType,
  ItemCategory,
  MovementType,
  StockStatus,
} from "@/lib/api/types";
import type { StatusMeta } from "@/lib/status";

export const ITEM_CATEGORY_LABELS: Record<ItemCategory, string> = {
  GUEST_AMENITY: "客用品",
  LINEN: "布草",
  CLEANING: "清洁用品",
  FRONT_DESK: "前台用品",
  MAINTENANCE: "维修耗材",
  OFFICE: "办公用品",
  OTHER: "其他",
};

export const ITEM_CATEGORIES = Object.keys(
  ITEM_CATEGORY_LABELS,
) as ItemCategory[];

export const MOVEMENT_TYPE_META: Record<MovementType, StatusMeta> = {
  INITIAL: {
    label: "期初库存",
    badge: "bg-slate-100 text-slate-700 ring-slate-300",
  },
  PURCHASE_RECEIPT: {
    label: "采购收货",
    badge: "bg-emerald-100 text-emerald-800 ring-emerald-300",
  },
  ISSUE: {
    label: "领用出库",
    badge: "bg-orange-100 text-orange-800 ring-orange-300",
  },
  RETURN: {
    label: "归还入库",
    badge: "bg-sky-100 text-sky-800 ring-sky-300",
  },
  TRANSFER_OUT: {
    label: "调拨出库",
    badge: "bg-amber-100 text-amber-800 ring-amber-300",
  },
  TRANSFER_IN: {
    label: "调拨入库",
    badge: "bg-teal-100 text-teal-800 ring-teal-300",
  },
  ADJUSTMENT_IN: {
    label: "盘盈调整",
    badge: "bg-lime-100 text-lime-800 ring-lime-300",
  },
  ADJUSTMENT_OUT: {
    label: "盘亏调整",
    badge: "bg-rose-100 text-rose-800 ring-rose-300",
  },
};

export const ISSUE_DESTINATION_LABELS: Record<IssueDestinationType, string> = {
  HOUSEKEEPING: "保洁间",
  FRONT_DESK: "前台",
  MAINTENANCE: "维修间",
  ROOM: "房间",
  OTHER: "其他",
};

export const ISSUE_DESTINATIONS = Object.keys(
  ISSUE_DESTINATION_LABELS,
) as IssueDestinationType[];

export const STOCK_STATUS_META: Record<StockStatus, StatusMeta> = {
  NORMAL: {
    label: "正常",
    badge: "bg-emerald-100 text-emerald-800 ring-emerald-300",
  },
  LOW_STOCK: {
    label: "低库存",
    badge: "bg-amber-100 text-amber-800 ring-amber-300",
  },
  OUT_OF_STOCK: {
    label: "缺货",
    badge: "bg-red-100 text-red-800 ring-red-300",
  },
};

/**
 * 低库存状态计算（Sprint 7 §19，与后端 stock_status_for 一致）：
 * total == 0 -> OUT_OF_STOCK；
 * minimum > 0 且 total <= minimum -> LOW_STOCK；
 * 否则 NORMAL（minimum = 0 时只有 0 是 OUT_OF_STOCK，正库存保持 NORMAL）。
 */
export function computeStockStatus(
  totalStock: number,
  minimumStock: number,
): StockStatus {
  if (totalStock <= 0) return "OUT_OF_STOCK";
  if (minimumStock > 0 && totalStock <= minimumStock) return "LOW_STOCK";
  return "NORMAL";
}

/** 建议补货量 = max(target - total, 0)（§21，仅建议值，不自动创建申请/订单） */
export function recommendedReplenishment(
  targetStock: number,
  totalStock: number,
): number {
  return Math.max(targetStock - totalStock, 0);
}

/** 数量字符串（后端 Decimal 序列化）-> number（展示/计算用） */
export function qty(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  return typeof value === "number" ? value : parseFloat(value) || 0;
}

/** 数量展示：去掉多余小数尾零（如 "10.00" -> "10"） */
export function fmtQty(value: string | number | null | undefined): string {
  const n = qty(value);
  return Number.isInteger(n) ? String(n) : String(parseFloat(n.toFixed(2)));
}
