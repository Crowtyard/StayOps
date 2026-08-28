/**
 * S7 Inventory & Procurement E2E（Sprint 7 §55，正式 checked-in E2E，真实链路）：
 *
 * Golden Flow A：UI 新建物资 → 期初库存 → 领用 → 余额减少 → 流水可见
 * Golden Flow B：调拨 → 来源减少 / 目的地增加 / 酒店总库存不变
 * Golden Flow C：采购申请 → 提交 → 批准 → 采购订单 → 下达 → 部分收货
 *                （余额只增加实收数量）→ 最终收货 → PO 已收货
 * Golden Flow D：低库存 → 库存工作台 / Dashboard 预警可见
 *
 * 真实 FastAPI（127.0.0.1:8001）+ stayops_test 库；UI 经 BFF（浏览器不接触 Token）。
 */

import { expect, test } from "@playwright/test";
import { adminApi, closeApi, type ApiSession } from "./booking-helpers";
import {
  apiCreateItem,
  apiCreateSupplier,
  apiItemDetail,
  apiLocationByCode,
  apiSetInitialStock,
  createItemViaUi,
  issueViaUi,
  loginAdmin,
  openInventory,
  setInitialStockViaUi,
  transferViaUi,
} from "./inventory-helpers";

async function apiMovements(api: ApiSession, itemId: number) {
  const resp = await api.ctx.get("/api/v1/inventory/movements", {
    headers: api.headers,
    params: { item_id: itemId, page_size: 100 },
  });
  expect(resp.status(), `流水列表失败：${await resp.text()}`).toBe(200);
  return (
    (await resp.json()) as {
      items: { id: number; movement_type: string; quantity: string }[];
    }
  ).items;
}

/** Decimal 字符串 -> number（"40.00" / "40" / "-12" 一律数值比较） */
function q(value: unknown): number {
  return parseFloat(String(value));
}

