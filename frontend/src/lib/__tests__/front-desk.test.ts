/**
 * Sprint 4 Front Desk 纯函数测试（lib/front-desk.ts）：
 * - [check_in_date, check_out_date) 时间线几何（严格不含退房日，无 off-by-one）
 * - 相邻预订不重叠；边界/裁剪；Today Summary；Attention 三条规则
 * - PII：预订条文案受 guest:read 控制
 * 日期全部动态生成（Asia/Shanghai 业务日期），禁止硬编码年月日。
 */

import { describe, expect, it } from "vitest";
import {
  DAY_CELL_WIDTH,
  activeBlockingOrdersForRoom,
  barPlacement,
  computeAttention,
  computeTodaySummary,
  dayDiff,
  isTimelineReservation,
  isTodayArrival,
  looksLikeReservationNo,
  matchRoomsByNumber,
  quickCreateHref,
  reservationBarText,
  reservationBarTitle,
  reservationNights,
  windowDates,
  windowEnd,
} from "@/lib/front-desk";
import { addDays, businessDate } from "@/lib/booking";
import type {
  MaintenanceWorkOrderOut,
  ReservationOut,
  RoomOut,
  StayOut,
} from "@/lib/api/types";

const TODAY = businessDate();

function makeReservation(
  checkIn: string,
  overrides: Partial<ReservationOut> = {},
): ReservationOut {
  return {
    id: 1,
    reservation_no: "RSV-FD-0001",
    guest_id: 7,
    guest_name: "张先生",
    room_id: 1,
    room_number: "203",
    room_type_id: 3,
    room_type_name: "豪华大床房",
    check_in_date: checkIn,
    check_out_date: addDays(checkIn, 2),
    status: "CONFIRMED",
    source: "DIRECT",
    agreed_total_amount: "428.00",
    currency: "CNY",
    ...overrides,
  };
}

function makeRoom(
  roomNumber: string,
  overrides: Partial<RoomOut> = {},
): RoomOut {
  return {
    id: Number(roomNumber),
    room_number: roomNumber,
    name: null,
    is_active: true,
    room_type_id: 3,
    floor: Number(roomNumber[0]),
    occupancy_status: "available",
    cleaning_status: "clean",
    notes: null,
    created_at: "x",
    updated_at: "x",
    room_type: { id: 3, name: "豪华大床房" },
    ...overrides,
  };
}

function makeStay(
  plannedOut: string,
  overrides: Partial<StayOut> = {},
): StayOut {
  return {
    id: 21,
    stay_no: "STY-FD-0021",
    reservation_id: 11,
    room_id: 1,
    room_number: "203",
    status: "ACTIVE",
    actual_check_in_at: "x",
    planned_check_out_date: plannedOut,
    ...overrides,
  };
}

function makeWorkOrder(
  roomId: number,
  overrides: Partial<MaintenanceWorkOrderOut> = {},
): MaintenanceWorkOrderOut {
  return {
    id: 41,
    work_order_no: "MWO-FD-0041",
    room_id: roomId,
    room_number: String(roomId),
    category: "HVAC",
    severity: "HIGH",
    status: "IN_PROGRESS",
    source: "FRONT_DESK",
    blocks_room: true,
    title: "空调故障",
    created_at: "x",
    updated_at: "x",
    ...overrides,
  };
}

describe("日期算术与窗口", () => {
  it("dayDiff 纯日期差", () => {
    expect(dayDiff(TODAY, addDays(TODAY, 3))).toBe(3);
    expect(dayDiff(addDays(TODAY, 5), TODAY)).toBe(-5);
    expect(dayDiff(TODAY, TODAY)).toBe(0);
  });

  it("windowDates / windowEnd：窗口 [start, start+days) 长度为 days", () => {
    const dates = windowDates(TODAY, 7);
    expect(dates).toHaveLength(7);
    expect(dates[0]).toBe(TODAY);
    expect(dates[6]).toBe(addDays(TODAY, 6));
    expect(windowEnd(TODAY, 7)).toBe(addDays(TODAY, 7));
  });

  it("quickCreateHref：check_out = check_in + 1，携带房间与日期", () => {
    const href = quickCreateHref(12, 5, addDays(TODAY, 2));
    const url = new URL(href, "http://x");
    expect(url.pathname).toBe("/reservations/new");
    expect(url.searchParams.get("room_id")).toBe("12");
    expect(url.searchParams.get("room_type_id")).toBe("5");
    expect(url.searchParams.get("check_in_date")).toBe(addDays(TODAY, 2));
    expect(url.searchParams.get("check_out_date")).toBe(addDays(TODAY, 3));
  });
});

