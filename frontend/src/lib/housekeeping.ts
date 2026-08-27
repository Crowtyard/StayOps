/**
 * Housekeeping 前端展示工具（Sprint 3，展示层，非后端状态机事实源）：
 * - Task 状态 / 优先级 / 来源展示元数据（标签 + 徽标颜色）
 * - Task 状态 ↔ Room.cleaning_status 联动展示映射
 */

import type {
  CleaningStatus,
  HousekeepingTaskPriority,
  HousekeepingTaskSource,
  HousekeepingTaskStatus,
} from "@/lib/api/types";
import type { StatusMeta } from "@/lib/status";

export const HK_TASK_STATUS_META: Record<HousekeepingTaskStatus, StatusMeta> = {
  PENDING: { label: "待清扫", badge: "bg-amber-100 text-amber-800 ring-amber-300" },
  IN_PROGRESS: {
    label: "清扫中",
    badge: "bg-blue-100 text-blue-800 ring-blue-300",
  },
  INSPECTION: {
    label: "待验房",
    badge: "bg-violet-100 text-violet-800 ring-violet-300",
  },
  REWORK: { label: "返工", badge: "bg-orange-100 text-orange-800 ring-orange-300" },
  COMPLETED: {
    label: "已完成",
    badge: "bg-emerald-100 text-emerald-800 ring-emerald-300",
  },
  CANCELLED: {
    label: "已取消",
    badge: "bg-slate-200 text-slate-700 ring-slate-400",
  },
};

export const HK_PRIORITY_META: Record<HousekeepingTaskPriority, StatusMeta> = {
  NORMAL: { label: "普通", badge: "bg-slate-100 text-slate-700 ring-slate-300" },
  URGENT: { label: "加急", badge: "bg-red-100 text-red-700 ring-red-300" },
};

export const HK_SOURCE_LABELS: Record<HousekeepingTaskSource, string> = {
  CHECKOUT: "退房自动",
  MANUAL: "手动创建",
};

export const HK_TASK_STATUSES = Object.keys(
  HK_TASK_STATUS_META,
) as HousekeepingTaskStatus[];

/** 进行中状态（工作台展示与操作按钮判断使用；单一事实源在后端） */
export const HK_ACTIVE_STATUSES: HousekeepingTaskStatus[] = [
  "PENDING",
  "IN_PROGRESS",
  "INSPECTION",
  "REWORK",
];

/** Task 状态对应的房间清洁状态（与后端 TASK_TO_CLEANING 一致，仅用于展示） */
export const HK_TASK_TO_CLEANING: Record<HousekeepingTaskStatus, CleaningStatus> = {
  PENDING: "dirty",
  IN_PROGRESS: "cleaning",
  INSPECTION: "inspection",
  REWORK: "rework",
  COMPLETED: "clean",
  CANCELLED: "dirty",
};