test.describe("S7 Inventory & Procurement Golden Flows", () => {
  test("Golden A：新建物资 → 期初库存 → 领用 → 余额减少 → 流水可见", async ({
    page,
  }) => {
    const api = await adminApi();
    try {
      await loginAdmin(page);
      await createItemViaUi(page, "E2E-ITEM-A", "E2E矿泉水", "瓶");

      // 详情页：设置期初库存 50
      await page.getByRole("link", { name: "E2E-ITEM-A" }).click();
      await expect(
        page.getByRole("heading", { name: "E2E矿泉水" }),
      ).toBeVisible();
      await setInitialStockViaUi(page, "总仓", "50");

      // 总库存卡 = 50；地点余额 = 总仓 50；期初流水可见
      await expect(
        page.getByText("总库存").locator("..").getByText(/^50/),
      ).toBeVisible();
      await expect(page.getByText("期初库存", { exact: true })).toBeVisible();
      await expect(page.getByText("+50")).toBeVisible();

      // 领用 12：余额 38
      await issueViaUi(page, "E2E-ITEM-A", "12");
      await expect(
        page.getByRole("row", { name: /E2E-ITEM-A/ }),
      ).toContainText("38");

      // 详情：领用流水可见（类型/数量/地点/操作人）
      await page.getByRole("link", { name: "E2E-ITEM-A" }).click();
      await expect(page.getByText("领用出库")).toBeVisible();
      await expect(page.getByText("-12")).toBeVisible();
      await expect(
        page.getByText("总库存").locator("..").getByText(/^38/),
      ).toBeVisible();

      // API 口径：ledger == balance（INITIAL +50 / ISSUE -12 = 38）
      const locations = await apiLocationByCode(api, "MAIN_STORAGE");
      const items = await api.ctx.get("/api/v1/inventory/items", {
        headers: api.headers,
        params: { search: "E2E-ITEM-A", page_size: 100 },
      });
      const itemId = (await items.json()).items[0].id as number;
      const detail = await apiItemDetail(api, itemId);
      expect(q(detail.total_stock)).toBe(38);
      expect(detail.balances[0].location_id).toBe(locations.id);
      expect(q(detail.balances[0].quantity)).toBe(38);
      const movements = await apiMovements(api, itemId);
      expect(movements.map((m) => m.movement_type)).toEqual([
        "ISSUE",
        "INITIAL",
      ]);
      expect(movements.map((m) => q(m.quantity))).toEqual([-12, 50]);
    } finally {
      await closeApi(api);
    }
  });

  test("Golden B：调拨 → 来源减少 / 目的地增加 / 总库存不变", async ({
    page,
  }) => {
    const api = await adminApi();
    try {
      const main = await apiLocationByCode(api, "MAIN_STORAGE");
      const front = await apiLocationByCode(api, "FRONT_DESK");
      const item = await apiCreateItem(api, {
        code: "E2E-ITEM-B",
        name: "E2E拖鞋",
        baseUnit: "双",
      });
      await apiSetInitialStock(api, item.id, main.id, "30");

      await loginAdmin(page);
      await transferViaUi(page, "E2E-ITEM-B", "10");

      // 详情：来源 20 / 目的地 10 / 总库存不变 30
      await page.getByRole("link", { name: "E2E-ITEM-B" }).click();
      await expect(
        page.getByRole("heading", { name: "E2E拖鞋" }),
      ).toBeVisible();
      await expect(
        page.getByText("总库存").locator("..").getByText(/^30/),
      ).toBeVisible();
      await expect(
        page.getByRole("cell", { name: "总仓" }).locator(".."),
      ).toContainText("20");
      await expect(
        page.getByRole("cell", { name: "前台" }).locator(".."),
      ).toContainText("10");

      // 流水：TRANSFER_OUT -10 + TRANSFER_IN +10
      const movements = await apiMovements(api, item.id);
      const types = movements.map((m) => m.movement_type);
      expect(types).toContain("TRANSFER_OUT");
      expect(types).toContain("TRANSFER_IN");
      const out = movements.find((m) => m.movement_type === "TRANSFER_OUT");
      const inbound = movements.find((m) => m.movement_type === "TRANSFER_IN");
      expect(q(out?.quantity)).toBe(-10);
      expect(q(inbound?.quantity)).toBe(10);
      // 酒店总库存不变：30
      const detail = await apiItemDetail(api, item.id);
      expect(q(detail.total_stock)).toBe(30);
      expect(detail.balances).toHaveLength(2);
      expect(
        q(detail.balances.find((b) => b.location_id === front.id)?.quantity),
      ).toBe(10);
      expect(
        q(detail.balances.find((b) => b.location_id === main.id)?.quantity),
      ).toBe(20);
    } finally {
      await closeApi(api);
    }
  });

  test("Golden C：申请→提交→批准→订单→下达→部分收货→最终收货", async ({
    page,
  }) => {
    const api = await adminApi();
    try {
      const item = await apiCreateItem(api, {
        code: "E2E-ITEM-C",
        name: "E2E垃圾袋",
        baseUnit: "个",
      });
      await apiCreateSupplier(api, "E2E-SUP-C", "E2E供应商");
      const main = await apiLocationByCode(api, "MAIN_STORAGE");

      await loginAdmin(page);
      await page.getByRole("link", { name: "采购", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "采购工作台" }),
      ).toBeVisible();

      // 新建采购申请（100 个）
      await page.getByRole("link", { name: "采购申请", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "采购申请" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "新建采购申请" }).click();
      const itemOption = page.locator("option", { hasText: "E2E-ITEM-C" });
      await page
        .getByLabel("申请物资")
        .selectOption(await itemOption.elementHandle());
      await page.getByLabel("申请数量").fill("100");
      await page.getByRole("button", { name: "创建申请" }).click();
      await expect(page.getByRole("dialog")).toBeHidden();

      // 提交 → 批准
      await page.getByRole("link", { name: /^PRQ/ }).click();
      // 等待客户端导航完成后再断言（列表页「草稿」文案会与详情徽标歧义）
      await page.waitForURL(/\/procurement\/requests\/\d+/);
      await expect(page.getByText("草稿")).toBeVisible();
      await page.getByRole("button", { name: "提交审批" }).click();
      await expect(page.getByText("待审批")).toBeVisible();
      await page.getByRole("button", { name: "批准" }).click();
      await expect(page.getByText("已批准")).toBeVisible();

      // 转采购订单（选择供应商）→ 跳转订单详情
      await page.getByRole("button", { name: "转采购订单" }).click();
      const supplierOption = page.locator("option", {
        hasText: "E2E供应商",
      });
      await page
        .getByLabel("订单供应商")
        .selectOption(await supplierOption.elementHandle());
      await page.getByRole("button", { name: "确认转单" }).click();
      await page.waitForURL(/\/procurement\/orders\/\d+/);
      await expect(
        page.getByRole("heading", { name: /^PO/ }),
      ).toBeVisible();
      await expect(page.getByText("草稿")).toBeVisible();

      // 下达订单
      await page.getByRole("button", { name: "下达订单" }).click();
      await expect(page.getByText("已下达")).toBeVisible();

      // PO 不改变库存（§33）：此时总库存仍为 0
      let detail = await apiItemDetail(api, item.id);
      expect(q(detail.total_stock)).toBe(0);

      // 部分收货 40：余额只增加实收数量；状态 部分收货
      await page.getByRole("button", { name: "收货入库" }).click();
      await page
        .getByLabel("入库地点")
        .selectOption({ label: "总仓" });
      await page
        .getByLabel("E2E垃圾袋 收货数量")
        .fill("40");
      await page.getByRole("button", { name: "确认收货" }).click();
      await expect(page.getByRole("dialog")).toBeHidden();
      await expect(page.getByText("部分收货")).toBeVisible();
      await expect(
        page.getByRole("cell", { name: "40", exact: true }),
      ).toBeVisible(); // 已收 40
      await expect(
        page.getByRole("cell", { name: "60", exact: true }),
      ).toBeVisible(); // 剩余 60
      await expect(page.getByText(/收货记录（1）/)).toBeVisible();

      detail = await apiItemDetail(api, item.id);
      expect(q(detail.total_stock)).toBe(40);

      // 最终收货（按剩余数量）→ 已收货；余额 100
      await page.getByRole("button", { name: "收货入库" }).click();
      await page
        .getByLabel("入库地点")
        .selectOption({ label: "总仓" });
      await page.getByRole("button", { name: "按剩余数量收货" }).click();
      await page.getByRole("button", { name: "确认收货" }).click();
      await expect(page.getByRole("dialog")).toBeHidden();
      await expect(page.getByText("已收货")).toBeVisible();
      await expect(page.getByText(/收货记录（2）/)).toBeVisible();

      detail = await apiItemDetail(api, item.id);
      expect(q(detail.total_stock)).toBe(100);
      // 收货流水：40 + 60 = 100；ledger == balance
      const movements = await apiMovements(api, item.id);
      const receipts = movements.filter(
        (m) => m.movement_type === "PURCHASE_RECEIPT",
      );
      expect(receipts).toHaveLength(2);
      expect(receipts.map((m) => q(m.quantity)).sort()).toEqual([40, 60]);

      // 订单状态（API）：RECEIVED；地点余额 = 100
      const orders = await api.ctx.get("/api/v1/procurement/orders", {
        headers: api.headers,
        params: { search: "PO", page_size: 100 },
      });
      const orderList = (await orders.json()) as {
        items: { id: number; status: string; lines: unknown[] }[];
      };
      expect(orderList.items).toHaveLength(1);
      expect(orderList.items[0].status).toBe("RECEIVED");
      expect(
        q(detail.balances.find((b) => b.location_id === main.id)?.quantity),
      ).toBe(100);
    } finally {
      await closeApi(api);
    }
  });

  test("Golden D：低库存 → 库存工作台 / Dashboard 预警可见", async ({
    page,
  }) => {
    const api = await adminApi();
    try {
      const main = await apiLocationByCode(api, "MAIN_STORAGE");
      // 低库存：minimum 20 / target 50 / 现 10
      const lowItem = await apiCreateItem(api, {
        code: "E2E-ITEM-D-LOW",
        name: "E2E浴帽",
        baseUnit: "个",
        minimum: "20",
        target: "50",
      });
      await apiSetInitialStock(api, lowItem.id, main.id, "10");
      // 缺货：0 库存
      await apiCreateItem(api, {
        code: "E2E-ITEM-D-OUT",
        name: "E2E牙刷",
        baseUnit: "支",
        minimum: "10",
        target: "30",
      });

      await loginAdmin(page);
      await openInventory(page);
      // 工作台：低库存 / 缺货徽标 + 建议补货
      await expect(
        page.getByRole("row", { name: /E2E-ITEM-D-LOW/ }),
      ).toContainText("低库存");
      await expect(
        page.getByRole("row", { name: /E2E-ITEM-D-LOW/ }),
      ).toContainText("建议补货 40");
      await expect(
        page.getByRole("row", { name: /E2E-ITEM-D-OUT/ }),
      ).toContainText("缺货");

      // Dashboard 库存与采购预警：低库存 >= 1、缺货 >= 1
      await page.getByRole("link", { name: "首页", exact: true }).click();
      await expect(
        page.getByText("库存与采购预警"),
      ).toBeVisible();
      await expect(
        page.getByText("正在加载库存与采购数据…"),
      ).toBeHidden();
      const section = page
        .getByText("库存与采购预警")
        .locator("xpath=ancestor::div[contains(@class,'mt-6')][1]");
      await expect(
        section.getByText("低库存").locator("xpath=ancestor::div[1]"),
      ).toContainText(/[1-9]/);
      await expect(
        section.getByText("缺货").locator("xpath=ancestor::div[1]"),
      ).toContainText(/[1-9]/);

      // API 口径：stock_status 判定与推荐补货一致
      const detail = await apiItemDetail(api, lowItem.id);
      expect(detail.stock_status).toBe("LOW_STOCK");
      expect(q(detail.recommended_replenishment)).toBe(40);
    } finally {
      await closeApi(api);
    }
  });
});