describe("[check_in, check_out) 时间线几何", () => {
  it("[28,30) 在窗口 [28,32) 内：left=0 width=128（只覆盖 28/29 两晚）", () => {
    const win = TODAY;
    const p = barPlacement(win, addDays(win, 2), win, 4);
    expect(p).not.toBeNull();
    expect(p?.left).toBe(0);
    expect(p?.width).toBe(2 * DAY_CELL_WIDTH);
    expect(p?.nights).toBe(2);
  });

  it("相邻预订不重叠：[28,30) 与 [30,32) 左右相接", () => {
    const win = TODAY;
    const first = barPlacement(win, addDays(win, 2), win, 4);
    const second = barPlacement(addDays(win, 2), addDays(win, 4), win, 4);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second?.left).toBe(first!.left + first!.width);
    // 互不覆盖
    expect(first!.left + first!.width).toBeLessThanOrEqual(second!.left);
  });

  it("跨窗裁剪：预订从窗口前开始 / 到窗口后结束", () => {
    const win = TODAY;
    // [win-2, win+1) → 窗口内覆盖 1 晚（win 当晚），left=0
    const leftClip = barPlacement(addDays(win, -2), addDays(win, 1), win, 3);
    expect(leftClip?.left).toBe(0);
    expect(leftClip?.width).toBe(DAY_CELL_WIDTH);
    expect(leftClip?.nights).toBe(1);
    // [win+2, win+9) → 窗口内覆盖 1 晚（win+2 当晚），left=2*W
    const rightClip = barPlacement(addDays(win, 2), addDays(win, 9), win, 3);
    expect(rightClip?.left).toBe(2 * DAY_CELL_WIDTH);
    expect(rightClip?.width).toBe(DAY_CELL_WIDTH);
    expect(rightClip?.nights).toBe(1);
  });

  it("边界不越界：check_out == 窗口起点 或 check_in == 窗口终点 → null", () => {
    const win = TODAY;
    expect(
      barPlacement(addDays(win, -3), win, win, 3),
    ).toBeNull();
    expect(
      barPlacement(addDays(win, 3), addDays(win, 5), win, 3),
    ).toBeNull();
  });

  it("窗口完全覆盖预订：nights = check_out - check_in", () => {
    const win = TODAY;
    const p = barPlacement(addDays(win, 1), addDays(win, 4), win, 7);
    expect(p?.left).toBe(DAY_CELL_WIDTH);
    expect(p?.width).toBe(3 * DAY_CELL_WIDTH);
    expect(p?.nights).toBe(3);
  });

  it("reservationNights / 展示状态过滤", () => {
    expect(reservationNights(makeReservation(TODAY))).toBe(2);
    expect(isTimelineReservation(makeReservation(TODAY))).toBe(true);
    expect(
      isTimelineReservation(makeReservation(TODAY, { status: "CANCELLED" })),
    ).toBe(false);
    expect(
      isTimelineReservation(makeReservation(TODAY, { status: "NO_SHOW" })),
    ).toBe(false);
    expect(
      isTimelineReservation(makeReservation(TODAY, { status: "COMPLETED" })),
    ).toBe(false);
    // Sprint 6 §24：CHECKED_IN 不再画成当前实际占用（由 ACTIVE Stay 表达）
    expect(
      isTimelineReservation(makeReservation(TODAY, { status: "CHECKED_IN" })),
    ).toBe(false);
  });
});

describe("Today Summary", () => {
  it("今日到店 = check_in == today 且 CONFIRMED/CHECKED_IN", () => {
    expect(isTodayArrival(makeReservation(TODAY), TODAY)).toBe(true);
    expect(
      isTodayArrival(makeReservation(TODAY, { status: "CHECKED_IN" }), TODAY),
    ).toBe(true);
    expect(
      isTodayArrival(makeReservation(TODAY, { status: "CANCELLED" }), TODAY),
    ).toBe(false);
    expect(isTodayArrival(makeReservation(addDays(TODAY, 1)), TODAY)).toBe(
      false,
    );
  });

  it("空净房 = occupancy available 且 cleaning clean", () => {
    const rooms = [
      makeRoom("101"),
      makeRoom("102", { cleaning_status: "dirty" }),
      makeRoom("103", { occupancy_status: "occupied" }),
      makeRoom("104", { occupancy_status: "blocked", cleaning_status: "clean" }),
    ];
    const s = computeTodaySummary(rooms, [], [], TODAY);
    expect(s.vacantClean.map((r) => r.room_number)).toEqual(["101"]);
  });

  it("今日离店 / 当前在住来自 ACTIVE stays", () => {
    const stays = [
      makeStay(TODAY),
      makeStay(addDays(TODAY, 2), { id: 22, stay_no: "STY-0022" }),
    ];
    const s = computeTodaySummary([], [], stays, TODAY);
    expect(s.departures).toHaveLength(1);
    expect(s.departures[0].id).toBe(21);
    expect(s.inHouse).toHaveLength(2);
  });
});

