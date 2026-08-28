/**
 * Sprint 4 Front Desk E2E 辅助工具（真实链路，禁止 Mock）：
 * - UI 流程：浏览器经 /api/auth/login + /api/bff（浏览器不接触 Token）
 * - API 会话：直连真实 FastAPI（127.0.0.1:8001）构造数据
 * - 超期在住（规则 B）：真实 UPDATE 状态准备（setup_overdue_stay.py，见文件头说明）
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import {
  adminApi,
  apiCreateReservation,
  apiGetRoomByNumber,
  apiSetRoomStatus,
  closeApi,
  frontdeskApi,
  type ApiSession,
  type ReservationApi,
} from "./booking-helpers";
import { businessDate, todayPlus } from "./booking-helpers";
import { login } from "./helpers";

/* ------------------------------------------------------------------ */
/* UI：打开前台工作台                                                    */
/* ------------------------------------------------------------------ */

export async function uiOpenFrontDesk(page: Page): Promise<void> {
  await page.goto("/front-desk");
  await expect(page.getByRole("heading", { name: "前台指挥台" }).first()).toBeVisible();
}

/** 房间时间线轨道 / 房间栏 / 预订条。 */
export function roomTrack(page: Page, roomNumber: string) {
  return page.locator(`[data-room-track="${roomNumber}"]`);
}

export function roomCell(page: Page, roomNumber: string) {
  return page.locator(`[data-room-cell="${roomNumber}"]`);
}

export function reservationBar(page: Page, reservationNo: string) {
  return page.locator(`[data-reservation-bar="${reservationNo}"]`);
}

/** 断言房间栏双状态徽标。 */
export async function uiExpectRoomCellStatus(
  page: Page,
  roomNumber: string,
  occupancyLabel: string,
  cleaningLabel: string,
): Promise<void> {
  const cell = roomCell(page, roomNumber);
  await expect(cell.getByText(occupancyLabel, { exact: true })).toBeVisible();
  await expect(cell.getByText(cleaningLabel, { exact: true })).toBeVisible();
}

/**
 * 空白日期格 → 快捷菜单 → 新建预订（复用 /reservations/new）：
 * 断言预填（room / check_in / check_out=check_in+1）后经 UI 创建客人并提交。
 * 返回 { id, reservationNo }。
 */
