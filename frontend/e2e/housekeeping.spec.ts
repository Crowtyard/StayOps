/**
 * S3 Housekeeping E2E（正式 Playwright，真实链路：浏览器 → BFF → FastAPI → stayops_test）：
 *
 * 1. 翻房 Golden Path（房间 210）：FRONT_DESK UI 完成 预订→入住→退房 →
 *    自动任务 PENDING（API 断言）→ UI 派单 → HOUSEKEEPING UI 开始清扫/提交验房/通过
 *    → 房间 clean → 下一笔 [today, today+2) 入住 SUCCESS（翻房闭环成立）
 * 2. Rework 闭环（房间 209）：INSPECTION → 返工 → 重新清扫 → 通过；
 *    每一步 Task.status 与 Room.cleaning_status 一致
 * 3. 手动任务与取消（房间 109）：FRONT_DESK 新建任务（dirty 房间）→ 重复创建 409 →
 *    FRONT_DESK 无取消入口 → admin 取消 → 房间回置 dirty
 * 4. 工作台 RBAC UI：FRONT_DESK 可见新建任务；HOUSEKEEPING 不可见新建/取消，
 *    仅快捷工作流操作
 */

import { expect, test } from "@playwright/test";
import {
  frontdeskPassword,
  frontdeskUsername,
  housekeepingPassword,
  housekeepingUsername,
  adminPassword,
  adminUsername,
  login,
} from "./helpers";
import { ensureTestUsers } from "./setup-users";
import {
  addDays,
  adminApi,
  apiCheckIn,
  apiCreateGuest,
  apiCreateReservation,
  apiExpectRoomState,
  apiGetRoomByNumber,
  businessDate,
  closeApi,
  uiCheckIn,
  uiCheckOut,
  uiCreateReservation,
  type ApiSession,
} from "./booking-helpers";
import {
  apiFindUserId,
  apiGetActiveTaskByRoom,
  apiGetTask,
  apiSetRoomDirty,
  uiConfirm,
  uiTaskCard,
  uiTaskCardAction,
} from "./housekeeping-helpers";

const CHECK_IN = businessDate();
const CHECK_OUT = addDays(CHECK_IN, 2);

test.beforeAll(() => ensureTestUsers());

async function setupCheckoutTask(api: ApiSession, roomNumber: string, guestName: string) {
  // 真实后端：预订 → 入住 → 退房 → 自动生成翻房任务
  const guest = await apiCreateGuest(api, { name: guestName, phone: "13900009999" });
  const room = await apiGetRoomByNumber(api, roomNumber);
  const reservation = await apiCreateReservation(api, {
    guest_id: guest.id,
    room_id: room.id,
    room_type_id: room.room_type_id,
    check_in_date: CHECK_IN,
    check_out_date: CHECK_OUT,
    agreed_total_amount: "428.00",
  });
  const checked = await apiCheckIn(api, reservation.id);
  const stay = checked.stay;
  await api.ctx.post(`/api/v1/stays/${stay.id}/check-out`, { headers: api.headers });
  const task = await apiGetActiveTaskByRoom(api, roomNumber);
  expect(task.status).toBe("PENDING");
  expect(task.source).toBe("CHECKOUT");
  return task;
}