describe("Attention Center（三条固定规则）", () => {
  it("A：今日到店且房间 cleaning != clean", () => {
    const room = makeRoom("201", { cleaning_status: "dirty" });
    const res = makeReservation(TODAY, { room_id: room.id, room_number: "201" });
    const items = computeAttention([res], [], [room], TODAY);
    expect(items).toHaveLength(1);
    expect(items[0].rule).toBe("A");
    expect(items[0].reservationId).toBe(res.id);
    expect(items[0].nextStep).toBe("reservation");
    expect(items[0].problem).toContain("尚未准备完成");
  });

  it("A 不命中：今日到店但房间干净；脏房但非今日到店", () => {
    const clean = makeRoom("201");
    const dirty = makeRoom("202", { id: 202, cleaning_status: "dirty" });
    const resClean = makeReservation(TODAY, { room_id: 201 });
    const resFuture = makeReservation(addDays(TODAY, 1), {
      id: 2,
      room_id: 202,
      room_number: "202",
    });
    const items = computeAttention([resClean, resFuture], [], [clean, dirty], TODAY);
    expect(items).toHaveLength(0);
  });

  it("B：ACTIVE 且 planned_check_out < business_date（超期在住）", () => {
    const room = makeRoom("203");
    const stay = makeStay(addDays(TODAY, -1), {
      room_id: 203,
      room_number: "203",
    });
    const items = computeAttention([], [stay], [room], TODAY);
    expect(items).toHaveLength(1);
    expect(items[0].rule).toBe("B");
    expect(items[0].nextStep).toBe("stay");
    expect(items[0].stayId).toBe(21);
  });

  it("B 不命中：计划今天或未来退房", () => {
    const stays = [
      makeStay(TODAY),
      makeStay(addDays(TODAY, 1), { id: 22, stay_no: "STY-0022" }),
    ];
    expect(computeAttention([], stays, [], TODAY)).toHaveLength(0);
  });

  it("C：未来 CONFIRMED 且房间 blocked / out_of_service", () => {
    const blocked = makeRoom("204", {
      id: 204,
      occupancy_status: "blocked",
    });
    const oos = makeRoom("205", {
      id: 205,
      occupancy_status: "out_of_service",
    });
    const resBlocked = makeReservation(addDays(TODAY, 3), {
      id: 3,
      room_id: 204,
      room_number: "204",
    });
    const resOos = makeReservation(addDays(TODAY, 5), {
      id: 4,
      room_id: 205,
      room_number: "205",
    });
    const items = computeAttention(
      [resBlocked, resOos],
      [],
      [blocked, oos],
      TODAY,
    );
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.rule === "C")).toBe(true);
    expect(items[0].problem).toContain("blocked");
    expect(items[1].problem).toContain("out_of_service");
  });

  it("C 不命中：未来预订但房间可售；今日到店 blocked 不算 future", () => {
    const room = makeRoom("206", { id: 206 });
    const res = makeReservation(addDays(TODAY, 2), {
      id: 5,
      room_id: 206,
      room_number: "206",
    });
    const blockedToday = makeRoom("207", {
      id: 207,
      occupancy_status: "blocked",
    });
    const resToday = makeReservation(TODAY, {
      id: 6,
      room_id: 207,
      room_number: "207",
    });
    const items = computeAttention(
      [res, resToday],
      [],
      [room, blockedToday],
      TODAY,
    );
    expect(items).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* Sprint 5 修复：预订存在维修风险（Rule M）                             */
/* ------------------------------------------------------------------ */

describe("Attention Rule M：预订存在维修风险（S5 修复）", () => {
  it("occupied + active blocking MWO + future CONFIRMED → 维修风险 attention（不依赖 Room occupancy）", () => {
    const room = makeRoom("203", {
      id: 203,
      occupancy_status: "occupied",
    });
    const res = makeReservation(addDays(TODAY, 1), {
      id: 2,
      room_id: 203,
      room_number: "203",
    });
    const order = makeWorkOrder(203, { status: "IN_PROGRESS" });
    const items = computeAttention([res], [], [room], TODAY, [order]);
    expect(items).toHaveLength(1);
    expect(items[0].rule).toBe("M");
    expect(items[0].reservationId).toBe(res.id);
    expect(items[0].nextStep).toBe("reservation");
    expect(items[0].problem).toContain("阻断性维修");
    expect(items[0].problem).toContain(order.work_order_no);
    expect(items[0].problem).toContain("明日到店");
    expect(items[0].maintenance).toEqual({
      workOrderId: order.id,
      workOrderNo: order.work_order_no,
      count: 1,
    });
  });

  it("occupied + active blocking MWO + today CONFIRMED arrival → 同样报警（clean 也有提示）", () => {
    const room = makeRoom("204", {
      id: 204,
      occupancy_status: "occupied",
      cleaning_status: "clean",
    });
    const res = makeReservation(TODAY, {
      id: 3,
      room_id: 204,
      room_number: "204",
    });
    const order = makeWorkOrder(204, { status: "ASSIGNED" });
    const items = computeAttention([res], [], [room], TODAY, [order]);
    expect(items).toHaveLength(1);
    expect(items[0].rule).toBe("M");
    expect(items[0].problem).toContain("今日到店");
    // 不因 clean 而漏报（Rule A 是清洁风险，M 是维修风险，相互独立）
  });

  it("blocking MWO status = RESOLVED → 仍产生风险（resolved ≠ verified）", () => {
    const room = makeRoom("205", { id: 205 });
    const res = makeReservation(addDays(TODAY, 2), {
      id: 4,
      room_id: 205,
      room_number: "205",
    });
    const order = makeWorkOrder(205, { status: "RESOLVED" });
    const items = computeAttention([res], [], [room], TODAY, [order]);
    expect(items).toHaveLength(1);
    expect(items[0].rule).toBe("M");
    expect(items[0].problem).toContain("待验收");
  });

  it("COMPLETED / CANCELLED 工单 → 不产生维修风险", () => {
    const room = makeRoom("206", { id: 206 });
    const res = makeReservation(addDays(TODAY, 1), {
      id: 5,
      room_id: 206,
      room_number: "206",
    });
    const completed = makeWorkOrder(206, {
      id: 51,
      work_order_no: "MWO-FD-0051",
      status: "COMPLETED",
    });
    const cancelled = makeWorkOrder(206, {
      id: 52,
      work_order_no: "MWO-FD-0052",
      status: "CANCELLED",
    });
    const items = computeAttention(
      [res],
      [],
      [room],
      TODAY,
      [completed, cancelled],
    );
    expect(items).toHaveLength(0);
  });

  it("blocks_room = false → 不产生维修风险", () => {
    const room = makeRoom("207", { id: 207 });
    const res = makeReservation(addDays(TODAY, 3), {
      id: 6,
      room_id: 207,
      room_number: "207",
    });
    const nonBlocking = makeWorkOrder(207, {
      id: 53,
      work_order_no: "MWO-FD-0053",
      blocks_room: false,
      status: "IN_PROGRESS",
    });
    const items = computeAttention([res], [], [room], TODAY, [nonBlocking]);
    expect(items).toHaveLength(0);
  });

  it("同一预订 + 多张 active blocking MWO → 仅一条 attention，计数合并", () => {
    const room = makeRoom("208", { id: 208 });
    const res = makeReservation(addDays(TODAY, 1), {
      id: 7,
      room_id: 208,
      room_number: "208",
    });
    const first = makeWorkOrder(208, { id: 54, work_order_no: "MWO-FD-0054" });
    const second = makeWorkOrder(208, {
      id: 55,
      work_order_no: "MWO-FD-0055",
      status: "OPEN",
    });
    const items = computeAttention([res], [], [room], TODAY, [
      second,
      first,
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].rule).toBe("M");
    expect(items[0].maintenance?.count).toBe(2);
    // 首张工单确定性（按 id 升序）
    expect(items[0].maintenance?.workOrderId).toBe(54);
    expect(items[0].problem).toContain("阻断性维修 2 项");
  });

  it("Room OOS（MAINTENANCE）+ blocking MWO + future 预订 → 只有 M，无重复 Rule C", () => {
    const room = makeRoom("209", {
      id: 209,
      occupancy_status: "out_of_service",
      unavailability_source: "MAINTENANCE",
    });
    const res = makeReservation(addDays(TODAY, 2), {
      id: 8,
      room_id: 209,
      room_number: "209",
    });
    const order = makeWorkOrder(209, { status: "IN_PROGRESS" });
    const items = computeAttention([res], [], [room], TODAY, [order]);
    expect(items).toHaveLength(1);
    expect(items[0].rule).toBe("M");
    expect(items.some((i) => i.rule === "C")).toBe(false);
  });

  it("MANUAL OOS / blocked 且无 blocking MWO → Rule C 继续工作", () => {
    const manualOos = makeRoom("210", {
      id: 210,
      occupancy_status: "out_of_service",
      unavailability_source: "MANUAL",
    });
    const blocked = makeRoom("211", {
      id: 211,
      occupancy_status: "blocked",
      unavailability_source: "MANUAL",
    });
    const resOos = makeReservation(addDays(TODAY, 4), {
      id: 9,
      room_id: 210,
      room_number: "210",
    });
    const resBlocked = makeReservation(addDays(TODAY, 5), {
      id: 10,
      room_id: 211,
      room_number: "211",
    });
    const items = computeAttention(
      [resOos, resBlocked],
      [],
      [manualOos, blocked],
      TODAY,
      [],
    );
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.rule === "C")).toBe(true);
  });

  it("workOrders 为 null（无 maintenance_order:read）→ 不产生 Rule M", () => {
    const room = makeRoom("212", {
      id: 212,
      occupancy_status: "occupied",
    });
    const res = makeReservation(addDays(TODAY, 1), {
      id: 11,
      room_id: 212,
      room_number: "212",
    });
    const items = computeAttention([res], [], [room], TODAY, null);
    expect(items).toHaveLength(0);
  });

  it("历史日期 CONFIRMED（check_in < today）→ 不产生 Rule M", () => {
    const room = makeRoom("213", { id: 213 });
    const res = makeReservation(addDays(TODAY, -1), {
      id: 12,
      room_id: 213,
      room_number: "213",
    });
    const order = makeWorkOrder(213, { status: "OPEN" });
    const items = computeAttention([res], [], [room], TODAY, [order]);
    expect(items).toHaveLength(0);
  });

  it("activeBlockingOrdersForRoom：按 blocks_room + 状态过滤并排序", () => {
    const orders = [
      makeWorkOrder(1, {
        id: 63,
        work_order_no: "MWO-0063",
        blocks_room: false,
      }),
      makeWorkOrder(1, { id: 62, work_order_no: "MWO-0062", status: "COMPLETED" }),
      makeWorkOrder(1, { id: 61, work_order_no: "MWO-0061", status: "RESOLVED" }),
      makeWorkOrder(2, { id: 60, work_order_no: "MWO-0060", status: "OPEN" }),
    ];
    const blockers = activeBlockingOrdersForRoom(orders, 1);
    expect(blockers.map((o) => o.id)).toEqual([61]);
    expect(activeBlockingOrdersForRoom(orders, 2).map((o) => o.id)).toEqual([60]);
    expect(activeBlockingOrdersForRoom(orders, 99)).toHaveLength(0);
  });
});

