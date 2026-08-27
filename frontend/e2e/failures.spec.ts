/**
 * S2-T3 失败处理（409/404/401 语义，正式 E2E，真实链路）：
 *
 * - dirty room check-in → 409（UI 冲突条原文 + BFF 状态码）
 * - occupied room check-in → 409
 * - future reservation check-in → 409（REV-FINAL-01）
 * - cancelled reservation 后续操作 → 409
 * - already checked-out stay → 409
 * - 不存在资源 → 404（BFF + UI）
 * - 未认证 → 401（BFF）
 *
 * Backend detail 必须原样到达 UI，不得被吞掉。
 */

import { expect, request, test } from "@playwright/test";
import { frontdeskPassword, frontdeskUsername, login } from "./helpers";
import { ensureTestUsers } from "./setup-users";
import {
  addDays,
  adminApi,
  apiCheckIn,
  apiCheckOut,
  apiCreateGuest,
  apiCreateReservation,
  apiGetRoomByNumber,
  apiSetRoomStatus,
  businessDate,
  closeApi,
  type ApiSession,
} from "./booking-helpers";

const TODAY = businessDate();

// 各用例专用房间 + 预订（beforeAll 由 admin 直连真实后端构造）
const ROOMS = {
  dirty: "304",
  occupied: "305",
  future: "306",
  cancelled: "307",
  checkedOut: "308",
};

const ids: Record<string, { reservationId: number; stayId?: number; guestId: number }> = {};

async function setupRoom(
  api: ApiSession,
  roomNumber: string,
  guestName: string,
  checkIn: string,
  checkOut: string,
  roomStatusBody?: Record<string, string>,
): Promise<{ reservationId: number; guestId: number }> {
  const guest = await apiCreateGuest(api, { name: guestName, phone: "13500007777" });
  const room = await apiGetRoomByNumber(api, roomNumber);
  const reservation = await apiCreateReservation(api, {
    guest_id: guest.id,
    room_id: room.id,
    room_type_id: room.room_type_id,
    check_in_date: checkIn,
    check_out_date: checkOut,
    agreed_total_amount: "318.00",
  });
  if (roomStatusBody) {
    await apiSetRoomStatus(api, room.id, roomStatusBody);
  }
  return { reservationId: reservation.id, guestId: guest.id };
}

test.beforeAll(async () => {
  await ensureTestUsers();
  const api = await adminApi();

  // 304：dirty（现场未清洁）
  ids.dirty = await setupRoom(api, ROOMS.dirty, "失败客人-脏房", TODAY, addDays(TODAY, 2), {
    cleaning_status: "dirty",
  });

  // 305：occupied（现场已占用）
  ids.occupied = await setupRoom(api, ROOMS.occupied, "失败客人-占用", TODAY, addDays(TODAY, 2), {
    occupancy_status: "occupied",
  });

  // 306：未来预订（REV-FINAL-01：未到入住日）
  ids.future = await setupRoom(api, ROOMS.future, "失败客人-未来", addDays(TODAY, 1), addDays(TODAY, 3));

  // 307：待取消（取消后后续操作 → 409）
  ids.cancelled = await setupRoom(api, ROOMS.cancelled, "失败客人-已取消", TODAY, addDays(TODAY, 2));

  // 308：已退房 Stay（再次退房 → 409）
  const checkedOut = await setupRoom(api, ROOMS.checkedOut, "失败客人-已退房", TODAY, addDays(TODAY, 2));
  const checked = await apiCheckIn(api, checkedOut.reservationId);
  ids.checkedOut = { ...checkedOut, stayId: checked.stay.id };
  await apiCheckOut(api, checked.stay.id);

  await closeApi(api);
});

test("409：dirty room check-in（UI 冲突原文 + BFF 状态码）", async ({ page }) => {
  await login(page, frontdeskUsername(), frontdeskPassword());

  await page.goto(`/reservations/${ids.dirty.reservationId}`);
  await expect(page.getByRole("heading", { name: /^预订 RSV/ })).toBeVisible();
  // 前置提示：房间未清洁
  await expect(
    page.getByText("房间未清洁，办理入住前请先安排保洁"),
  ).toBeVisible();

  await page.getByRole("button", { name: "办理入住" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "办理入住" }).click();

  // 后端 detail 原样展示（不被吞掉）
  await expect(page.getByText("房间未清洁，请先安排保洁", { exact: true })).toBeVisible();

  const resp = await page.request.post(
    `/api/bff/reservations/${ids.dirty.reservationId}/check-in`,
  );
  expect(resp.status()).toBe(409);
  const body = (await resp.json()) as { detail?: string };
  expect(body.detail).toBe("房间未清洁，请先安排保洁");
});

