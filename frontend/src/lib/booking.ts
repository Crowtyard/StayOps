/**
 * Booking 前端业务工具（展示层，非后端状态机事实源）：
 * - Property Business Date：Asia/Shanghai（IANA 时区，不依赖宿主机时区）
 * - 日期区间 [check_in_date, check_out_date) 校验
 * - Reservation / Stay / Source 展示元数据（标签 + 徽标颜色）
 */

import type {
  ReservationSource,
  ReservationStatus,
  StayStatus,
} from "@/lib/api/types";
import type { StatusMeta } from "@/lib/status";

/** Asia/Shanghai 当前业务日期（YYYY-MM-DD）。基于 IANA 时区，与宿主机时区无关。 */
export function businessDate(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** 日期加减天数（输入输出 YYYY-MM-DD；纯日期算术，无时区依赖） */
export function addDays(dateStr: string, days: number): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 日期区间校验：[check_in, check_out)，check_out 必须晚于 check_in */
export function validateDateRange(
  checkIn: string,
  checkOut: string,
): string | null {
  if (!checkIn || !checkOut) return null; // 缺失由表单必填校验处理
  if (checkOut <= checkIn) {
    return "退房日期必须晚于入住日期";
  }
  return null;
}

export const RESERVATION_STATUS_META: Record<ReservationStatus, StatusMeta> = {
  CONFIRMED: {
    label: "已确认",
    badge: "bg-blue-100 text-blue-800 ring-blue-300",
  },
  CANCELLED: {
    label: "已取消",
    badge: "bg-slate-200 text-slate-700 ring-slate-400",
  },
  NO_SHOW: {
    label: "未到店",
    badge: "bg-red-100 text-red-800 ring-red-300",
  },
  CHECKED_IN: {
    label: "已入住",
    badge: "bg-violet-100 text-violet-800 ring-violet-300",
  },
  COMPLETED: {
    label: "已完成",
    badge: "bg-emerald-100 text-emerald-800 ring-emerald-300",
  },
};

export const STAY_STATUS_META: Record<StayStatus, StatusMeta> = {
  ACTIVE: { label: "在住", badge: "bg-blue-100 text-blue-800 ring-blue-300" },
  CHECKED_OUT: {
    label: "已退房",
    badge: "bg-slate-200 text-slate-700 ring-slate-400",
  },
};

export const SOURCE_LABELS: Record<ReservationSource, string> = {
  DIRECT: "直订",
  PHONE: "电话",
  WECHAT: "微信",
  WALK_IN: "散客",
  OTA: "OTA",
  CORPORATE: "协议",
  OTHER: "其他",
};

export const RESERVATION_SOURCES = Object.keys(
  SOURCE_LABELS,
) as ReservationSource[];

/**
 * alpha.9.6 F3：散客渠道的稳定 code。
 *
 * 「散客」（Walk-in）统一流程要求 check_in_date = Property Business Date 今天。
 * 用渠道 code 判断而不是渠道名：渠道名允许经营者本地化修改，code 稳定不可变。
 */
export const WALK_IN_CHANNEL_CODE = "SYS_WALK_IN";

/** 金额展示：直接展示后端返回的字符串（Decimal 序列化），不做浮点运算 */
export function formatMoney(
  amount: string | null | undefined,
  currency: string | null | undefined,
): string {
  if (amount == null || amount === "") return "—";
  return `${currency ?? "CNY"} ${amount}`;
}

/** 时间戳展示（timezone-aware ISO → 本地时区可读格式） */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}