describe("搜索与 PII 文案", () => {
  it("matchRoomsByNumber 本地匹配房号", () => {
    const rooms = [makeRoom("101"), makeRoom("201"), makeRoom("110")];
    expect(matchRoomsByNumber(rooms, "10")).toHaveLength(2);
    expect(matchRoomsByNumber(rooms, "201")[0].room_number).toBe("201");
    expect(matchRoomsByNumber(rooms, "")).toHaveLength(0);
  });

  it("looksLikeReservationNo：RSV 前缀识别", () => {
    expect(looksLikeReservationNo("RSV20260801-0001")).toBe(true);
    expect(looksLikeReservationNo("rsv-123")).toBe(true);
    expect(looksLikeReservationNo("张先生")).toBe(false);
    expect(looksLikeReservationNo("13800138000")).toBe(false);
  });

  it("reservationBarText：guest:read 时显示姓名，否则只显示预订号", () => {
    const res = makeReservation(TODAY);
    expect(reservationBarText(res, true)).toBe("张先生");
    expect(reservationBarText(res, false)).toBe("RSV-FD-0001");
    // 后端已裁剪 guest_name 时同样回退预订号
    const cropped = { ...res, guest_name: undefined };
    expect(reservationBarText(cropped, true)).toBe("RSV-FD-0001");
  });

  it("reservationBarTitle：tooltip 不含无权限 PII", () => {
    const res = makeReservation(TODAY, { guest_name: "隐私客人" });
    const withGuest = reservationBarTitle(res, true);
    expect(withGuest).toContain("隐私客人");
    expect(withGuest).toContain(res.reservation_no);
    const withoutGuest = reservationBarTitle(res, false);
    expect(withoutGuest).not.toContain("隐私客人");
    expect(withoutGuest).toContain(res.reservation_no);
  });
});
