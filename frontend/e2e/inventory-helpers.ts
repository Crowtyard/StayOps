/**
 * S7 Inventory & Procurement E2E 辅助（真实链路，禁止 Mock）：
 * - 直连真实 FastAPI（127.0.0.1:8001）的库存/采购 API 数据构造与断言
 * - UI 流程：浏览器经 /api/auth/login + /api/bff（浏览器不接触 Token）
 * - 测试库 stayops_test 每次运行重建（prepare_test_db.py），
 *   物资代码使用固定 E2E 前缀（不依赖手工残留数据）
 */

import { expect, type Page } from "@playwright/test";
import { adminApi, type ApiSession } from "./booking-helpers";
import { login } from "./helpers";

export interface InventoryItemApi {
  id: number;
  item_code: string;
  name: string;
  category: string;
  base_unit: string;
  minimum_stock: string;
  target_stock: string;
  is_active: boolean;
  [key: string]: unknown;
}

export interface InventoryLocationApi {
  id: number;
  location_code: string;
  name: string;
  is_active: boolean;
  [key: string]: unknown;
}

export interface InventoryItemDetailApi {
  id: number;
  item_code: string;
  total_stock: string;
  stock_status: string;
  recommended_replenishment: string;
  balances: {
    id: number;
    location_id: number;
    location_name: string | null;
    location_active: boolean;
    quantity: string;
  }[];
  recent_movements: {
    id: number;
    movement_no: string;
    movement_type: string;
    quantity: string;
    location_name: string | null;
    operator_name: string | null;
  }[];
  [key: string]: unknown;
}

export async function adminSession(): Promise<ApiSession> {
  return adminApi();
}

export async function apiLocations(api: ApiSession): Promise<InventoryLocationApi[]> {
  const resp = await api.ctx.get("/api/v1/inventory/locations", {
    headers: api.headers,
    params: { page_size: 100 },
  });
  expect(resp.status(), `地点列表失败：${await resp.text()}`).toBe(200);
  return ((await resp.json()) as { items: InventoryLocationApi[] }).items;
}

export async function apiLocationByCode(
  api: ApiSession,
  code: string,
): Promise<InventoryLocationApi> {
  const items = await apiLocations(api);
  const location = items.find((loc) => loc.location_code === code);
  if (!location) throw new Error(`缺少库存地点 ${code}`);
  return location;
}

export async function apiCreateItem(
  api: ApiSession,
  opts: {
    code: string;
    name?: string;
    category?: string;
    baseUnit?: string;
    minimum?: string;
    target?: string;
  },
): Promise<InventoryItemApi> {
  const resp = await api.ctx.post("/api/v1/inventory/items", {
    headers: api.headers,
    data: {
      item_code: opts.code,
      name: opts.name ?? opts.code,
      category: opts.category ?? "GUEST_AMENITY",
      base_unit: opts.baseUnit ?? "个",
      minimum_stock: opts.minimum ?? "0",
      target_stock: opts.target ?? "0",
    },
  });
  expect(resp.status(), `创建物资失败（${resp.status()}）：${await resp.text()}`).toBe(201);
  return (await resp.json()) as InventoryItemApi;
}

export async function apiSetInitialStock(
  api: ApiSession,
  itemId: number,
  locationId: number,
  quantity: string,
): Promise<void> {
  const resp = await api.ctx.post(
    `/api/v1/inventory/items/${itemId}/initial-stock`,
    {
      headers: api.headers,
      data: { location_id: locationId, quantity, reason: "E2E 期初" },
    },
  );
  expect(resp.status(), `期初库存失败：${await resp.text()}`).toBe(200);
}

export async function apiItemDetail(
  api: ApiSession,
  itemId: number,
): Promise<InventoryItemDetailApi> {
  const resp = await api.ctx.get(`/api/v1/inventory/items/${itemId}`, {
    headers: api.headers,
  });
  expect(resp.status(), `物资详情失败：${await resp.text()}`).toBe(200);
  return (await resp.json()) as InventoryItemDetailApi;
}

