/**
 * S2-T3 Golden Path（正式 E2E，真实链路：浏览器 → Next.js BFF → FastAPI(8001) → stayops_test）。
 *
 * 剧情（FRONT_DESK，动态日期 = Property Business Date，Asia/Shanghai）：
 * Login → 创建 Guest 张先生 → Availability（203 可售）→ 创建 Reservation 203
 * [today, today+2) source=WECHAT → 第二个重叠预订 409（UI 禁选 + BFF 409 原文）
 * → 当天 Check-in（Reservation CHECKED_IN + Stay ACTIVE + 203 occupied）
 * → 当天 Check-out（Reservation COMPLETED + Stay CHECKED_OUT + 203 available+dirty）
 * → 页面刷新后最终状态保持 → admin 审计日志四事件 + details 无 PII。
 */

import { expect, test } from "@playwright/test";
import {
  adminPassword,
  adminUsername,
  frontdeskPassword,
  frontdeskUsername,
  login,
} from "./helpers";
import { ensureTestUsers } from "./setup-users";
import {
  addDays,
  adminApi,
  apiExpectRoomState,
  apiGetReservation,
  apiGetStay,
  apiListAuditLogs,
  businessDate,
  closeApi,
  uiCheckIn,
  uiCheckOut,
  uiCreateReservation,
  uiExpectReservationStatus,
  uiExpectRoomBadgesOnStayPage,
  uiExpectRoomUnavailable,
  uiExpectStayStatus,
} from "./booking-helpers";

const CHECK_IN = businessDate();
const CHECK_OUT = addDays(CHECK_IN, 2);

// 故意使用可辨识的 PII 值：审计 details / 响应裁剪断言以这些标记为准
const GUEST = {
  name: "张先生",
  phone: "13900001111",
  email: "golden-guest@example.com",
  notes: "PII-NOTES-GOLDEN-7f3a",
};
const AMOUNT = "428.00";
const ROOM = "203";

test.beforeAll(() => ensureTestUsers());

