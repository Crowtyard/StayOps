/**
 * S5 Maintenance E2E 辅助（真实链路，禁止 Mock）：
 * - 直连真实 FastAPI（127.0.0.1:8001）的维修工单 API 数据构造/断言
 * - UI 工作台操作（HOUSEKEEPING / MANAGER / MAINTENANCE 真实浏览器）
 * - 房间归一化：取消预订/退房/取消保洁任务/恢复 available+clean
 *   （复用既有 spec 房间号段 301-308，测试开始前保证确定性）
 */

import { expect, type Page } from "@playwright/test";
import {
  apiGetRoomByNumber,
  apiSetRoomStatus,
  addDays,
  businessDate,
  type ApiSession,
} from "./booking-helpers";

export interface MwoApi {
  id: number;
  work_order_no: string;
  room_id: number;
  room_number: string;
  room_occupancy_status?: string;
  room_cleaning_status?: string;
  category: string;
  severity: string;
  status: string;
  source: string;
  blocks_room: boolean;
  title: string;
  assigned_to_user_id?: number | null;
  assignee_name?: string | null;
  [key: string]: unknown;
}

export async function apiListOrders(
  api: ApiSession,
  params: Record<string, string | number | boolean> = {},
): Promise<{ items: MwoApi[]; total: number }> {
  const resp = await api.ctx.get("/api/v1/maintenance/orders", {
    headers: api.headers,
    params,
  });
  expect(resp.status(), `工单列表失败：${await resp.text()}`).toBe(200);
  return (await resp.json()) as { items: MwoApi[]; total: number };
}

export async function apiGetOrder(
  api: ApiSession,
  orderId: number,
): Promise<MwoApi> {
  const resp = await api.ctx.get(`/api/v1/maintenance/orders/${orderId}`, {
    headers: api.headers,
  });
  expect(resp.status(), `工单详情失败：${await resp.text()}`).toBe(200);
  return (await resp.json()) as MwoApi;
}

export async function apiCreateOrder(
  api: ApiSession,
  roomId: number,
  opts: {
    category?: string;
    severity?: string;
    blocks_room?: boolean;
    source?: string;
    title?: string;
  } = {},
  expectStatus = 201,
): Promise<MwoApi> {
  const resp = await api.ctx.post("/api/v1/maintenance/orders", {
    headers: api.headers,
    data: {
      room_id: roomId,
      category: opts.category ?? "HVAC",
      severity: opts.severity ?? "MEDIUM",
      blocks_room: opts.blocks_room ?? false,
      source: opts.source ?? "MANUAL",
      title: opts.title ?? "E2E 维修工单",
    },
  });
  expect(
    resp.status(),
    `创建工单失败（${resp.status()}）：${await resp.text()}`,
  ).toBe(expectStatus);
  return (await resp.json()) as MwoApi;
}

export async function apiOrderAction(
  api: ApiSession,
  orderId: number,
  action: "start" | "resolve" | "verify" | "rework" | "cancel",
  expectStatus = 200,
): Promise<MwoApi> {
  const resp = await api.ctx.post(
    `/api/v1/maintenance/orders/${orderId}/${action}`,
    { headers: api.headers },
  );
  expect(
    resp.status(),
    `工单 ${action} 失败（${resp.status()}）：${await resp.text()}`,
  ).toBe(expectStatus);
  return (await resp.json()) as MwoApi;
}

export async function apiAssignOrder(
  api: ApiSession,
  orderId: number,
  userId: number,
): Promise<MwoApi> {
  const resp = await api.ctx.post(
    `/api/v1/maintenance/orders/${orderId}/assign`,
    {
      headers: api.headers,
      data: { assigned_to_user_id: userId },
    },
  );
  expect(resp.status(), `派工失败：${await resp.text()}`).toBe(200);
  return (await resp.json()) as MwoApi;
}

/** 取用户名对应的用户 id（admin 视角；用于派单目标） */
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
/* 房间归一化（Sprint 5 specs 复用 3xx 房间段，开始前保证确定性）       */
/* ------------------------------------------------------------------ */

/** 驱动清洁状态到 clean（沿合法状态机路径）。 */
export async function apiEnsureCleaning(
  api: ApiSession,
  roomId: number,
  target: string,
): Promise<void> {
  const room = (await api.ctx
    .get(`/api/v1/rooms/${roomId}`, { headers: api.headers })
    .then((r) => r.json())) as { cleaning_status: string };
  if (room.cleaning_status === target) return;
  await apiSetRoomStatus(api, roomId, { cleaning_status: target });
}

