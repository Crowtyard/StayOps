/**
 * Sprint 6 Room Move E2E 辅助（真实链路，禁止 Mock）：
 * - API 会话：直连真实 FastAPI（127.0.0.1:8001）构造数据与断言
 * - UI 流程：浏览器经 /api/auth/login + /api/bff
 * 房间号段：复用种子房 301-308（测试开始前归一化；不新建房间）。
 */

import { expect, type Page } from "@playwright/test";
import {
  apiCheckIn,
  apiCreateGuest,
  apiCreateReservation,
  apiGetRoomByNumber,
  businessDate,
  todayPlus,
  type ApiSession,
} from "./booking-helpers";
import { apiEnsureRoomAvailableClean } from "./maintenance-helpers";
import { uiOpenFrontDesk } from "./front-desk-helpers";

export interface MoveSetupResult {
  guest: { id: number; name: string; phone: string | null };
  reservation: {
    id: number;
    reservation_no: string;
    room_id: number;
    stay_id?: number | null;
    [key: string]: unknown;
  };
  stay: {
    id: number;
    stay_no: string;
    room_id: number;
    [key: string]: unknown;
  };
  room: { id: number; room_number: string; [key: string]: unknown };
}

/** API：创建客人 + 预订 [today, today+2) + Check-in（返回 stay/room）。 */
export async function apiSetupCheckedInStay(
  api: ApiSession,
  roomNumber: string,
  guestName: string,
  guestPhone: string,
): Promise<MoveSetupResult> {
  const room = await apiGetRoomByNumber(api, roomNumber);
  const guest = await apiCreateGuest(api, { name: guestName, phone: guestPhone });
  const reservation = await apiCreateReservation(api, {
    guest_id: guest.id,
    room_id: room.id as number,
    room_type_id: room.room_type_id as number,
    check_in_date: businessDate(),
    check_out_date: todayPlus(2),
    agreed_total_amount: "399.00",
  });
  const { stay } = await apiCheckIn(api, reservation.id);
  return {
    guest,
    reservation: { ...reservation, stay_id: stay.id },
    stay: stay as MoveSetupResult["stay"],
    room,
  };
}

/** API：换房（expectStatus 用于并发/失败断言）。 */
export async function apiMoveStay(
  api: ApiSession,
  stayId: number,
  targetRoomId: number,
  reason: string,
  expectStatus = 200,
): Promise<unknown> {
  const resp = await api.ctx.post(`/api/v1/stays/${stayId}/room-move`, {
    headers: api.headers,
    data: { target_room_id: targetRoomId, reason },
  });
  expect(
    resp.status(),
    `换房失败（${resp.status()}）：${await resp.text()}`,
  ).toBe(expectStatus);
  return resp.json();
}

/** API：按房间查保洁任务（断言 ROOM_MOVE PENDING）。 */
export async function apiListTasksForRoom(
  api: ApiSession,
  roomId: number,
): Promise<{ items: { id: number; source: string; status: string; [key: string]: unknown }[] }> {
  const resp = await api.ctx.get("/api/v1/housekeeping/tasks", {
    headers: api.headers,
    params: { room_id: roomId, page: 1, page_size: 100 },
  });
  expect(resp.status(), `保洁任务查询失败：${await resp.text()}`).toBe(200);
  return (await resp.json()) as {
    items: { id: number; source: string; status: string; [key: string]: unknown }[];
  };
}

/** 归一化房间（供并发用例复用房间号段）。 */
export async function apiNormalizeRoom(
  api: ApiSession,
  roomNumber: string,
): Promise<void> {
  await apiEnsureRoomAvailableClean(api, roomNumber);
}

/* ------------------------------------------------------------------ */
/* UI 流程                                                             */
/* ------------------------------------------------------------------ */

/** Front Desk → 当前在住抽屉 → 对应 Stay 条目的 [换房] → 换房对话框。 */
export async function uiOpenMoveDialog(
  page: Page,
  stayNo: string,
): Promise<ReturnType<Page["getByRole"]>> {
  await uiOpenFrontDesk(page);
  await page.locator('[data-summary-card="inhouse"]').click();
  const drawer = page.getByRole("dialog", { name: "当前在住" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText(stayNo)).toBeVisible({ timeout: 15_000 });
  // 定位该 Stay 的条目（抽屉可能列出多个在住，避免点错）
  const item = drawer.locator("li").filter({ hasText: stayNo }).first();
  await item.getByRole("button", { name: "换房" }).click();
  // exact:true：抽屉标题「在住换房」包含「换房」子串，避免歧义
  const moveDialog = page.getByRole("dialog", { name: "换房", exact: true });
  await expect(moveDialog).toBeVisible();
  return moveDialog;
}

/** 换房对话框内：选目标房 → 校验确认摘要 → 选原因 → 显式确认换房。 */
export async function uiConfirmMove(
  page: Page,
  moveDialog: ReturnType<Page["getByRole"]>,
  targetRoomId: number,
  targetRoomNumber: string,
  reason: string,
  fromRoomNumber: string,
): Promise<void> {
  // option value = room_id（label 匹配为精确匹配，用 value 更稳）
  await moveDialog
    .getByLabel("目标房间")
    .selectOption(String(targetRoomId));
  await expect(
    moveDialog.getByText(
      new RegExp(`确认换房：${escapeRegExp(fromRoomNumber)} → ${targetRoomNumber}`),
    ),
  ).toBeVisible();
  await moveDialog.getByLabel("换房原因").selectOption(reason);
  await moveDialog.getByRole("button", { name: "确认换房" }).click();
  const confirm = page.getByRole("dialog", { name: "确认换房" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "确认换房" }).click();
}

/** 断言房间栏双状态（占用 + 清洁）。 */
export async function uiExpectRoomState(
  page: Page,
  roomNumber: string,
  occupancyLabel: string,
  cleaningLabel: string,
): Promise<void> {
  const cell = page.locator(`[data-room-cell="${roomNumber}"]`);
  await expect(cell.getByText(occupancyLabel, { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(cell.getByText(cleaningLabel, { exact: true })).toBeVisible();
}

/** 断言 Stay 占用条只画在指定房间轨道上（Sprint 6 §24）。 */
export async function uiExpectStayBarOnRoom(
  page: Page,
  roomNumber: string,
  stayNo: string,
  present: boolean,
): Promise<void> {
  const bar = page.locator(
    `[data-room-track="${roomNumber}"] [data-stay-bar="${stayNo}"]`,
  );
  if (present) {
    await expect(bar).toBeVisible();
  } else {
    await expect(bar).toHaveCount(0);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