test("翻房 Golden Path：退房自动任务 → 派单 → 清扫链 → 通过 → 下一笔入住成功", async ({
  page,
}) => {
  const api = await adminApi();
  const hkUserId = await apiFindUserId(api, housekeepingUsername());

  /* ---------- Booking 前置（FRONT_DESK 真实浏览器链路，房间 210） ---------- */
  await login(page, frontdeskUsername(), frontdeskPassword());
  // exact：避免与 Dashboard「进入保洁工作台 →」快捷链接歧义（strict mode）
  await expect(
    page.getByRole("link", { name: "保洁", exact: true }),
  ).toBeVisible();

  const created = await uiCreateReservation(page, {
    guest: { create: { name: "翻房客人", phone: "13900008888" } },
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    roomNumber: "210",
    channelName: "微信",
    amount: "428.00",
  });
  const stayId = await uiCheckIn(page, created.id);
  await uiCheckOut(page, stayId);

  /* ---------- 退房自动任务：PENDING + CHECKOUT + 房间 dirty ---------- */
  const task = await apiGetActiveTaskByRoom(api, "210");
  expect(task.source).toBe("CHECKOUT");
  await apiExpectRoomState(api, "210", "available", "dirty");

  /* ---------- FRONT_DESK UI 派单 ---------- */
  await page.goto(`/housekeeping/${task.id}`);
  await expect(
    page.getByRole("heading", { name: /保洁任务 HKT/ }),
  ).toBeVisible();
  await page
    .getByLabel("指派保洁员")
    .selectOption({ value: String(hkUserId) });
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("已保存")).toBeVisible();

  const assigned = await apiGetTask(api, task.id);
  expect(assigned.assigned_to_user_id).toBe(hkUserId);

  /* ---------- HOUSEKEEPING UI 清扫链 ---------- */
  await page.getByRole("button", { name: "退出" }).click();
  await expect(page).toHaveURL(/\/login/);
  await login(page, housekeepingUsername(), housekeepingPassword());
  await expect(page.getByRole("link", { name: "保洁" })).toBeVisible();

  // 工作台快捷操作（一到两次点击）；HOUSEKEEPING 无新建/取消入口
  await uiTaskCard(page, "210");
  await expect(page.getByRole("button", { name: "新建任务" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "取消" })).toHaveCount(0);

  await uiTaskCardAction(page, "210", "开始清扫");
  await expect(page.getByText("房间 210 已开始清扫")).toBeVisible();
  await apiExpectRoomState(api, "210", "available", "cleaning");

  await uiTaskCardAction(page, "210", "提交验房");
  await expect(page.getByText("房间 210 已提交验房")).toBeVisible();
  await apiExpectRoomState(api, "210", "available", "inspection");

  await uiTaskCardAction(page, "210", "通过");
  await uiConfirm(page, "确认通过");
  await expect(page.getByText("房间 210 验收通过，翻房完成")).toBeVisible();
  await apiExpectRoomState(api, "210", "available", "clean");
  expect((await apiGetTask(api, task.id)).status).toBe("COMPLETED");

  /* ---------- 翻房闭环：下一笔 [today, today+2) 入住 SUCCESS ---------- */
  const guest2 = await apiCreateGuest(api, { name: "翻房后新客人", phone: "13900007777" });
  const room210 = await apiGetRoomByNumber(api, "210");
  const next = await apiCreateReservation(api, {
    guest_id: guest2.id,
    room_id: room210.id,
    room_type_id: room210.room_type_id,
    check_in_date: CHECK_IN,
    check_out_date: CHECK_OUT,
    agreed_total_amount: "428.00",
  });
  const checkedIn = await apiCheckIn(api, next.id);
  expect(checkedIn.reservation.status).toBe("CHECKED_IN");
  await apiExpectRoomState(api, "210", "occupied", "clean");

  await closeApi(api);
});

