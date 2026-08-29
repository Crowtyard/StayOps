/**
 * Analytics 前端展示层工具（Sprint 8）：
 * - 纯展示函数（Backend 拥有全部指标公式；这里只 format / 判定零值语义）
 * - 日期预设（过去7天 / 过去30天 / 过去90天 / 本月 / 上月 / 自定义）
 * - 区间校验（from < to；to <= 业务日期；跨度 <= 366 天）
 *
 * 零值语义（§33）：Count -> 0；Rate/Average 分母 0 -> null（显示 "—"）；
 * 禁止 NaN / Infinity / fake business data。
 */

import { addDays } from "@/lib/booking";

export interface AnalyticsRange {
  from: string;
  to: string;
}

export type AnalyticsPresetKey = "7d" | "30d" | "90d" | "month" | "lastMonth" | "custom";

/**
 * 对比语义（D1，与后端 COMPARISON_MODES 对齐）：
 * - equal_length：等长前移（Last 7/30/90 Days、Custom）
 * - previous_calendar_month：上一完整自然月（Last Month）
 * - previous_month_elapsed：上一自然月同 elapsed 跨度（This Month）
 */
export type ComparisonMode =
  | "equal_length"
  | "previous_calendar_month"
  | "previous_month_elapsed";

/** Preset -> comparison_mode（前端只负责发送用户所选 preset 对应的模式，
 *  上一周期区间计算仍由 Backend 权威完成，D1.3）。 */
export function comparisonModeForPreset(preset: AnalyticsPresetKey): ComparisonMode {
  if (preset === "month") return "previous_month_elapsed";
  if (preset === "lastMonth") return "previous_calendar_month";
  return "equal_length";
}

export interface AnalyticsPreset {
  key: AnalyticsPresetKey;
  label: string;
}

export const ANALYTICS_PRESETS: AnalyticsPreset[] = [
  { key: "7d", label: "过去7天" },
  { key: "30d", label: "过去30天" },
  { key: "90d", label: "过去90天" },
  { key: "month", label: "本月" },
  { key: "lastMonth", label: "上月" },
  { key: "custom", label: "自定义" },
];

export const DEFAULT_PRESET: AnalyticsPresetKey = "30d";

/** 月份首日（YYYY-MM-DD） */
function monthStart(dateStr: string): string {
  return `${dateStr.slice(0, 8)}01`;
}

/**
 * 预设区间（Business Date 口径，与后端 [from, to) 一致）：
 * - 过去 N 天： [bd - N, bd)
 * - 本月：      [monthStart, bd)（Actual 至多统计到业务日期当天之前，§3）
 * - 上月：      上一完整自然月
 * - 自定义：    null（由用户输入）
 */
export function presetRange(key: AnalyticsPresetKey, businessDate: string): AnalyticsRange | null {
  switch (key) {
    case "7d":
      return { from: addDays(businessDate, -7), to: businessDate };
    case "30d":
      return { from: addDays(businessDate, -30), to: businessDate };
    case "90d":
      return { from: addDays(businessDate, -90), to: businessDate };
    case "month": {
      const ms = monthStart(businessDate);
      return { from: ms, to: businessDate };
    }
    case "lastMonth": {
      const ms = monthStart(businessDate);
      const prevStart = addDays(ms, -1).slice(0, 8) + "01";
      const nextMonthStart = monthStart(addDays(prevStart, 31));
      return { from: prevStart, to: nextMonthStart };
    }
    case "custom":
      return null;
  }
}

/**
 * 自定义区间校验（§3/§38）：from < to；to <= 业务日期；跨度 <= 366 天。
 * 返回错误文案；合法返回 null。
 */
export function validateAnalyticsRange(
  from: string,
  to: string,
  businessDate: string,
): string | null {
  if (!from || !to) return "请选择开始与结束日期";
  if (from >= to) return "开始日期必须早于结束日期";
  if (to > businessDate) return "结束日期不能超过今天（实际数据只统计到业务日期当天之前）";
  const span = diffDays(from, to);
  if (span > 366) return "报告区间最大跨度为 366 天";
  return null;
}

/** 两个 YYYY-MM-DD 之间天数差（to - from，纯日期算术） */
export function diffDays(from: string, to: string): number {
  const [y1, m1, d1] = from.split("-").map(Number);
  const [y2, m2, d2] = to.split("-").map(Number);
  const a = Date.UTC(y1, m1 - 1, d1);
  const b = Date.UTC(y2, m2 - 1, d2);
  return Math.round((b - a) / 86_400_000);
}

/* ------------------------------------------------------------------ */
/* 格式化（零值语义：null/undefined -> "—"；禁止 NaN / Infinity）       */
/* ------------------------------------------------------------------ */

/** 比率 0..1 -> 百分比（0.643 -> "64.3%"）；null -> "—" */
export function fmtRate(rate: number | null | undefined): string {
  if (rate == null || !Number.isFinite(rate)) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

/** 数量（整数） */
export function fmtCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return String(value);
}

/** 金额（后端 Decimal 字符串，如 "3550.00"）-> "¥3,550.00"；null -> "—" */
export function fmtMoney(value: string | null | undefined): string {
  if (value == null || value === "") return "—";
  const num = Number(value);
  if (!Number.isFinite(num)) return "—";
  return `¥${num.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** 分钟（110.0 -> "110.0 分钟"）；null -> "—" */
export function fmtMinutes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(1)} 分钟`;
}

/** 天数（2.3 -> "2.3 天"）；null -> "—" */
export function fmtDays(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(1)} 天`;
}

/**
 * 百分比变化（§32）：0.123 -> "+12.3%"；null（previous=0 / 无对比）-> "—"。
 * 禁止 Infinity%。
 */
export function fmtPercentChange(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(1)}%`;
}

/** 比率对比（§32）：0.05 -> "+5.0 pp"（percentage points）；null -> "—" */
export function fmtPpDelta(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(1)} pp`;
}

/** 比较方向（用于 KPI 箭头）：正 / 负 / 持平 / 无 */
export function changeTone(value: number | null | undefined): "up" | "down" | "flat" | "none" {
  if (value == null || !Number.isFinite(value)) return "none";
  if (value > 0.0001) return "up";
  if (value < -0.0001) return "down";
  return "flat";
}