export async function uiQuickCreateFromCell(
  page: Page,
  roomNumber: string,
  opts: {
    dayIndex: number; // 相对今天的列索引（0 = 今天）
    guestName: string;
    guestPhone: string;
    amount: string;
  },
): Promise<{ id: number; reservationNo: string }> {
  const checkIn = todayPlus(opts.dayIndex);
  const checkOut = todayPlus(opts.dayIndex + 1);

  await roomTrack(page, roomNumber).click({
    position: { x: 32 + opts.dayIndex * 64, y: 20 },
  });
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "新建预订" }).click();

  await page.waitForURL(/\/reservations\/new\?/);
  await expect(page.getByRole("heading", { name: "新建预订" })).toBeVisible();
  // 预填断言（check_out = check_in + 1）
  await expect(page.getByLabel("入住日期")).toHaveValue(checkIn);
  await expect(page.getByLabel("退房日期")).toHaveValue(checkOut);
  await expect(page.getByText(new RegExp(`已选择房间 ${roomNumber}`))).toBeVisible({
    timeout: 15_000,
  });

  // 创建客人（复用现有表单，不新造第二套）
  await page.getByRole("button", { name: "新建客人" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("姓名").fill(opts.guestName);
  await dialog.getByLabel("手机号").fill(opts.guestPhone);
  await dialog.getByRole("button", { name: "创建", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByText(new RegExp(`已选择客人：\\s*${escapeRegExp(opts.guestName)}`)),
  ).toBeVisible();

  await page.getByLabel("约定金额").fill(opts.amount);
  await page.getByRole("button", { name: "创建预订" }).click();
  await page.waitForURL(/\/reservations\/(\d+)/, { timeout: 15_000 });
  const id = Number(/\/reservations\/(\d+)/.exec(page.url())?.[1]);
  const heading = page.getByRole("heading", { name: /^预订 RSV/ });
  await expect(heading).toBeVisible();
  const reservationNo = (await heading.textContent())
    ?.replace("预订 ", "")
    .trim() ?? "";
  expect(reservationNo).toMatch(/^RSV\d{8}-\d{4,}$/);

  await page.goto("/front-desk");
  await expect(page.getByRole("heading", { name: "前台指挥台" }).first()).toBeVisible();
  return { id, reservationNo };
}

/* ------------------------------------------------------------------ */
/* API 数据构造（真实后端）                                              */
/* ------------------------------------------------------------------ */

/** 创建预订前把房间恢复为 available + clean（只提交变化的维度，避免同状态 409）。 */
export async function apiEnsureAvailableClean(
  api: ApiSession,
  roomNumber: string,
): Promise<void> {
  const room = await apiGetRoomByNumber(api, roomNumber);
  const body: Record<string, string> = {};
  if (room.occupancy_status !== "available") {
    body.occupancy_status = "available";
  }
  if (room.cleaning_status !== "clean") {
    body.cleaning_status = "clean";
  }
  if (Object.keys(body).length > 0) {
    await apiSetRoomStatus(api, room.id as number, body);
  }
}

/** 把房间清洁状态置为指定值（只提交变化的维度，避免同状态 409）。 */
export async function apiEnsureCleaning(
  api: ApiSession,
  roomNumber: string,
  cleaning: string,
): Promise<void> {
  const room = await apiGetRoomByNumber(api, roomNumber);
  if (room.cleaning_status !== cleaning) {
    await apiSetRoomStatus(api, room.id as number, {
      cleaning_status: cleaning,
    });
  }
}

/** 把房间占用状态置为指定值（只提交变化的维度，避免同状态 409）。 */
export async function apiEnsureOccupancy(
  api: ApiSession,
  roomNumber: string,
  occupancy: string,
): Promise<void> {
  const room = await apiGetRoomByNumber(api, roomNumber);
  if (room.occupancy_status !== occupancy) {
    await apiSetRoomStatus(api, room.id as number, {
      occupancy_status: occupancy,
    });
  }
}

/** 创建预订并返回（source DIRECT）。 */
export async function apiBook(
  api: ApiSession,
  roomNumber: string,
  guestId: number,
  checkIn: string,
  checkOut: string,
): Promise<ReservationApi> {
  const room = await apiGetRoomByNumber(api, roomNumber);
  return apiCreateReservation(api, {
    guest_id: guestId,
    room_id: room.id as number,
    room_type_id: room.room_type_id as number,
    check_in_date: checkIn,
    check_out_date: checkOut,
    agreed_total_amount: "399.00",
  });
}

/** 手动创建保洁任务（FRONT_DESK housekeeping_task:write）。 */
export async function apiCreateTask(
  api: ApiSession,
  roomId: number,
): Promise<{ id: number; task_no: string }> {
  const resp = await api.ctx.post("/api/v1/housekeeping/tasks", {
    headers: api.headers,
    data: { room_id: roomId, priority: "URGENT", notes: "E2E 到店前翻房" },
  });
  expect(resp.status(), `创建保洁任务失败：${await resp.text()}`).toBe(201);
  return (await resp.json()) as { id: number; task_no: string };
}

/** 以管理员完成保洁闭环（start → submit → pass），房间变 clean。 */
export async function apiCompleteTask(taskId: number): Promise<void> {
  const api = await adminApi();
  for (const action of ["start", "submit-inspection", "pass"]) {
    const resp = await api.ctx.post(
      `/api/v1/housekeeping/tasks/${taskId}/${action}`,
      { headers: api.headers },
    );
    expect(resp.status(), `${action} 失败：${await resp.text()}`).toBe(200);
  }
  await closeApi(api);
}

/**
 * 将 ACTIVE Stay 置为超期在住（规则 B 状态准备）：
 * 真实 UPDATE planned_check_out_date = business_date - 1（见 setup_overdue_stay.py）。
 */
export function makeStayOverdue(stayId: number): void {
  const python = path.resolve(
    __dirname,
    "..",
    "..",
    "backend",
    ".venv",
    "Scripts",
    "python.exe",
  );
  const script = path.resolve(__dirname, "setup_overdue_stay.py");
  const out = execFileSync(python, [script, String(stayId)], {
    encoding: "utf8",
    cwd: path.resolve(__dirname, ".."),
  });
  expect(out.trim(), "超期在住状态准备失败").toMatch(/^OK /);
}

/* ------------------------------------------------------------------ */
/* RBAC / PII：创建指定权限集合的用户（真实角色+权限 API）                 */
/* ------------------------------------------------------------------ */

export async function apiCreatePermissionUser(
  username: string,
  permissionCodes: string[],
  roleName = `ROLE_E2E_${username}`,
): Promise<void> {
  const api = await adminApi();
  const permsResp = await api.ctx.get("/api/v1/permissions", {
    headers: api.headers,
    params: { page: 1, page_size: 100 },
  });
  expect(permsResp.ok()).toBeTruthy();
  const perms = (await permsResp.json()) as {
    items: { code: string; id: number }[];
  };
  const byCode = new Map(perms.items.map((p) => [p.code, p.id]));

  const roleResp = await api.ctx.post("/api/v1/roles", {
    headers: api.headers,
    data: { name: roleName, description: "E2E Sprint 4 权限矩阵" },
  });
  expect(roleResp.status(), `创建角色失败：${await roleResp.text()}`).toBe(201);
  const role = (await roleResp.json()) as { id: number };

  const assignPerms = await api.ctx.post(
    `/api/v1/roles/${role.id}/permissions`,
    {
      headers: api.headers,
      data: {
        permission_ids: permissionCodes.map((c) => {
          const id = byCode.get(c);
          if (id === undefined) throw new Error(`未知权限 ${c}`);
          return id;
        }),
      },
    },
  );
  expect(assignPerms.ok()).toBeTruthy();

  const userResp = await api.ctx.post("/api/v1/users", {
    headers: api.headers,
    data: { username, password: "User@123456", is_active: true },
  });
  expect(userResp.status(), `创建用户失败：${await userResp.text()}`).toBe(201);
  const user = (await userResp.json()) as { id: number };
  const assignRole = await api.ctx.post(`/api/v1/users/${user.id}/roles`, {
    headers: api.headers,
    data: { role_ids: [role.id] },
  });
  expect(assignRole.ok()).toBeTruthy();
  await closeApi(api);
}

export { businessDate, frontdeskApi, login, todayPlus };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