export async function apiCreateSupplier(
  api: ApiSession,
  code: string,
  name?: string,
): Promise<{ id: number; supplier_code: string }> {
  const resp = await api.ctx.post("/api/v1/procurement/suppliers", {
    headers: api.headers,
    data: { supplier_code: code, name: name ?? code },
  });
  expect(resp.status(), `创建供应商失败：${await resp.text()}`).toBe(201);
  return (await resp.json()) as { id: number; supplier_code: string };
}

/* ------------------------------------------------------------------ */
/* UI 流程                                                            */
/* ------------------------------------------------------------------ */

export async function loginAdmin(page: Page): Promise<void> {
  const username = process.env.E2E_ADMIN_USERNAME;
  const password = process.env.E2E_ADMIN_PASSWORD;
  if (!username || !password) {
    throw new Error("缺少 E2E 管理员凭据");
  }
  await login(page, username, password);
}

export async function openInventory(page: Page): Promise<void> {
  await page.getByRole("link", { name: "库存", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "库存管理" }),
  ).toBeVisible();
}

/** 工作台表格中指定物资代码所在行 */
export function itemRow(page: Page, code: string) {
  return page.getByRole("row", { name: new RegExp(code) });
}

/** UI 新建物资（/inventory 工作台） */
export async function createItemViaUi(
  page: Page,
  code: string,
  name: string,
  baseUnit = "瓶",
): Promise<void> {
  await openInventory(page);
  await page.getByRole("button", { name: "新建物资" }).click();
  await page.getByLabel("物资代码").fill(code);
  await page.getByLabel("物资名称").fill(name);
  await page.getByLabel("基础单位").fill(baseUnit);
  await page.getByRole("button", { name: "创建物资" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(
    page.getByRole("link", { name: code }),
  ).toBeVisible();
}

/** 详情页设置期初库存 */
export async function setInitialStockViaUi(
  page: Page,
  locationName: string,
  quantity: string,
): Promise<void> {
  await page.getByRole("button", { name: "设置期初库存" }).click();
  await page
    .getByLabel("期初库存地点")
    .selectOption({ label: locationName });
  await page.getByLabel("期初数量").fill(quantity);
  await page.getByRole("button", { name: "确认期初库存" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
}

/** 工作台领用（多行支持，单行场景） */
export async function issueViaUi(
  page: Page,
  itemCode: string,
  quantity: string,
): Promise<void> {
  await openInventory(page);
  await page.getByRole("button", { name: "领用", exact: true }).click();
  await page
    .getByLabel("领用来源地点")
    .selectOption({ label: "总仓" });
  const option = page.locator("option", { hasText: itemCode });
  await page.getByLabel("领用物资").selectOption(await option.elementHandle());
  await page.getByLabel("领用数量").fill(quantity);
  await page.getByRole("button", { name: "确认领用" }).click();
  await expect(page.getByRole("status")).toContainText(/领用成功/);
  // 表单底部「关闭」按钮（对话框右上角 X 也是 关闭，取最后一个）
  await page.getByRole("button", { name: "关闭", exact: true }).last().click();
}

/** 工作台调拨 */
export async function transferViaUi(
  page: Page,
  itemCode: string,
  quantity: string,
): Promise<void> {
  await openInventory(page);
  await page.getByRole("button", { name: "调拨", exact: true }).click();
  await page
    .getByLabel("调拨来源地点")
    .selectOption({ label: "总仓" });
  await page
    .getByLabel("调拨目的地地点")
    .selectOption({ label: "前台" });
  const option = page.locator("option", { hasText: itemCode });
  await page.getByLabel("调拨物资").selectOption(await option.elementHandle());
  await page.getByLabel("调拨数量").fill(quantity);
  await page.getByRole("button", { name: "确认调拨" }).click();
  await expect(page.getByRole("status")).toContainText(/调拨成功/);
  await page.getByRole("button", { name: "关闭", exact: true }).last().click();
}
