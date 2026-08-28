/**
 * Sprint 4 Front Desk 纯函数工具库（展示层，非后端状态机事实源）：
 * - 时间线几何：[check_in_date, check_out_date) 与可视窗口裁剪、像素定位
 *   （严格不含退房日；紧邻预订相邻渲染、互不重叠；禁止 off-by-one）
 * - Today Summary / Attention Center（三条固定规则）计算
 * - 预订条展示文案（受 guest:read 控制，不泄漏 PII）
 *
 * 日期一律 YYYY-MM-DD，运算走 Date.UTC 纯日期算术（与 lib/booking.ts 一致）。
 */

import { addDays } from "@/lib/booking";
import type {
  HousekeepingTaskOut,
  ReservationOut,
  RoomOut,
  StayOut,
} from "@/lib/api/types";

/* ------------------------------------------------------------------ */
/* 日期窗口与时间线几何                                                  */
/* ------------------------------------------------------------------ */

/** Room Diary 支持的窗口（Today = 仅今天一列）。 */
export const DIARY_WINDOWS = [
  { key: "today", label: "Today", days: 1 },
  { key: "7", label: "7 天", days: 7 },
  { key: "14", label: "14 天", days: 14 },
  { key: "30", label: "30 天", days: 30 },
] as const;

export type DiaryWindowKey = (typeof DIARY_WINDOWS)[number]["key"];

export function windowDays(key: DiaryWindowKey): number {
  const found = DIARY_WINDOWS.find((w) => w.key === key);
  return found ? found.days : 7;
}

/** 单日列宽（px）。时间线几何 = 天数 × 该宽度。 */
export const DAY_CELL_WIDTH = 64;

/** 两日期相差天数（b - a；纯日期算术）。 */
export function dayDiff(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round(
    (Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000,
  );
}

/** 窗口 [winStart, winStart + days) 内的日列列表（长度为 days）。 */
export function windowDates(winStart: string, days: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < days; i += 1) {
    out.push(addDays(winStart, i));
  }
  return out;
}

/** 窗口结束日（不含）：winStart + days。 */
export function windowEnd(winStart: string, days: number): string {
  return addDays(winStart, days);
}

export interface BarPlacement {
  /** 相对时间线轨道左缘的像素偏移（0 = 窗口首列左缘）。 */
  left: number;
  /** 像素宽度 = 实际覆盖晚数 × 列宽。 */
  width: number;
  /** 在窗口内实际覆盖的晚数（≥1）。 */
  nights: number;
  /** 裁剪后的展示起点（窗口内）。 */
  start: string;
  /** 裁剪后的展示终点（不含，窗口内）。 */
  end: string;
}

/**
 * [check_in, check_out) 裁剪到窗口 [winStart, winStart+days) 并换算像素。
 * 无重叠 → null（含 check_out == winStart 或 check_in == winEnd 的紧邻情况）。
 *
 * 例：窗口 [28, 32)，预订 [28,30) → left 0、width 128（只覆盖 28/29 两晚）；
 * 预订 [30,32) → left 128、width 128（30/31 两晚）——两条相邻不重叠。
 */
export function barPlacement(
  checkIn: string,
  checkOut: string,
  winStart: string,
  days: number,
): BarPlacement | null {
  const winEndDate = windowEnd(winStart, days);
  const start = checkIn > winStart ? checkIn : winStart;
  const end = checkOut < winEndDate ? checkOut : winEndDate;
  const nights = dayDiff(start, end);
  if (nights <= 0) return null;
  return {
    left: dayDiff(winStart, start) * DAY_CELL_WIDTH,
    width: nights * DAY_CELL_WIDTH,
    nights,
    start,
    end,
  };
}

/** 预订晚数（未裁剪；check_out - check_in）。 */
export function reservationNights(reservation: ReservationOut): number {
  return dayDiff(reservation.check_in_date, reservation.check_out_date);
}

/* ------------------------------------------------------------------ */
/* 时间线数据：仅展示当前及未来运营相关状态（Sprint 4 §8）               */
/* ------------------------------------------------------------------ */

/** 时间线展示状态：CANCELLED / NO_SHOW 不作为占用条；COMPLETED 不作未来主条。 */
export const TIMELINE_STATUSES = ["CONFIRMED", "CHECKED_IN"] as const;

