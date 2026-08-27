/**
 * S3 Housekeeping E2E 辅助（真实链路，禁止 Mock）：
 * - 直连真实 FastAPI（127.0.0.1:8001）的任务 API 数据构造/断言
 * - UI 工作台快捷操作（HOUSEKEEPING / FRONT_DESK 真实浏览器）
 */

import { expect, type Page } from "@playwright/test";
import {
  apiGetRoomByNumber,
  apiSetRoomStatus,
  type ApiSession,
} from "./booking-helpers";

export interface HkTaskApi {
  id: number;
  task_no: string;
  room_id: number;
  room_number: string;
  status: string;
  priority: string;
  source: string;
  assigned_to_user_id?: number | null;
  assignee_name?: string | null;
  [key: string]: unknown;
}

export async function apiListTasks(
  api: ApiSession,
  params: Record<string, string | number> = {},
): Promise<{ items: HkTaskApi[]; total: number }> {
  const resp = await api.ctx.get("/api/v1/housekeeping/tasks", {
    headers: api.headers,
    params,
  });
  expect(resp.status(), `任务列表失败：${await resp.text()}`).toBe(200);
  return (await resp.json()) as { items: HkTaskApi[]; total: number };
}

export async function apiGetTask(api: ApiSession, taskId: number): Promise<HkTaskApi> {
  const resp = await api.ctx.get(`/api/v1/housekeeping/tasks/${taskId}`, {
    headers: api.headers,
  });
  expect(resp.status()).toBe(200);
  return (await resp.json()) as HkTaskApi;
}

/** 按房号取进行中任务（PENDING/IN_PROGRESS/INSPECTION/REWORK） */
export async function apiGetActiveTaskByRoom(
  api: ApiSession,
  roomNumber: string,
): Promise<HkTaskApi> {
  const room = await apiGetRoomByNumber(api, roomNumber);
  const list = await apiListTasks(api, { room_id: room.id, page_size: 20 });
  const active = list.items.find((t) =>
    ["PENDING", "IN_PROGRESS", "INSPECTION", "REWORK"].includes(t.status),
  );
  expect(active, `房间 ${roomNumber} 应有进行中保洁任务`).toBeTruthy();
  return active as HkTaskApi;
}

export async function apiCreateTask(
  api: ApiSession,
  roomId: number,
  opts: { priority?: string; notes?: string } = {},
  expectStatus = 201,
): Promise<HkTaskApi> {
  const resp = await api.ctx.post("/api/v1/housekeeping/tasks", {
    headers: api.headers,
    data: {
      room_id: roomId,
      priority: opts.priority ?? "NORMAL",
      notes: opts.notes ?? null,
    },
  });
  expect(
    resp.status(),
    `创建任务失败（${resp.status()}）：${await resp.text()}`,
  ).toBe(expectStatus);
  return (await resp.json()) as HkTaskApi;
}

export async function apiTaskAction(
  api: ApiSession,
  taskId: number,
  action: "start" | "submit-inspection" | "pass" | "rework" | "cancel",
  expectStatus = 200,
): Promise<HkTaskApi> {
  const resp = await api.ctx.post(
    `/api/v1/housekeeping/tasks/${taskId}/${action}`,
    { headers: api.headers },
  );
  expect(
    resp.status(),
    `任务 ${action} 失败（${resp.status()}）：${await resp.text()}`,
  ).toBe(expectStatus);
  return (await resp.json()) as HkTaskApi;
}

export async function apiAssignTask(
  api: ApiSession,
  taskId: number,
  userId: number | null,
): Promise<HkTaskApi> {
  const resp = await api.ctx.patch(`/api/v1/housekeeping/tasks/${taskId}`, {
    headers: api.headers,
    data: { assigned_to_user_id: userId },
  });
  expect(resp.status(), `派单失败：${await resp.text()}`).toBe(200);
  return (await resp.json()) as HkTaskApi;
}

/** API 快速完成清扫链：start → submit → pass（翻房闭环） */
export async function apiCompleteTaskChain(
  api: ApiSession,
  taskId: number,
): Promise<void> {
  await apiTaskAction(api, taskId, "start");
  await apiTaskAction(api, taskId, "submit-inspection");
  await apiTaskAction(api, taskId, "pass");
}

export async function apiSetRoomDirty(
  api: ApiSession,
  roomNumber: string,
): Promise<void> {
  const room = await apiGetRoomByNumber(api, roomNumber);
  if (room.cleaning_status === "dirty") return; // 幂等：已是脏房
  await apiSetRoomStatus(api, room.id, { cleaning_status: "dirty" });
}

/** 取用户名对应的用户 id（admin 视角；用于派单） */
export async function apiFindUserId(
  api: ApiSession,
  username: string,
): Promise<number> {
  const resp = await api.ctx.get("/api/v1/users", {
    headers: api.headers,
    params: { page: 1, page_size: 100 },
  });
  expect(resp.status()).toBe(200);
  const pageData = (await resp.json()) as {
    items: { id: number; username: string }[];
  };
  const user = pageData.items.find((u) => u.username === username);
  expect(user, `用户 ${username} 应存在`).toBeTruthy();
  return (user as { id: number }).id;
}

/* ------------------------------------------------------------------ */
/* UI 工作台操作                                                        */
/* ------------------------------------------------------------------ */

/** 打开保洁工作台并定位指定房间的任务卡片（以房间链接为锚，避免文本归一化歧义） */
export async function uiTaskCard(page: Page, roomNumber: string) {
  await page.goto("/housekeeping");
  await expect(
    page.getByRole("heading", { name: "保洁运营" }),
  ).toBeVisible();
  const link = page.getByRole("link", { name: `房间 ${roomNumber}`, exact: true }).first();
  await expect(link).toBeVisible({ timeout: 15_000 });
  const card = link.locator("xpath=ancestor::li[1]");
  await expect(card).toBeVisible();
  return card;
}

/** 在任务卡片内点击操作按钮（start/submit/pass/rework/cancel 由权限与状态决定） */
export async function uiTaskCardAction(
  page: Page,
  roomNumber: string,
  buttonName: string,
): Promise<void> {
  const card = await uiTaskCard(page, roomNumber);
  await card.getByRole("button", { name: buttonName, exact: true }).click();
}

/** 确认对话框内确认（pass / rework / cancel） */
export async function uiConfirm(page: Page, confirmLabel: string): Promise<void> {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: confirmLabel }).click();
}
