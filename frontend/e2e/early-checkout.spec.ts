/**
 * S2-T3 Early Checkout（REV-FINAL-03，正式 E2E，真实链路）：
 *
 * Reservation A = [today, today+2)，当天 Check-in → 当天提前 Check-out：
 *   Reservation A = COMPLETED、Stay = CHECKED_OUT、Room = available + dirty。
 * 随后同一 Room 创建 Reservation B = [today+1, today+3) 必须 SUCCESS ——
 * 若 A 未正确进入 COMPLETED，[today, today+2) 与 [today+1, today+3) 重叠必然 409，
 * 因此 B 的成功即证明 COMPLETED 已释放原预订尚未实际使用的剩余日期。
 */

import { expect, test } from "@playwright/test";
import { frontdeskPassword, frontdeskUsername, login } from "./helpers";
import { ensureTestUsers } from "./setup-users";
import {
  addDays,
  adminApi,
  apiExpectRoomState,
  apiGetReservation,
  businessDate,
  closeApi,
  uiCheckIn,
  uiCheckOut,
  uiCreateReservation,
  uiExpectReservationStatus,
  uiExpectRoomBadgesOnStayPage,
  uiExpectStayStatus,
} from "./booking-helpers";

const ROOM = "204";

test.beforeAll(() => ensureTestUsers());

test("Early Checkout：A=[today, today+2) 当天退房 → COMPLETED → B=[today+1, today+3) 成功", async ({
  page,
}) => {
  const checkIn = businessDate();
  const api = await adminApi();

  /* ---------- Reservation A = [today, today+2) ---------- */
  await login(page, frontdeskUsername(), frontdeskPassword());
  const a = await uiCreateReservation(page, {
    guest: { create: { name: "早退客人A", phone: "13800002222" } },
    checkIn,
    checkOut: addDays(checkIn, 2),
    roomNumber: ROOM,
    channelName: "直订",
    amount: "388.00",
  });
  expect(a.reservationNo).toMatch(/^RSV\d{8}-\d{4,}$/);

  /* ---------- 当天 Check-in ---------- */
  const stayA = await uiCheckIn(page, a.id);
  await uiExpectStayStatus(page, stayA, "在住");
  await uiExpectRoomBadgesOnStayPage(page, stayA, "在住", "干净");
  await apiExpectRoomState(api, ROOM, "occupied", "clean");

  /* ---------- 当天提前 Check-out ---------- */
  await uiCheckOut(page, stayA);

  // A → COMPLETED / CHECKED_OUT / available + dirty
  await uiExpectReservationStatus(page, a.id, "已完成");
  await uiExpectStayStatus(page, stayA, "已退房");
  await uiExpectRoomBadgesOnStayPage(page, stayA, "可售", "待清扫");
  const resA = await apiGetReservation(api, a.id);
  expect(resA.status).toBe("COMPLETED");
  await apiExpectRoomState(api, ROOM, "available", "dirty");

  /* ---------- Reservation B = [today+1, today+3) 同一 Room → SUCCESS ---------- */
  const b = await uiCreateReservation(page, {
    guest: { create: { name: "接续客人B", phone: "13800003333" } },
    checkIn: addDays(checkIn, 1),
    checkOut: addDays(checkIn, 3),
    roomNumber: ROOM,
    channelName: "直订",
    amount: "388.00",
  });
  await expect(
    page.locator("main").getByText("已确认", { exact: true }).first(),
  ).toBeVisible();
  const resB = await apiGetReservation(api, b.id);
  expect(resB.status).toBe("CONFIRMED");
  expect(resB.check_in_date).toBe(addDays(checkIn, 1));
  expect(resB.check_out_date).toBe(addDays(checkIn, 3));

  await closeApi(api);
});
