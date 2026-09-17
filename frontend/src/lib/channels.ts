/**
 * 客源渠道展示工具（alpha.9.6 F3/F4，纯展示层）。
 *
 * 命名纪律（任务书 §11）：统一使用「来源渠道」「客源渠道」「渠道经营分析」，
 * 禁止出现「OTA来源」这类模糊字段名。
 */

import type {
  ChannelCategory,
  ChannelOut,
  DailyRoomStatus,
  ReservationSource,
  SourceChannelBrief,
} from "@/lib/api/types";
import type { StatusMeta } from "@/lib/status";

export const CHANNEL_CATEGORY_LABELS: Record<ChannelCategory, string> = {
  OTA: "OTA 平台",
  DIRECT: "直销",
  OFFLINE: "线下",
  CORPORATE: "协议客户",
  OTHER: "其他",
};

export const CHANNEL_CATEGORY_ORDER: ChannelCategory[] = [
  "OTA",
  "DIRECT",
  "OFFLINE",
  "CORPORATE",
  "OTHER",
];

export function channelCategoryLabel(category: ChannelCategory): string {
  return CHANNEL_CATEGORY_LABELS[category] ?? category;
}

/**
 * 来源渠道展示名（唯一事实 = source_channel；缺失时回退 legacy 投影）。
 *
 * - 有渠道 -> 渠道名（渠道事后停用时追加「已停用」提示）
 * - 无渠道但有 legacy source -> 「其他」（历史兼容，不暴露自由文本）
 * - 都没有 -> 「未指定渠道」
 */
export function reservationChannelLabel(
  channel: SourceChannelBrief | null | undefined,
  legacySource?: ReservationSource | null,
): string {
  if (channel) {
    return channel.enabled ? channel.name : `${channel.name}（已停用）`;
  }
  if (legacySource) return "其他";
  return "未指定渠道";
}

/** 供 select 使用的渠道选项（停用渠道默认排除，历史值可显式保留）。 */
export function selectableChannels(
  channels: ChannelOut[] | null | undefined,
): ChannelOut[] {
  return (channels ?? []).filter((c) => c.enabled);
}

/* ------------------------------------------------------------------ */
/* alpha.9.6 F2：某日房态展示元数据                                     */
/* ------------------------------------------------------------------ */

/**
 * 某日房态分类元数据（**不是** rooms.occupancy_status）。
 * AVAILABLE = 该日可售；RESERVED = 已预订（未到店）；OCCUPIED = 在住。
 */
export const DAILY_ROOM_STATUS_META: Record<DailyRoomStatus, StatusMeta> = {
  AVAILABLE: {
    label: "可售",
    badge: "bg-emerald-100 text-emerald-800 ring-emerald-300",
  },
  RESERVED: {
    label: "已预订",
    badge: "bg-amber-100 text-amber-800 ring-amber-300",
  },
  OCCUPIED: {
    label: "在住",
    badge: "bg-blue-100 text-blue-800 ring-blue-300",
  },
  OUT_OF_SERVICE: {
    label: "维修停用",
    badge: "bg-red-100 text-red-800 ring-red-300",
  },
};

export const DAILY_ROOM_STATUSES: DailyRoomStatus[] = [
  "AVAILABLE",
  "RESERVED",
  "OCCUPIED",
  "OUT_OF_SERVICE",
];