test("409：occupied room check-in（UI 冲突原文 + BFF 状态码）", async ({ page }) => {
  await login(page, frontdeskUsername(), frontdeskPassword());

  await page.goto(`/reservations/${ids.occupied.reservationId}`);
  await expect(page.getByRole("heading", { name: /^预订 RSV/ })).toBeVisible();

  await page.getByRole("button", { name: "办理入住" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "办理入住" }).click();
  await expect(
    page.getByText("房间当前不可用，无法办理入住", { exact: true }),
  ).toBeVisible();

  const resp = await page.request.post(
    `/api/bff/reservations/${ids.occupied.reservationId}/check-in`,
  );
  expect(resp.status()).toBe(409);
  const body = (await resp.json()) as { detail?: string };
  expect(body.detail).toBe("房间当前不可用，无法办理入住");
});

test("409：future reservation check-in（REV-FINAL-01，UI + BFF）", async ({ page }) => {
  await login(page, frontdeskUsername(), frontdeskPassword());

  await page.goto(`/reservations/${ids.future.reservationId}`);
  await expect(page.getByRole("heading", { name: /^预订 RSV/ })).toBeVisible();

  await page.getByRole("button", { name: "办理入住" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "办理入住" }).click();
  await expect(
    page.getByText("未到入住日期，不能提前办理入住", { exact: true }),
  ).toBeVisible();

  const resp = await page.request.post(
    `/api/bff/reservations/${ids.future.reservationId}/check-in`,
  );
  expect(resp.status()).toBe(409);
  const body = (await resp.json()) as { detail?: string };
  expect(body.detail).toBe("未到入住日期，不能提前办理入住");
});

test("409：cancelled reservation 后续操作（UI 取消 + BFF 全操作 409）", async ({ page }) => {
  await login(page, frontdeskUsername(), frontdeskPassword());

  // UI 取消（真实后端状态机 CONFIRMED → CANCELLED）
  await page.goto(`/reservations/${ids.cancelled.reservationId}`);
  await expect(page.getByRole("heading", { name: /^预订 RSV/ })).toBeVisible();
  await page.getByRole("button", { name: "取消预订" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "取消预订" }).click();
  await expect(page.getByText("预订已取消（CANCELLED）")).toBeVisible();
  await expect(
    page.locator("main").getByText("已取消", { exact: true }).first(),
  ).toBeVisible();
  // 已终态：无任何操作按钮
  await expect(page.getByRole("button", { name: "办理入住" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "取消预订" })).toHaveCount(0);

  // BFF：cancel / check-in / no-show 全部 409
  const cases: { path: string; detail: string }[] = [
    {
      path: `/api/bff/reservations/${ids.cancelled.reservationId}/cancel`,
      detail: "仅 CONFIRMED 预订可取消",
    },
    {
      path: `/api/bff/reservations/${ids.cancelled.reservationId}/check-in`,
      detail: "仅 CONFIRMED 预订可办理入住",
    },
    {
      path: `/api/bff/reservations/${ids.cancelled.reservationId}/no-show`,
      detail: "仅 CONFIRMED 预订可标记未到店",
    },
  ];
  for (const c of cases) {
    const resp = await page.request.post(c.path);
    expect(resp.status(), c.path).toBe(409);
    const body = (await resp.json()) as { detail?: string };
    expect(body.detail, c.path).toBe(c.detail);
  }
});

test("409：already checked-out stay（UI 无退房入口 + BFF 409）", async ({ page }) => {
  await login(page, frontdeskUsername(), frontdeskPassword());

  await page.goto(`/stays/${ids.checkedOut.stayId}`);
  await expect(page.getByRole("heading", { name: /^入住 STY/ })).toBeVisible();
  await expect(
    page.locator("main").getByText("已退房", { exact: true }).first(),
  ).toBeVisible();
  // 非 ACTIVE：UI 不提供退房入口
  await expect(page.getByRole("button", { name: "办理退房" })).toHaveCount(0);

  const resp = await page.request.post(
    `/api/bff/stays/${ids.checkedOut.stayId}/check-out`,
  );
  expect(resp.status()).toBe(409);
  const body = (await resp.json()) as { detail?: string };
  expect(body.detail).toBe("该入住记录已退房");
});

test("404：不存在的预订 / 入住记录（BFF + UI 语义）", async ({ page }) => {
  await login(page, frontdeskUsername(), frontdeskPassword());

  const resResp = await page.request.get("/api/bff/reservations/999999");
  expect(resResp.status()).toBe(404);
  const resBody = (await resResp.json()) as { detail?: string };
  expect(resBody.detail).toBe("预订不存在");

  const stayResp = await page.request.get("/api/bff/stays/999999");
  expect(stayResp.status()).toBe(404);
  const stayBody = (await stayResp.json()) as { detail?: string };
  expect(stayBody.detail).toBe("入住记录不存在");

  // UI：预订 404 语义（不白屏、不跳登录）
  await page.goto("/reservations/999999");
  await expect(page.getByText("预订不存在或已被删除")).toBeVisible();
  await expect(page).not.toHaveURL(/\/login/);
});

test("401：未认证 BFF 请求（无 Cookie）", async () => {
  // request fixture 是全新 context，不携带任何登录 Cookie
  const fresh = await request.newContext();
  const resp = await fresh.get("http://localhost:3001/api/bff/rooms");
  expect(resp.status()).toBe(401);
  await fresh.dispose();
});