export function isTimelineReservation(
  r: Pick<ReservationOut, "status">,
): boolean {
  return (TIMELINE_STATUSES as readonly string[]).includes(r.status);
}

/** 预订条基础色（与 lib/status.ts / lib/booking.ts 徽标色同语义）。 */
export const RESERVATION_BAR_CLASS: Record<string, string> = {
  CONFIRMED: "bg-blue-500 text-white",
  CHECKED_IN: "bg-violet-600 text-white",
};

/**
 * 预订条主文案：guest:read 时优先 Guest name，否则 reservation_no。
 * （后端已裁剪 guest_name；前端双保险不渲染 PII。）
 */
export function reservationBarText(
  reservation: ReservationOut,
  canReadGuest: boolean,
): string {
  if (canReadGuest && reservation.guest_name) return reservation.guest_name;
  return reservation.reservation_no;
}

/** 预订条 tooltip（原生 title）：只含当前权限可见字段。 */
export function reservationBarTitle(
  reservation: ReservationOut,
  canReadGuest: boolean,
): string {
  const parts: string[] = [
    `预订 ${reservation.reservation_no}`,
    `房间 ${reservation.room_number ?? `#${reservation.room_id}`}`,
    `${reservation.check_in_date} → ${reservation.check_out_date}`,
    `状态 ${reservation.status}`,
    `来源 ${reservation.source}`,
  ];
  if (canReadGuest && reservation.guest_name) {
    parts.push(`客人 ${reservation.guest_name}`);
  }
  return parts.join(" · ");
}

/* ------------------------------------------------------------------ */
/* Today Summary                                                        */
/* ------------------------------------------------------------------ */

export interface TodaySummary {
  arrivals: ReservationOut[];
  departures: StayOut[];
  inHouse: StayOut[];
  vacantClean: RoomOut[];
}

/** 今日到店 = check_in_date == today 且状态为 CONFIRMED / CHECKED_IN。 */
export function isTodayArrival(
  r: Pick<ReservationOut, "check_in_date" | "status">,
  today: string,
): boolean {
  return (
    r.check_in_date === today &&
    (r.status === "CONFIRMED" || r.status === "CHECKED_IN")
  );
}

export function computeTodaySummary(
  rooms: RoomOut[],
  reservations: ReservationOut[],
  stays: StayOut[],
  today: string,
): TodaySummary {
  return {
    arrivals: reservations.filter((r) => isTodayArrival(r, today)),
    departures: stays.filter((s) => s.planned_check_out_date === today),
    inHouse: stays,
    vacantClean: rooms.filter(
      (r) => r.occupancy_status === "available" && r.cleaning_status === "clean",
    ),
  };
}

/* ------------------------------------------------------------------ */
/* Attention Center（Sprint 4 固定三条规则，不做通用 Rule Engine）        */
/* ------------------------------------------------------------------ */

export type AttentionRule = "A" | "B" | "C";

export interface AttentionItem {
  rule: AttentionRule;
  roomId: number;
  roomNumber: string;
  /** 员工可读的问题描述。 */
  problem: string;
  /** 下一步去处：打开预订抽屉 / 房间抽屉 / 在住详情。 */
  nextStep: "reservation" | "room" | "stay";
  reservationId?: number;
  reservationNo?: string;
  stayId?: number;
  stayNo?: string;
}

const ATTENTION_RULE_LABELS: Record<AttentionRule, string> = {
  A: "到店房间未准备",
  B: "在住超期",
  C: "房间不可用",
};

export function attentionRuleLabel(rule: AttentionRule): string {
  return ATTENTION_RULE_LABELS[rule];
}

/**
 * 三条固定规则：
 * A：今日到店（CONFIRMED）且 Room.cleaning_status != clean
 * B：Stay = ACTIVE 且 planned_checkout_date < business_date（超期未退）
 * C：未来 CONFIRMED 预订（check_in_date > today）且 Room occupancy_status
 *    ∈ (blocked, out_of_service)
 */