test("Rework 闭环：INSPECTION → 返工 → 重新清扫 → 通过（每步房态一致）", async ({
  page,
}) => {
  const api = await adminApi();

  /* ---------- 前置：退房自动任务（房间 209） ---------- */
  const task = await setupCheckoutTask(api, "209", "返工测试客人");

  /* ---------- HOUSEKEEPING UI 执行 ---------- */
  await login(page, housekeepingUsername(), housekeepingPassword());

  await uiTaskCardAction(page, "209", "开始清扫");
  await expect(page.getByText("房间 209 已开始清扫")).toBeVisible();
  await apiExpectRoomState(api, "209", "available", "cleaning");

  await uiTaskCardAction(page, "209", "提交验房");
  await expect(page.getByText("房间 209 已提交验房")).toBeVisible();
  await apiExpectRoomState(api, "209", "available", "inspection");

  // 返工（确认对话框）→ 房间 rework
  await uiTaskCardAction(page, "209", "返工");
  await uiConfirm(page, "确认返工");
  await expect(page.getByText("房间 209 已标记返工")).toBeVisible();
  expect((await apiGetTask(api, task.id)).status).toBe("REWORK");
  await apiExpectRoomState(api, "209", "available", "rework");

  // 返工后重新开始 → 提交 → 通过
  await uiTaskCardAction(page, "209", "开始清扫");
  await expect(page.getByText("房间 209 已开始清扫")).toBeVisible();
  await apiExpectRoomState(api, "209", "available", "cleaning");

  await uiTaskCardAction(page, "209", "提交验房");
  await expect(page.getByText("房间 209 已提交验房")).toBeVisible();
  await apiExpectRoomState(api, "209", "available", "inspection");

  await uiTaskCardAction(page, "209", "通过");
  await uiConfirm(page, "确认通过");
  await expect(page.getByText("房间 209 验收通过，翻房完成")).toBeVisible();
  expect((await apiGetTask(api, task.id)).status).toBe("COMPLETED");
  await apiExpectRoomState(api, "209", "available", "clean");

  await closeApi(api);
});

test("手动任务：FRONT_DESK 创建 + 重复 409 + admin 取消（房间 109）", async ({
  page,
}) => {
  const api = await adminApi();
  await apiSetRoomDirty(api, "109");
  const room109 = await apiGetRoomByNumber(api, "109");

  /* ---------- FRONT_DESK：新建任务（write） ---------- */
  await login(page, frontdeskUsername(), frontdeskPassword());
  await page.goto("/housekeeping");
  await expect(
    page.getByRole("heading", { name: "保洁运营" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "新建任务" }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("选择待清扫房间")
    .selectOption({ value: String(room109.id) });
  await dialog.getByRole("button", { name: "创建", exact: true }).click();
  await page.waitForURL(/\/housekeeping\/(\d+)/);
  await expect(
    page.getByRole("heading", { name: /保洁任务 HKT/ }),
  ).toBeVisible();
  await expect(
    page.locator("main").getByText("待清扫", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByText("手动创建")).toBeVisible();
  const taskId = Number(/\/housekeeping\/(\d+)/.exec(page.url())?.[1]);

  // FRONT_DESK 无 cancel 权限：不提供取消入口（后端 403 兜底见 safety spec）
  await expect(page.getByRole("button", { name: "取消任务" })).toHaveCount(0);

  /* ---------- 重复创建 → 409（Active Task 唯一） ---------- */
  await page.goto("/housekeeping");
  await page.getByRole("button", { name: "新建任务" }).click();
  const dialog2 = page.getByRole("dialog");
  await dialog2
    .getByLabel("选择待清扫房间")
    .selectOption({ value: String(room109.id) });
  await dialog2.getByRole("button", { name: "创建", exact: true }).click();
  await expect(
    dialog2.getByText("该房间已有进行中的保洁任务"),
  ).toBeVisible();
  await dialog2.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "退出" }).click();
  await expect(page).toHaveURL(/\/login/);

  /* ---------- admin：取消任务 → CANCELLED + 房间 dirty ---------- */
  await login(page, adminUsername(), adminPassword());
  await page.goto(`/housekeeping/${taskId}`);
  await expect(
    page.getByRole("heading", { name: /保洁任务 HKT/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "取消任务" }).click();
  await uiConfirm(page, "确认取消");
  await expect(page.getByText("任务已取消")).toBeVisible();
  expect((await apiGetTask(api, taskId)).status).toBe("CANCELLED");
  await apiExpectRoomState(api, "109", "available", "dirty");

  await closeApi(api);
});