test("Golden Path：预订 → 重叠 409 → 入住 → 退房 → 刷新保持 → 审计无 PII", async ({
  page,
}) => {
  const api = await adminApi();

  /* ---------- 1) FRONT_DESK 登录 + 导航可见 ---------- */
  await login(page, frontdeskUsername(), frontdeskPassword());
  await expect(page.getByRole("link", { name: "预订" })).toBeVisible();
  await expect(page.getByRole("link", { name: "在住" })).toBeVisible();

  /* ---------- 2) 创建 Guest + Availability + 创建 Reservation（UI 全链路） ---------- */
  const created = await uiCreateReservation(page, {
    guest: { create: GUEST },
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    roomNumber: ROOM,
    channelName: "微信",
    amount: AMOUNT,
    notes: "微信预订备注",
  });
  const reservationId = created.id;

  // 预订详情：CONFIRMED 徽标 + 关键字段（Guest PII 由 guest:read 正常展示）
  await expect(
    page.locator("main").getByText("已确认", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.locator("main").getByText(GUEST.name, { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator("main").getByText(ROOM, { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.locator("main").getByText(`CNY ${AMOUNT}`, { exact: true }),
  ).toBeVisible();

  const resDetailResp = await page.request.get(
    `/api/bff/reservations/${reservationId}`,
  );
  expect(resDetailResp.status()).toBe(200);
  const resDetail = (await resDetailResp.json()) as {
    status: string;
    guest_id: number;
    room_id: number;
    room_type_id: number;
    guest_name?: string;
  };
  expect(resDetail.status).toBe("CONFIRMED");
  expect(resDetail.guest_name).toBe(GUEST.name);

  /* ---------- 3) 第二个重叠预订 → 409（UI 禁选 + BFF 409 原文） ---------- */
  await uiExpectRoomUnavailable(page, {
    guest: { search: GUEST.name, pick: GUEST.name },
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    roomNumber: ROOM,
    reasonSubstring: "该房间在所选日期区间已被预订",
  });

  const overlapResp = await page.request.post("/api/bff/reservations", {
    data: {
      guest_id: resDetail.guest_id,
      room_id: resDetail.room_id,
      room_type_id: resDetail.room_type_id,
      check_in_date: CHECK_IN,
      check_out_date: CHECK_OUT,
      channelName: "微信",
      agreed_total_amount: "399.00",
    },
  });
  expect(overlapResp.status()).toBe(409);
  const overlapBody = (await overlapResp.json()) as { detail?: string };
  expect(overlapBody.detail).toBe("该房间在所选日期区间已被预订");

  /* ---------- 4) 当天 Check-in（Reservation CHECKED_IN + Stay ACTIVE + 203 occupied） ---------- */
  const stayId = await uiCheckIn(page, reservationId);
  await expect(
    page.locator("main").getByText("在住", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.locator("main").getByText("已入住", { exact: true }).first(),
  ).toBeVisible();
  await uiExpectRoomBadgesOnStayPage(page, stayId, "在住", "干净");

  const resAfterCI = await apiGetReservation(api, reservationId);
  expect(resAfterCI.status).toBe("CHECKED_IN");
  expect(resAfterCI.stay_id).toBe(stayId);
  const stayAfterCI = await apiGetStay(api, stayId);
  expect(stayAfterCI.status).toBe("ACTIVE");
  await apiExpectRoomState(api, ROOM, "occupied", "clean");

  /* ---------- 5) 当天 Check-out（Reservation COMPLETED + Stay CHECKED_OUT + available+dirty） ---------- */
  await uiCheckOut(page, stayId);
  await uiExpectStayStatus(page, stayId, "已退房");
  await uiExpectRoomBadgesOnStayPage(page, stayId, "可售", "待清扫");
  await uiExpectReservationStatus(page, reservationId, "已完成");

  const resAfterCO = await apiGetReservation(api, reservationId);
  expect(resAfterCO.status).toBe("COMPLETED");
  const stayAfterCO = await apiGetStay(api, stayId);
  expect(stayAfterCO.status).toBe("CHECKED_OUT");
  await apiExpectRoomState(api, ROOM, "available", "dirty");

  /* ---------- 6) 页面刷新后最终状态保持（helper 均重新加载页面） ---------- */
  await uiExpectReservationStatus(page, reservationId, "已完成");
  await uiExpectStayStatus(page, stayId, "已退房");
  await uiExpectRoomBadgesOnStayPage(page, stayId, "可售", "待清扫");
  await apiExpectRoomState(api, ROOM, "available", "dirty");

  /* ---------- 7) Audit（admin /settings/audit-logs）：四事件齐全且 details 无 PII ---------- */
  await page.getByRole("button", { name: "退出" }).click();
  await expect(page).toHaveURL(/\/login/);
  await login(page, adminUsername(), adminPassword());

  await page.getByRole("link", { name: "审计日志" }).click();
  await expect(
    page.getByRole("heading", { name: "审计日志" }),
  ).toBeVisible();

  for (const action of [
    "guest.create",
    "reservation.create",
    "reservation.check_in",
    "stay.check_out",
  ]) {
    // 审计页筛选选项来自当前已加载数据：先重置为「全部操作」，
    // 待全量列表重新加载（选项包含全部 action）后再选择目标 action
    await page.getByLabel("操作类型").selectOption("");
    await page.getByLabel("操作类型").selectOption(action);
    await expect(
      page.getByRole("row", { name: new RegExp(action) }).first(),
    ).toBeVisible();
  }

  // 审计 details 精确断言（按本次资源 ID 定位，不得含完整 PII）
  const guestId = resDetail.guest_id;
  const auditCases: { action: string; resourceType: string; resourceId: number }[] = [
    { action: "guest.create", resourceType: "guest", resourceId: guestId },
    { action: "reservation.create", resourceType: "reservation", resourceId: reservationId },
    { action: "reservation.check_in", resourceType: "reservation", resourceId: reservationId },
    { action: "stay.check_out", resourceType: "stay", resourceId: stayId },
  ];
  for (const c of auditCases) {
    const logs = await apiListAuditLogs(api, {
      action: c.action,
      resource_type: c.resourceType,
      page_size: 100,
    });
    const mine = logs.items.find((l) => l.resource_id === c.resourceId);
    expect(mine, `审计应存在 ${c.action} #${c.resourceId}`).toBeTruthy();
    const detailsText = JSON.stringify(mine?.details ?? null);
    for (const forbidden of [GUEST.phone, GUEST.email, GUEST.notes, AMOUNT]) {
      expect(detailsText, `${c.action} details 不得包含 ${forbidden}`).not.toContain(
        forbidden,
      );
    }
  }

  await closeApi(api);
});