export function computeAttention(
  reservations: ReservationOut[],
  stays: StayOut[],
  rooms: RoomOut[],
  today: string,
): AttentionItem[] {
  const roomById = new Map(rooms.map((r) => [r.id, r]));
  const items: AttentionItem[] = [];

  for (const r of reservations) {
    const room = roomById.get(r.room_id);
    if (!room) continue;
    const roomNo = room.room_number;
    if (r.status === "CONFIRMED" && r.check_in_date === today) {
      if (room.cleaning_status !== "clean") {
        items.push({
          rule: "A",
          roomId: room.id,
          roomNumber: roomNo,
          problem: `今日到店，房间尚未准备完成（清洁状态 ${room.cleaning_status}）`,
          nextStep: "reservation",
          reservationId: r.id,
          reservationNo: r.reservation_no,
        });
      }
    }
    if (
      r.status === "CONFIRMED" &&
      r.check_in_date > today &&
      (room.occupancy_status === "blocked" ||
        room.occupancy_status === "out_of_service")
    ) {
      items.push({
        rule: "C",
        roomId: room.id,
        roomNumber: roomNo,
        problem: `未来预订（${r.check_in_date} 到店）的房间当前为 ${room.occupancy_status}，不可用`,
        nextStep: "reservation",
        reservationId: r.id,
        reservationNo: r.reservation_no,
      });
    }
  }

  for (const s of stays) {
    if (s.status === "ACTIVE" && s.planned_check_out_date < today) {
      const room = roomById.get(s.room_id);
      items.push({
        rule: "B",
        roomId: s.room_id,
        roomNumber: room ? room.room_number : `#${s.room_id}`,
        problem: `已超过计划退房日（${s.planned_check_out_date}）仍在住`,
        nextStep: "stay",
        stayId: s.id,
        stayNo: s.stay_no,
      });
    }
  }

  return items;
}

/* ------------------------------------------------------------------ */
/* 保洁任务（仅展示层消费 Alpha.3 能力）                                  */
/* ------------------------------------------------------------------ */

export const HK_ACTIVE_TASK_STATUSES = [
  "PENDING",
  "IN_PROGRESS",
  "INSPECTION",
  "REWORK",
] as const;

export function isActiveTask(t: Pick<HousekeepingTaskOut, "status">): boolean {
  return (HK_ACTIVE_TASK_STATUSES as readonly string[]).includes(t.status);
}

/** 房间的进行中任务（展示层按状态过滤；数据库唯一性由后端保证）。 */
export function activeTaskForRoom(
  tasks: HousekeepingTaskOut[],
  roomId: number,
): HousekeepingTaskOut | null {
  return (
    tasks.find((t) => t.room_id === roomId && isActiveTask(t)) ?? null
  );
}

/* ------------------------------------------------------------------ */
/* 快速新建预订（复用 /reservations/new，仅预填，不新造表单）              */
/* ------------------------------------------------------------------ */

export interface QuickCreatePrefill {
  roomId: number;
  roomTypeId: number;
  checkIn: string;
  checkOut: string;
}

/** 空白日期格 → /reservations/new 预填链接（check_out = check_in + 1）。 */
export function quickCreateHref(
  roomId: number,
  roomTypeId: number,
  date: string,
): string {
  const params = new URLSearchParams({
    room_id: String(roomId),
    room_type_id: String(roomTypeId),
    check_in_date: date,
    check_out_date: addDays(date, 1),
  });
  return `/reservations/new?${params.toString()}`;
}

/* ------------------------------------------------------------------ */
/* 搜索（房号 / Guest name / phone / reservation_no）                    */
/* ------------------------------------------------------------------ */

/** 本地匹配房号（前端搜索「房号」不产生 PII 请求）。 */
export function matchRoomsByNumber(
  rooms: RoomOut[],
  query: string,
): RoomOut[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return rooms
    .filter((r) => r.room_number.toLowerCase().includes(q))
    .slice(0, 8);
}

/** 输入看起来像预订单号（RSV 前缀）→ 即使无 guest:read 也允许后端搜索。 */
export function looksLikeReservationNo(query: string): boolean {
  return /^rsv/i.test(query.trim());
}

/** 周标签（一/二/三…日），用于日列表头。 */
const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"];

export function weekdayLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return WEEKDAY_LABELS[day];
}

/** 短日期展示（M/D）。 */
export function shortDateLabel(dateStr: string): string {
  const [, m, d] = dateStr.split("-").map(Number);
  return `${m}/${d}`;
}
