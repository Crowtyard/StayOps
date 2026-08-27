/**
 * S2-T3 Booking E2E 辅助工具（真实链路，禁止 Mock）：
 * - 动态日期：Property Business Date = Asia/Shanghai（IANA 时区，禁止硬编码年月日）
 * - API 会话：request.newContext 直连真实 FastAPI（127.0.0.1:8001）＋ Bearer，
 *   仅用于测试数据构造与并发 HTTP 断言（真实后端 + 真实 stayops_test 库）
 * - UI 流程：浏览器经 /api/auth/login + /api/bff（浏览器不接触 Token）
 */

import {
  expect,
  request,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import {
  adminPassword,
  adminUsername,
  frontdeskPassword,
  frontdeskUsername,
} from "./helpers";

export const BACKEND_URL = "http://127.0.0.1:8001";

/* ------------------------------------------------------------------ */
/* 动态日期（Property Business Date = Asia/Shanghai，REV-03）           */
/* ------------------------------------------------------------------ */

/** Asia/Shanghai 当前业务日期（YYYY-MM-DD），与宿主机时区无关 */
export function businessDate(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** 日期加减天数（输入输出 YYYY-MM-DD；纯日期算术，无时区依赖） */
export function addDays(dateStr: string, days: number): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 业务日期 today + N */
export function todayPlus(days: number): string {
  return addDays(businessDate(), days);
}

/* ------------------------------------------------------------------ */
/* 直连真实后端的 API 会话（Bearer 认证）                               */
/* ------------------------------------------------------------------ */

export interface ApiSession {
  ctx: APIRequestContext;
  headers: { Authorization: string };
}

export async function apiLogin(
  username: string,
  password: string,
): Promise<ApiSession> {
  const ctx = await request.newContext({ baseURL: BACKEND_URL });
  const resp = await ctx.post("/api/v1/auth/login", {
    data: { username, password },
  });
  if (!resp.ok()) {
    throw new Error(
      `API 登录失败（${username}，${resp.status()}）：${await resp.text()}`,
    );
  }
  const body = (await resp.json()) as { access_token: string };
  return { ctx, headers: { Authorization: `Bearer ${body.access_token}` } };
}

export async function adminApi(): Promise<ApiSession> {
  return apiLogin(adminUsername(), adminPassword());
}

export async function frontdeskApi(): Promise<ApiSession> {
  return apiLogin(frontdeskUsername(), frontdeskPassword());
}

export async function closeApi(api: ApiSession): Promise<void> {
  await api.ctx.dispose();
}

/* ------------------------------------------------------------------ */
/* API 数据构造与断言（真实后端）                                       */
/* ------------------------------------------------------------------ */

export interface RoomApi {
  id: number;
  room_number: string;
  room_type_id: number;
  occupancy_status: string;
  cleaning_status: string;
  [key: string]: unknown;
}

export async function apiGetRoomByNumber(
  api: ApiSession,
  roomNumber: string,
): Promise<RoomApi> {
  const resp = await api.ctx.get("/api/v1/rooms", {
    headers: api.headers,
    params: { page: 1, page_size: 100 },
  });
  expect(resp.status(), `读取房间列表失败：${await resp.text()}`).toBe(200);
  const data = (await resp.json()) as { items: RoomApi[] };
  const room = data.items.find((r) => r.room_number === roomNumber);
  expect(room, `种子房间 ${roomNumber} 应存在`).toBeTruthy();
  return room as RoomApi;
}

export async function apiExpectRoomState(
  api: ApiSession,
  roomNumber: string,
  occupancyStatus: string,
  cleaningStatus: string,
): Promise<void> {
  const room = await apiGetRoomByNumber(api, roomNumber);
  expect(room.occupancy_status, `房间 ${roomNumber} 占用状态`).toBe(
    occupancyStatus,
  );
  expect(room.cleaning_status, `房间 ${roomNumber} 清洁状态`).toBe(
    cleaningStatus,
  );
}

export async function apiSetRoomStatus(
  api: ApiSession,
  roomId: number,
  body: Record<string, string>,
): Promise<unknown> {
  const resp = await api.ctx.post(`/api/v1/rooms/${roomId}/status`, {
    headers: api.headers,
    data: body,
  });
  expect(resp.status(), `修改房间 ${roomId} 状态失败：${await resp.text()}`).toBe(
    200,
  );
  return resp.json();
}

export interface GuestApi {
  id: number;
  name: string;
  phone: string | null;
  email: string | null;
  notes: string | null;
}

export async function apiCreateGuest(
  api: ApiSession,
  guest: { name: string; phone?: string; email?: string; notes?: string },
): Promise<GuestApi> {
  const resp = await api.ctx.post("/api/v1/guests", {
    headers: api.headers,
    data: {
      name: guest.name,
      phone: guest.phone ?? null,
      email: guest.email ?? null,
      notes: guest.notes ?? null,
    },
  });
  expect(resp.status(), `创建客人失败：${await resp.text()}`).toBe(201);
  return (await resp.json()) as GuestApi;
}

export interface ReservationApi {
  id: number;
  reservation_no: string;
  guest_id: number;
  room_id: number;
  room_type_id: number;
  check_in_date: string;
  check_out_date: string;
  status: string;
  source: string;
  stay_id?: number | null;
  guest_name?: string | null;
  [key: string]: unknown;
}

export async function apiCreateReservation(
  api: ApiSession,
  payload: {
    guest_id: number;
    room_id: number;
    room_type_id: number;
    check_in_date: string;
    check_out_date: string;
    source?: string;
    agreed_total_amount: string;
  },
): Promise<ReservationApi> {
  const resp = await api.ctx.post("/api/v1/reservations", {
    headers: api.headers,
    data: {
      source: "DIRECT",
      ...payload,
    },
  });
  expect(
    resp.status(),
    `创建预订失败（${resp.status()}）：${await resp.text()}`,
  ).toBe(201);
  return (await resp.json()) as ReservationApi;
}

export interface StayApi {
  id: number;
  stay_no: string;
  reservation_id: number;
  room_id: number;
  status: string;
  actual_check_in_at: string | null;
  actual_check_out_at: string | null;
  [key: string]: unknown;
}

export async function apiCheckIn(
  api: ApiSession,
  reservationId: number,
): Promise<{ reservation: ReservationApi; stay: StayApi }> {
  const resp = await api.ctx.post(`/api/v1/reservations/${reservationId}/check-in`, {
    headers: api.headers,
  });
  expect(
    resp.status(),
    `Check-in 失败（${resp.status()}）：${await resp.text()}`,
  ).toBe(200);
  return (await resp.json()) as { reservation: ReservationApi; stay: StayApi };
}

export async function apiCheckOut(api: ApiSession, stayId: number): Promise<StayApi> {
  const resp = await api.ctx.post(`/api/v1/stays/${stayId}/check-out`, {
    headers: api.headers,
  });
  expect(
    resp.status(),
    `Check-out 失败（${resp.status()}）：${await resp.text()}`,
  ).toBe(200);
  return (await resp.json()) as StayApi;
}

export async function apiCancelReservation(
  api: ApiSession,
  reservationId: number,
): Promise<ReservationApi> {
  const resp = await api.ctx.post(`/api/v1/reservations/${reservationId}/cancel`, {
    headers: api.headers,
  });
  expect(
    resp.status(),
    `取消失败（${resp.status()}）：${await resp.text()}`,
  ).toBe(200);
  return (await resp.json()) as ReservationApi;
}

export async function apiGetReservation(
  api: ApiSession,
  reservationId: number,
): Promise<ReservationApi> {
  const resp = await api.ctx.get(`/api/v1/reservations/${reservationId}`, {
    headers: api.headers,
  });
  expect(resp.status()).toBe(200);
  return (await resp.json()) as ReservationApi;
}

export async function apiGetStay(api: ApiSession, stayId: number): Promise<StayApi> {
  const resp = await api.ctx.get(`/api/v1/stays/${stayId}`, {
    headers: api.headers,
  });
  expect(resp.status()).toBe(200);
  return (await resp.json()) as StayApi;
}

export async function apiListStays(
  api: ApiSession,
  params: Record<string, string | number>,
): Promise<{ items: StayApi[]; total: number }> {
  const resp = await api.ctx.get("/api/v1/stays", {
    headers: api.headers,
    params,
  });
  expect(resp.status()).toBe(200);
  return (await resp.json()) as { items: StayApi[]; total: number };
}

export async function apiListReservations(
  api: ApiSession,
  params: Record<string, string | number>,
): Promise<{ items: ReservationApi[]; total: number }> {
  const resp = await api.ctx.get("/api/v1/reservations", {
    headers: api.headers,
    params,
  });
  expect(resp.status()).toBe(200);
  return (await resp.json()) as { items: ReservationApi[]; total: number };
}

export interface AuditApi {
  id: number;
  action: string;
  resource_type: string | null;
  resource_id: number | null;
  details: Record<string, unknown> | null;
  [key: string]: unknown;
}

export async function apiListAuditLogs(
  api: ApiSession,
  params: Record<string, string | number>,
): Promise<{ items: AuditApi[]; total: number }> {
  const resp = await api.ctx.get("/api/v1/audit-logs", {
    headers: api.headers,
    params,
  });
  expect(resp.status()).toBe(200);
  return (await resp.json()) as { items: AuditApi[]; total: number };
}

/* ------------------------------------------------------------------ */
/* UI 流程（浏览器 → BFF → FastAPI → stayops_test，全程真实链路）       */
/* ------------------------------------------------------------------ */

export interface GuestCreateSpec {
  name: string;
  phone?: string;
  email?: string;
  notes?: string;
}

export interface ReservationUIOptions {
  /** 新建客人（模态框）或搜索已有客人 */
  guest: { create: GuestCreateSpec } | { search: string; pick: string };
  checkIn: string;
  checkOut: string;
  roomNumber: string;
  source: string;
  amount: string;
  notes?: string;
}

/**
 * 经 UI 完整创建预订（/reservations/new）：
 * Guest 创建/搜索 → 日期 → 真实 Availability → 选房 → 来源/金额 → 提交。
 * 成功跳转 /reservations/{id}，返回 id 与 reservation_no。
 */
export async function uiCreateReservation(
  page: Page,
  opts: ReservationUIOptions,
): Promise<{ id: number; reservationNo: string }> {
  await page.goto("/reservations/new");
  await expect(
    page.getByRole("heading", { name: "新建预订" }),
  ).toBeVisible();

  await pickGuest(page, opts.guest);

  await page.getByLabel("入住日期").fill(opts.checkIn);
  await page.getByLabel("退房日期").fill(opts.checkOut);

  // 真实 GET /availability 结果加载：等待目标房间按钮出现
  const roomButton = page.getByRole("button", {
    name: new RegExp(`^${opts.roomNumber}\\s`),
  });
  await expect(roomButton).toBeVisible({ timeout: 15_000 });
  await roomButton.click();
  await expect(page.getByText(`已选择房间 ${opts.roomNumber}`)).toBeVisible();

  await page.getByLabel("预订来源").selectOption(opts.source);
  await page.getByLabel("约定金额").fill(opts.amount);
  if (opts.notes !== undefined) {
    await page.getByLabel("预订备注").fill(opts.notes);
  }

  await page.getByRole("button", { name: "创建预订" }).click();
  await page.waitForURL(/\/reservations\/(\d+)/, { timeout: 15_000 });
  const id = Number(/\/reservations\/(\d+)/.exec(page.url())?.[1]);

  const heading = page.getByRole("heading", { name: /^预订 RSV/ });
  await expect(heading).toBeVisible();
  const reservationNo = (await heading.textContent())?.replace("预订 ", "").trim() ?? "";
  expect(reservationNo).toMatch(/^RSV\d{8}-\d{4,}$/);
  return { id, reservationNo };
}

async function pickGuest(
  page: Page,
  guest: ReservationUIOptions["guest"],
): Promise<void> {
  if ("create" in guest) {
    // 未搜索时页面只有一个「新建客人」按钮（空结果区按钮仅在搜索无结果时出现）
    await page.getByRole("button", { name: "新建客人" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("姓名").fill(guest.create.name);
    if (guest.create.phone !== undefined) {
      await dialog.getByLabel("手机号").fill(guest.create.phone);
    }
    if (guest.create.email !== undefined) {
      await dialog.getByLabel("邮箱").fill(guest.create.email);
    }
    if (guest.create.notes !== undefined) {
      await dialog.getByLabel("备注").fill(guest.create.notes);
    }
    await dialog.getByRole("button", { name: "创建", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(
      page.getByText(new RegExp(`已选择客人：\\s*${escapeRegExp(guest.create.name)}`)),
    ).toBeVisible();
    return;
  }
  await page.getByLabel("搜索客人").fill(guest.search);
  const resultButton = page.getByRole("button", {
    name: new RegExp(escapeRegExp(guest.pick)),
  });
  await expect(resultButton).toBeVisible({ timeout: 10_000 });
  await resultButton.click();
  await expect(
    page.getByText(new RegExp(`已选择客人：\\s*${escapeRegExp(guest.pick)}`)),
  ).toBeVisible();
}

/** UI 层验证重叠预订：目标房间禁用且展示后端原因（不提交） */
export async function uiExpectRoomUnavailable(
  page: Page,
  opts: {
    guest: { search: string; pick: string };
    checkIn: string;
    checkOut: string;
    roomNumber: string;
    reasonSubstring: string;
  },
): Promise<void> {
  await page.goto("/reservations/new");
  await expect(
    page.getByRole("heading", { name: "新建预订" }),
  ).toBeVisible();
  await pickGuest(page, opts.guest);
  await page.getByLabel("入住日期").fill(opts.checkIn);
  await page.getByLabel("退房日期").fill(opts.checkOut);

  const roomButton = page.getByRole("button", {
    name: new RegExp(`^${opts.roomNumber}\\s`),
  });
  await expect(roomButton).toBeVisible({ timeout: 15_000 });
  await expect(roomButton).toBeDisabled();
  await expect(roomButton).toContainText(opts.reasonSubstring);
}

/** 经 UI 办理入住（确认对话框）；返回 Stay id */
export async function uiCheckIn(page: Page, reservationId: number): Promise<number> {
  await page.goto(`/reservations/${reservationId}`);
  await expect(page.getByRole("heading", { name: /^预订 RSV/ })).toBeVisible();
  await page.getByRole("button", { name: "办理入住" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "办理入住" }).click();
  await page.waitForURL(/\/stays\/(\d+)/, { timeout: 15_000 });
  const stayId = Number(/\/stays\/(\d+)/.exec(page.url())?.[1]);
  await expect(page.getByRole("heading", { name: /^入住 STY/ })).toBeVisible();
  return stayId;
}

/** 经 UI 办理退房（确认对话框）；等待成功提示 */
export async function uiCheckOut(page: Page, stayId: number): Promise<void> {
  await page.goto(`/stays/${stayId}`);
  await expect(page.getByRole("heading", { name: /^入住 STY/ })).toBeVisible();
  await page.getByRole("button", { name: "办理退房" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "确认退房" }).click();
  await expect(
    page.getByText("退房完成：房间已置为可售 + 待清扫"),
  ).toBeVisible({ timeout: 15_000 });
}

/** 打开预订详情并断言状态徽标文案（刷新后同样适用） */
export async function uiExpectReservationStatus(
  page: Page,
  reservationId: number,
  statusLabel: string,
): Promise<void> {
  await page.goto(`/reservations/${reservationId}`);
  await expect(page.getByRole("heading", { name: /^预订 RSV/ })).toBeVisible();
  await expect(page.locator("main").getByText(statusLabel, { exact: true }).first()).toBeVisible();
}

/** 打开在住详情并断言 Stay 状态徽标文案（刷新后同样适用） */
export async function uiExpectStayStatus(
  page: Page,
  stayId: number,
  statusLabel: string,
): Promise<void> {
  await page.goto(`/stays/${stayId}`);
  await expect(page.getByRole("heading", { name: /^入住 STY/ })).toBeVisible();
  await expect(page.locator("main").getByText(statusLabel, { exact: true }).first()).toBeVisible();
}

/** 在住详情页断言房间现场状态徽标（占用 + 清洁两个维度；精确限定在状态卡片内） */
export async function uiExpectRoomBadgesOnStayPage(
  page: Page,
  stayId: number,
  occupancyLabel: string,
  cleaningLabel: string,
): Promise<void> {
  await page.goto(`/stays/${stayId}`);
  await expect(page.getByRole("heading", { name: /^入住 STY/ })).toBeVisible();
  const title = page.getByText("房间现场状态", { exact: true });
  await expect(title).toBeVisible();
  const card = title.locator(
    "xpath=ancestor::div[contains(@class,'rounded-lg')][1]",
  );
  await expect(card.getByText(occupancyLabel, { exact: true })).toBeVisible();
  await expect(card.getByText(cleaningLabel, { exact: true })).toBeVisible();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
