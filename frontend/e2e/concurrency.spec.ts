/**
 * S2-T3 并发专项（REV-FINAL-08，真实 HTTP 并发）：
 *
 * 使用 Playwright request fixture 创建两个独立 APIRequestContext（各自 Bearer），
 * 经真实 FastAPI（127.0.0.1:8001）→ 真实 PostgreSQL stayops_test，Promise.all
 * 并发触发，验证数据库最终仲裁：
 *
 * 1. Double Booking：同 Room 同重叠日期两个并发 POST /reservations
 *    → 1 × 201 + 1 × 409，库中最终恰 1 条
 * 2. Concurrent Check-in：同一 CONFIRMED Reservation 两个并发 Check-in
 *    → 1 SUCCESS + 1 × 409，最终恰好一个 ACTIVE Stay
 * 3. Concurrent Check-out：同一 ACTIVE Stay 两个并发 Check-out
 *    → 1 SUCCESS + 1 × 409，最终 Stay=CHECKED_OUT、Reservation=COMPLETED、
 *    Room=available+dirty，且无重复 stay.check_out 审计
 */

import { expect, test } from "@playwright/test";
import {
  addDays,
  adminApi,
  apiCheckIn,
  apiCreateGuest,
  apiCreateReservation,
  apiExpectRoomState,
  apiGetReservation,
  apiGetRoomByNumber,
  apiGetStay,
  apiListAuditLogs,
  apiListReservations,
  apiListStays,
  businessDate,
  closeApi,
  type ApiSession,
  type ReservationApi,
} from "./booking-helpers";

interface CheckInPayload {
  guest_id: number;
  room_id: number;
  room_type_id: number;
  check_in_date: string;
  check_out_date: string;
  agreed_total_amount: string;
}

async function createGuestAndRoom(
  api: ApiSession,
  roomNumber: string,
  guestName: string,
): Promise<{ guestId: number; room: Awaited<ReturnType<typeof apiGetRoomByNumber>> }> {
  const guest = await apiCreateGuest(api, { name: guestName, phone: "13600009999" });
  const room = await apiGetRoomByNumber(api, roomNumber);
  return { guestId: guest.id, room };
}

test("Double Booking：同房同期两个并发 POST → 1 SUCCESS + 1 × 409，库中恰 1 条", async () => {
  const api = await adminApi();
  const apiB = await adminApi();
  const { guestId, room } = await createGuestAndRoom(api, "301", "并发双订客人");

  const payload: CheckInPayload = {
    guest_id: guestId,
    room_id: room.id,
    room_type_id: room.room_type_id,
    check_in_date: businessDate(),
    check_out_date: addDays(businessDate(), 2),
    agreed_total_amount: "299.00",
  };

  const [r1, r2] = await Promise.all([
    api.ctx.post("/api/v1/reservations", {
      headers: api.headers,
      data: payload,
    }),
    apiB.ctx.post("/api/v1/reservations", {
      headers: apiB.headers,
      data: payload,
    }),
  ]);

  expect([r1.status(), r2.status()].sort(), "必须 1 SUCCESS + 1 CONFLICT").toEqual([
    201, 409,
  ]);
  const conflict = r1.status() === 409 ? r1 : r2;
  const conflictBody = (await conflict.json()) as { detail?: string };
  expect(conflictBody.detail).toContain("已被预订");

  // 数据库最终只有 1 条 CONFIRMED 预订
  const list = await apiListReservations(api, {
    room_id: room.id,
    status: "CONFIRMED",
    page_size: 100,
  });
  expect(list.items).toHaveLength(1);
  expect(list.items[0].reservation_no).toMatch(/^RSV\d{8}-\d{4,}$/);

  await closeApi(apiB);
  await closeApi(api);
});

test("Concurrent Check-in：同一 CONFIRMED 预订双并发 → 1 SUCCESS + 1 × 409，恰一个 Stay", async () => {
  const api = await adminApi();
  const apiB = await adminApi();
  const { guestId, room } = await createGuestAndRoom(api, "302", "并发入住客人");

  const reservation: ReservationApi = await apiCreateReservation(api, {
    guest_id: guestId,
    room_id: room.id,
    room_type_id: room.room_type_id,
    check_in_date: businessDate(),
    check_out_date: addDays(businessDate(), 2),
    agreed_total_amount: "299.00",
  });

  const [r1, r2] = await Promise.all([
    api.ctx.post(`/api/v1/reservations/${reservation.id}/check-in`, {
      headers: api.headers,
    }),
    apiB.ctx.post(`/api/v1/reservations/${reservation.id}/check-in`, {
      headers: apiB.headers,
    }),
  ]);

  expect([r1.status(), r2.status()].sort(), "必须 1 SUCCESS + 1 CONFLICT").toEqual([
    200, 409,
  ]);

  // 恰好一个 ACTIVE Stay
  const stays = await apiListStays(api, {
    room_id: room.id,
    status: "ACTIVE",
    page_size: 100,
  });
  expect(stays.items).toHaveLength(1);

  const resAfter = await apiGetReservation(api, reservation.id);
  expect(resAfter.status).toBe("CHECKED_IN");
  expect(resAfter.stay_id).toBe(stays.items[0].id);
  await apiExpectRoomState(api, "302", "occupied", "clean");

  await closeApi(apiB);
  await closeApi(api);
});

test("Concurrent Check-out：同一 ACTIVE Stay 双并发 → 1 SUCCESS + 1 × 409，最终一致无重复审计", async () => {
  const api = await adminApi();
  const apiB = await adminApi();
  const { guestId, room } = await createGuestAndRoom(api, "303", "并发退房客人");

  const reservation: ReservationApi = await apiCreateReservation(api, {
    guest_id: guestId,
    room_id: room.id,
    room_type_id: room.room_type_id,
    check_in_date: businessDate(),
    check_out_date: addDays(businessDate(), 2),
    agreed_total_amount: "299.00",
  });
  const checked = await apiCheckIn(api, reservation.id);
  const stayId = checked.stay.id;

  const [r1, r2] = await Promise.all([
    api.ctx.post(`/api/v1/stays/${stayId}/check-out`, { headers: api.headers }),
    apiB.ctx.post(`/api/v1/stays/${stayId}/check-out`, { headers: apiB.headers }),
  ]);

  expect([r1.status(), r2.status()].sort(), "必须 1 SUCCESS + 1 CONFLICT").toEqual([
    200, 409,
  ]);
  const conflict = r1.status() === 409 ? r1 : r2;
  const conflictBody = (await conflict.json()) as { detail?: string };
  expect(conflictBody.detail).toContain("已退房");

  // 最终一致状态
  const stayAfter = await apiGetStay(api, stayId);
  expect(stayAfter.status).toBe("CHECKED_OUT");
  expect(stayAfter.actual_check_out_at).toBeTruthy();
  const resAfter = await apiGetReservation(api, reservation.id);
  expect(resAfter.status).toBe("COMPLETED");
  await apiExpectRoomState(api, "303", "available", "dirty");

  // 无重复退房审计
  const audits = await apiListAuditLogs(api, {
    action: "stay.check_out",
    resource_type: "stay",
    page_size: 100,
  });
  const mine = audits.items.filter((l) => l.resource_id === stayId);
  expect(mine, "退房审计必须恰好一条").toHaveLength(1);

  await closeApi(apiB);
  await closeApi(api);
});
