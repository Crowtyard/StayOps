/**
 * Room Move 前端展示工具测试（Sprint 6）：
 * - 换房原因元数据（§10 固定 7 枚举 + 中文标签）
 * - assignment 历史格式化（§27：房间 + 时间区间 + 原因 + 当前）
 * - 原分配房 vs 当前在住房（§28：仅换房后展示）
 * - stayCheckInDate（Stay 占用条几何：Asia/Shanghai 业务日期）
 */

import { describe, expect, it } from "vitest";
import {
  ROOM_MOVE_REASON_LABELS,
  ROOM_MOVE_REASONS,
  assignmentReasonLabel,
  formatAssignmentHistory,
  originalRoomNumber,
  stayHasMoved,
} from "@/lib/room-move";
import { stayCheckInDate } from "@/lib/front-desk";
import type { StayOut, StayRoomAssignmentOut } from "@/lib/api/types";

describe("RoomMoveReason 元数据", () => {
  it("固定 7 个原因，中文标签齐全（§10）", () => {
    expect(ROOM_MOVE_REASONS).toHaveLength(7);
    expect(ROOM_MOVE_REASON_LABELS.MAINTENANCE).toBe("维修故障");
    expect(ROOM_MOVE_REASON_LABELS.GUEST_REQUEST).toBe("客人要求");
    expect(ROOM_MOVE_REASON_LABELS.ROOM_QUALITY).toBe("客房体验问题");
    expect(ROOM_MOVE_REASON_LABELS.OPERATIONAL).toBe("运营调整");
    expect(ROOM_MOVE_REASON_LABELS.UPGRADE).toBe("升级房型");
    expect(ROOM_MOVE_REASON_LABELS.DOWNGRADE).toBe("降级房型");
    expect(ROOM_MOVE_REASON_LABELS.OTHER).toBe("其他");
  });
});

function makeAssignment(
  overrides: Partial<StayRoomAssignmentOut> = {},
): StayRoomAssignmentOut {
  return {
    id: 1,
    stay_id: 21,
    room_id: 203,
    room_number: "203",
    started_at: "2026-08-28T14:03:00+08:00",
    ended_at: "2026-08-29T10:32:00+08:00",
    ...overrides,
  };
}

describe("assignment 历史格式化（§27）", () => {
  it("初始分配：reason 缺失 → 显示「入住」", () => {
    const row = formatAssignmentHistory(makeAssignment());
    expect(row.roomLabel).toBe("203");
    expect(row.reasonLabel).toBe("入住");
    expect(row.isCurrent).toBe(false);
    expect(row.periodLabel).toContain("→");
  });

  it("换房分配：reason 显示中文标签；ended_at 缺失 = 当前", () => {
    const current = formatAssignmentHistory(
      makeAssignment({
        id: 2,
        room_id: 205,
        room_number: "205",
        started_at: "2026-08-29T10:32:00+08:00",
        ended_at: undefined,
        reason: "MAINTENANCE",
      }),
    );
    expect(current.roomLabel).toBe("205");
    expect(current.reasonLabel).toBe("维修故障");
    expect(current.isCurrent).toBe(true);
    expect(current.periodLabel).toContain("当前");
  });

  it("assignmentReasonLabel：全部 7 个原因可渲染", () => {
    for (const reason of ROOM_MOVE_REASONS) {
      expect(
        assignmentReasonLabel(makeAssignment({ reason })),
      ).toBe(ROOM_MOVE_REASON_LABELS[reason]);
    }
  });
});

function makeStay(overrides: Partial<StayOut> = {}): StayOut {
  return {
    id: 21,
    stay_no: "STY-0021",
    reservation_id: 11,
    room_id: 205,
    room_number: "205",
    status: "ACTIVE",
    actual_check_in_at: "2026-08-28T14:00:00+08:00",
    planned_check_out_date: "2026-08-31",
    reservation: {
      reservation_no: "RSV-0011",
      room_id: 203,
      room_number: "203",
      check_in_date: "2026-08-28",
      check_out_date: "2026-08-31",
      status: "CHECKED_IN",
      source: "DIRECT",
      agreed_total_amount: "428.00",
      currency: "CNY",
    },
    ...overrides,
  };
}

describe("原分配房 vs 当前在住房（§28）", () => {
  it("换房后：原分配房 ≠ 当前在住房", () => {
    const stay = makeStay();
    expect(stayHasMoved(stay)).toBe(true);
    expect(originalRoomNumber(stay)).toBe("203");
  });

  it("未换房：不重复展示两个相同字段", () => {
    const stay = makeStay({
      room_id: 203,
      room_number: "203",
      reservation: {
        reservation_no: "RSV-0011",
        room_id: 203,
        room_number: "203",
        check_in_date: "2026-08-28",
        check_out_date: "2026-08-31",
        status: "CHECKED_IN",
        source: "DIRECT",
        agreed_total_amount: "428.00",
        currency: "CNY",
      },
    });
    expect(stayHasMoved(stay)).toBe(false);
    expect(originalRoomNumber(stay)).toBeNull();
  });
});

describe("stayCheckInDate（Stay 占用条几何）", () => {
  it("timestamptz ISO → Asia/Shanghai 业务日期（与宿主机时区无关）", () => {
    // 2026-08-28T22:00:00Z == 2026-08-29 06:00 +08:00 → 08-29
    expect(stayCheckInDate(makeStay({ actual_check_in_at: "2026-08-28T22:00:00Z" }))).toBe(
      "2026-08-29",
    );
    expect(
      stayCheckInDate(makeStay({ actual_check_in_at: "2026-08-28T06:00:00+08:00" })),
    ).toBe("2026-08-28");
  });

  it("非法时间返回 null（防御）", () => {
    expect(stayCheckInDate(makeStay({ actual_check_in_at: "not-a-date" }))).toBeNull();
  });
});
