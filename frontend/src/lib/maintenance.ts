/**
 * Maintenance 前端展示工具（Sprint 5，展示层，非后端状态机事实源）：
 * - 工单状态 / 分类 / 严重度 / 来源展示元数据（标签 + 徽标颜色）
 * - Active Blocking 状态集合（与后端 BLOCKING_STATUSES 一致，仅用于展示）
 */

import type {
  MaintenanceCategory,
  MaintenanceSeverity,
  MaintenanceSource,
  MaintenanceWorkOrderStatus,
} from "@/lib/api/types";
import type { StatusMeta } from "@/lib/status";

export const MWO_STATUS_META: Record<MaintenanceWorkOrderStatus, StatusMeta> = {
  OPEN: { label: "待处理", badge: "bg-amber-100 text-amber-800 ring-amber-300" },
  ASSIGNED: {
    label: "已派工",
    badge: "bg-sky-100 text-sky-800 ring-sky-300",
  },
  IN_PROGRESS: {
    label: "维修中",
    badge: "bg-blue-100 text-blue-800 ring-blue-300",
  },
  RESOLVED: {
    label: "待验收",
    badge: "bg-violet-100 text-violet-800 ring-violet-300",
  },
  COMPLETED: {
    label: "已完成",
    badge: "bg-emerald-100 text-emerald-800 ring-emerald-300",
  },
  CANCELLED: {
    label: "已取消",
    badge: "bg-slate-200 text-slate-700 ring-slate-400",
  },
};

export const MWO_CATEGORY_LABELS: Record<MaintenanceCategory, string> = {
  ELECTRICAL: "电气",
  PLUMBING: "给排水",
  HVAC: "空调",
  LOCK: "门锁",
  BATHROOM: "卫生间",
  FURNITURE: "家具",
  APPLIANCE: "电器",
  NETWORK: "网络",
  FINISHING: "装修",
  OTHER: "其它",
};

export const MWO_SEVERITY_META: Record<MaintenanceSeverity, StatusMeta> = {
  LOW: { label: "低", badge: "bg-slate-100 text-slate-700 ring-slate-300" },
  MEDIUM: { label: "中", badge: "bg-amber-100 text-amber-800 ring-amber-300" },
  HIGH: { label: "高", badge: "bg-orange-100 text-orange-800 ring-orange-300" },
  CRITICAL: { label: "紧急", badge: "bg-red-100 text-red-700 ring-red-300" },
};

export const MWO_SOURCE_LABELS: Record<MaintenanceSource, string> = {
  MANUAL: "手动报修",
  FRONT_DESK: "前台报修",
  HOUSEKEEPING: "保洁报修",
  PRE_OPENING: "开业检查",
};

export const MWO_STATUSES = Object.keys(
  MWO_STATUS_META,
) as MaintenanceWorkOrderStatus[];

/** Active Blocking 状态（Sprint 5 §11，与后端 BLOCKING_STATUSES 一致；
 *  RESOLVED 仍阻断 —— 维修完成 ≠ 酒店验收通过） */
export const MWO_BLOCKING_STATUSES: MaintenanceWorkOrderStatus[] = [
  "OPEN",
  "ASSIGNED",
  "IN_PROGRESS",
  "RESOLVED",
];

/** 工单是否仍处于阻断状态（仅展示层判断） */
export function isActiveBlocking(
  status: MaintenanceWorkOrderStatus,
  blocksRoom: boolean,
): boolean {
  return blocksRoom && MWO_BLOCKING_STATUSES.includes(status);
}