/** 把房间归一化为 available + clean（取消预订/退房/取消保洁任务/合法状态机路径）。 */
export async function apiEnsureRoomAvailableClean(
  api: ApiSession,
  roomNumber: string,
): Promise<void> {
  const room = await apiGetRoomByNumber(api, roomNumber);
  const roomId = room.id;

  // 1) 取消该房间全部 CONFIRMED 预订
  const resResp = await api.ctx.get("/api/v1/reservations", {
    headers: api.headers,
    params: { room_id: roomId, page: 1, page_size: 100 },
  });
  if (resResp.ok()) {
    const page = (await resResp.json()) as {
      items: { id: number; status: string }[];
    };
    for (const res of page.items) {
      if (res.status === "CONFIRMED") {
        await api.ctx.post(`/api/v1/reservations/${res.id}/cancel`, {
          headers: api.headers,
        });
      }
    }
  }

  // 2) 退掉 ACTIVE 在住
  const staysResp = await api.ctx.get("/api/v1/stays", {
    headers: api.headers,
    params: { room_id: roomId, status: "ACTIVE", page: 1, page_size: 100 },
  });
  if (staysResp.ok()) {
    const page = (await staysResp.json()) as {
      items: { id: number }[];
    };
    for (const stay of page.items) {
      await api.ctx.post(`/api/v1/stays/${stay.id}/check-out`, {
        headers: api.headers,
      });
    }
  }

  // 3) 取消进行中的保洁任务
  const hkResp = await api.ctx.get("/api/v1/housekeeping/tasks", {
    headers: api.headers,
    params: { room_id: roomId, page: 1, page_size: 100 },
  });
  if (hkResp.ok()) {
    const page = (await hkResp.json()) as {
      items: { id: number; status: string }[];
    };
    for (const task of page.items) {
      if (["PENDING", "IN_PROGRESS", "INSPECTION", "REWORK"].includes(task.status)) {
        await api.ctx.post(`/api/v1/housekeeping/tasks/${task.id}/cancel`, {
          headers: api.headers,
        });
      }
    }
  }

  // 4) 占用 → available（任意状态均有合法入边；已是 available 则跳过）
  const occupancyNow = await apiGetRoomByNumber(api, roomNumber);
  if (occupancyNow.occupancy_status !== "available") {
    await apiSetRoomStatus(api, roomId, { occupancy_status: "available" });
  }

  // 5) 清洁 → clean（沿合法路径 dirty→cleaning→clean）
  const current = await apiGetRoomByNumber(api, roomNumber);
  if (current.cleaning_status !== "clean") {
    if (current.cleaning_status === "dirty" || current.cleaning_status === "rework") {
      await apiSetRoomStatus(api, roomId, { cleaning_status: "cleaning" });
    }
    await apiSetRoomStatus(api, roomId, { cleaning_status: "clean" });
  }
}

export function futureDate(days: number): string {
  return addDays(businessDate(), days);
}

/* ------------------------------------------------------------------ */
/* UI 工作台操作                                                        */
/* ------------------------------------------------------------------ */

/** 打开维修工作台并定位指定房间的工单卡片（以房间链接为锚）。 */
export async function uiOrderCard(page: Page, roomNumber: string) {
  await page.goto("/maintenance");
  await expect(
    page.getByRole("heading", { name: "维修运营" }),
  ).toBeVisible();
  const link = page
    .getByRole("link", { name: `房间 ${roomNumber}`, exact: true })
    .first();
  await expect(link).toBeVisible({ timeout: 15_000 });
  const card = link.locator("xpath=ancestor::li[1]");
  await expect(card).toBeVisible();
  return card;
}

/** 在工单卡片内点击操作按钮（按权限与状态由页面决定显隐）。 */
export async function uiOrderCardAction(
  page: Page,
  roomNumber: string,
  buttonName: string,
): Promise<void> {
  const card = await uiOrderCard(page, roomNumber);
  await card.getByRole("button", { name: buttonName, exact: true }).click();
}

/** 确认对话框内确认。 */
export async function uiConfirm(page: Page, confirmLabel: string): Promise<void> {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: confirmLabel }).click();
}
