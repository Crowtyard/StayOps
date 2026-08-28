/**
 * Room Move 前端展示工具（Sprint 6，展示层，非后端状态机事实源）：
 * - 换房原因元数据（§10：7 个固定原因，中文标签）
 * - 在住房间分配历史格式化（§27：房间记录）
 * - 原分配房 vs 当前在住房判断（§28）
 */

import type {
  RoomMoveReason,
  StayOut,
  StayRoomAssignmentOut,
} from "@/lib/api/types";

/** 换房原因中文标签（Sprint 6 §10）。 */
export const ROOM_MOVE_REASON_LABELS: Record<RoomMoveReason, string> = {
  MAINTENANCE: "维修故障",
  GUEST_REQUEST: "客人要求",
  ROOM_QUALITY: "客房体验问题",
  OPERATIONAL: "运营调整",
  UPGRADE: "升级房型",
  DOWNGRADE: "降级房型",
  OTHER: "其他",
};

export const ROOM_MOVE_REASONS = Object.keys(
  ROOM_MOVE_REASON_LABELS,
) as RoomMoveReason[];

/** 分配记录原因标签：null（Check-in 初始分配）→「入住」。 */
export function assignmentReasonLabel(
  assignment: StayRoomAssignmentOut,
): string {
  return assignment.reason
    ? ROOM_MOVE_REASON_LABELS[assignment.reason]
    : "入住";
}

/** 时间戳展示（timezone-aware ISO → 本地可读；复用 booking 语义但避免循环依赖）。 */
function formatTs(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

export interface AssignmentHistoryRow {
  roomLabel: string;
  /** 08/28 14:03 → 08/29 10:32 / 当前 */
  periodLabel: string;
  reasonLabel: string;
  isCurrent: boolean;
}

/** §27 房间记录行：房间 + 时间区间 + 原因。 */
export function formatAssignmentHistory(
  assignment: StayRoomAssignmentOut,
): AssignmentHistoryRow {
  const roomLabel = assignment.room_number ?? `#${assignment.room_id}`;
  const start = formatTs(assignment.started_at);
  const isCurrent = assignment.ended_at == null;
  const periodLabel = isCurrent
    ? `${start} → 当前`
    : `${start} → ${formatTs(assignment.ended_at)}`;
  return {
    roomLabel,
    periodLabel,
    reasonLabel: assignmentReasonLabel(assignment),
    isCurrent,
  };
}

/** §28：是否发生过换房（当前在住房 ≠ 原分配房）。 */
export function stayHasMoved(stay: StayOut): boolean {
  const original = stay.reservation?.room_id;
  return original != null && original !== stay.room_id;
}

/** §28：原分配房房号（无换房时为 null，避免重复展示噪声）。 */
export function originalRoomNumber(stay: StayOut): string | null {
  if (!stayHasMoved(stay)) return null;
  return stay.reservation?.room_number ?? null;
}
