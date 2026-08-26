import type { CleaningStatus, OccupancyStatus } from "@/lib/api/types";

/** 房态展示元数据：文字 + 颜色双通道（不可只靠颜色区分状态） */

export interface StatusMeta {
  label: string;
  /** Tailwind 静态类名（完整字符串，保证 JIT 可提取） */
  badge: string;
}

export const OCCUPANCY_META: Record<OccupancyStatus, StatusMeta> = {
  available: {
    label: "可售",
    badge: "bg-emerald-100 text-emerald-800 ring-emerald-300",
  },
  reserved: {
    label: "已预订",
    badge: "bg-amber-100 text-amber-800 ring-amber-300",
  },
  occupied: {
    label: "在住",
    badge: "bg-blue-100 text-blue-800 ring-blue-300",
  },
  blocked: {
    label: "锁房",
    badge: "bg-slate-200 text-slate-700 ring-slate-400",
  },
  out_of_service: {
    label: "停用",
    badge: "bg-red-100 text-red-800 ring-red-300",
  },
};

export const CLEANING_META: Record<CleaningStatus, StatusMeta> = {
  clean: {
    label: "干净",
    badge: "bg-emerald-100 text-emerald-800 ring-emerald-300",
  },
  dirty: {
    label: "待清扫",
    badge: "bg-amber-100 text-amber-800 ring-amber-300",
  },
  cleaning: {
    label: "清扫中",
    badge: "bg-blue-100 text-blue-800 ring-blue-300",
  },
  inspection: {
    label: "待检查",
    badge: "bg-violet-100 text-violet-800 ring-violet-300",
  },
  rework: {
    label: "返工",
    badge: "bg-orange-100 text-orange-800 ring-orange-300",
  },
};

export const OCCUPANCY_STATUSES = Object.keys(OCCUPANCY_META) as OccupancyStatus[];
export const CLEANING_STATUSES = Object.keys(CLEANING_META) as CleaningStatus[];

export const OCCUPANCY_DIMENSION_LABEL = "占用状态";
export const CLEANING_DIMENSION_LABEL = "清洁状态";
