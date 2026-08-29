/**
 * S8 Analytics E2E（§63 + QA D1）：
 * - Flow A · Operations Analytics（ADMIN）：确定性数据（历史房晚回填）→
 *   Physical Occupancy / room nights / HK / Maintenance / On-books 可见
 * - Flow B · Business Analytics（MANAGER）：Contracted ADR / RevPAR / 库存与采购
 * - Flow C · Permission Isolation：FRONT_DESK（ops 可见、business 缺席且零请求）、
 *   FINANCE（business 可见、ops 缺席且零请求）
 * - Flow D · Zero Data：空数据区间正常渲染，无 NaN / Infinity
 * - Flow E · Calendar Comparison（D1）：This Month -> previous_month_elapsed、
 *   Last Month -> previous_calendar_month（API 断言 comparison.period 精确区间，
 *   UI 抽查本月对比 chip 与上月范围标签，不只测标签）
 *
 * 数据构造全部走真实 8001 后端 API；历史房晚/库存/收货时间用真实 UPDATE 准备
 * （setup_backdate_stay.py / setup_backdate_procurement.py，均硬性限定
 * stayops_test 测试库 + 显式行 ID，D2）。
 */

import { expect, test } from "@playwright/test";
import { ensureTestUsers } from "./setup-users";
import {
  adminPassword,
  adminUsername,
  frontdeskPassword,
  frontdeskUsername,
  login,
  managerPassword,
  managerUsername,
} from "./helpers";
import {
  addDays,
  adminApi,
  apiGetRoomByNumber,
  businessDate,
  closeApi,
  todayPlus,
} from "./booking-helpers";
import {
  apiCompleteHousekeeping,
  apiCreateBlockingMaintenance,
  apiCreateCompletedStay,
  apiNormalizeRoom,
  apiSeedInventoryProcurement,
  backdateProcurement,
  backdateStay,
  ensureFinanceUser,
} from "./analytics-helpers";

const FINANCE_USERNAME = "e2e_finance";
const FINANCE_PASSWORD = "Finance@123456";

/** YYYY-MM-DD 天数差（纯日期算术；ISO 字典序 = 时间序） */
function diffDaysIso(from: string, to: string): number {
  const [y1, m1, d1] = from.split("-").map(Number);
  const [y2, m2, d2] = to.split("-").map(Number);
  return Math.round(
    (Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000,
  );
}

test.describe("Analytics E2E（Sprint 8）", () => {
  test.beforeAll(async () => {
    await ensureTestUsers();
    await ensureFinanceUser();
  });

  test("Flow A · Operations Analytics（ADMIN：占用/保洁/维修/在册预测）", async ({
    page,
  }) => {
    const api = await adminApi();
    try {
      const room = await apiGetRoomByNumber(api, "206");
      // 归一化：清理前面 spec 在 206 的残留（预订/在住/任务/工单/房态）
      await apiNormalizeRoom(api, room.room_number);
      // 完成 Stay（退房自动 CHECKOUT 保洁任务）+ 阻断维修工单
      const { stayId } = await apiCreateCompletedStay(api, room, "600.00");
      await apiCompleteHousekeeping(api, room.id);
      await apiCreateBlockingMaintenance(api, room);
      // 实际入住/保洁完成/工单创建回填到昨晚（Actual 区间不含业务日期当天，§3）
      backdateStay(stayId, 1);
    } finally {
      await closeApi(api);
    }

    await login(page, adminUsername(), adminPassword());
    await page.getByRole("link", { name: "经营分析" }).click();
    await expect(page.getByRole("heading", { name: "经营分析" })).toBeVisible();

    // 运营概览：物理入住率 / 实际占用房晚（1 / 840 → 0.1%）
    const overview = page.locator("section", { hasText: "运营概览" });
    await expect(overview.getByText("物理入住率", { exact: true })).toBeVisible();
    await expect(overview.getByText("实际占用房晚", { exact: true })).toBeVisible();
    await expect(overview.getByText("0.1%")).toBeVisible();

    // 当前快照：保洁积压 / 阻断性维修
    const snapshot = page.locator("section", { hasText: "当前快照" });
    await expect(snapshot.getByText("保洁积压", { exact: true })).toBeVisible();
    await expect(snapshot.getByText("阻断性维修", { exact: true })).toBeVisible();

    // 在册预测 7/14/30
    await expect(page.getByText("未来 7 天")).toBeVisible();
    await expect(page.getByText("未来 30 天")).toBeVisible();

    // 运营效率 Tab：保洁完成 1（120 分钟周期）+ 维修新建 1 + 高频报修房间 206
    await page.getByRole("tab", { name: "运营效率" }).click();
    const hkSection = page.locator("section", { hasText: "保洁" });
    await expect(hkSection.getByText("完成保洁任务", { exact: true })).toBeVisible();
    await expect(hkSection.getByText("1", { exact: true })).toBeVisible();
    await expect(hkSection.getByText("120.0 分钟").first()).toBeVisible();
    const mntSection = page.locator("section", { hasText: "维修" });
    await expect(mntSection.getByText("新建工单", { exact: true })).toBeVisible();
    await expect(mntSection.getByText("206", { exact: true })).toBeVisible();
    await expect(page.getByText("高频报修房间（新建）")).toBeVisible();

    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toContain("NaN");
    expect(bodyText).not.toContain("Infinity");
  });

  test("Flow B · Business Analytics（MANAGER：合同房费/ADR/库存/采购）", async ({
    page,
  }) => {
    // Flow A 的完成 Stay 提供合同房费：600 / 2 晚 × 1 个有价房晚 = 300.00
    const api = await adminApi();
    try {
      // 领用 8；到货 40×1.50 = 60.00；返回显式行 ID（D2：只回填本次创建的行）
      const { receiptIds, movementIds } = await apiSeedInventoryProcurement(api);
      // Actual 区间不含业务日期当天：库存/收货时间回填到昨天（§3）
      backdateProcurement(receiptIds, movementIds);
    } finally {
      await closeApi(api);
    }

    await login(page, managerUsername(), managerPassword());
    await page.getByRole("link", { name: "经营分析" }).click();
    await expect(page.getByRole("heading", { name: "经营分析" })).toBeVisible();

    // 客房经营：合同房费金额 / 合同 ADR（非实际收款语义展示）
    const roomsSection = page.locator("section", { hasText: "客房经营" });
    await expect(roomsSection.getByText("合同房费金额", { exact: true })).toBeVisible();
    await expect(roomsSection.getByText("¥300.00").first()).toBeVisible();
    await expect(roomsSection.getByText("合同 ADR", { exact: true })).toBeVisible();
    await expect(roomsSection.getByText("合同 RevPAR", { exact: true })).toBeVisible();

    // 库存与采购预警：待收货订单
    const alertSection = page.locator("section", { hasText: "库存与采购预警" });
    await expect(alertSection.getByText("待收货订单")).toBeVisible();

    // 库存与采购 Tab：物资行（每单位独立）+ 到货金额 + 供应商
    await page.getByRole("tab", { name: "库存与采购" }).click();
    await expect(page.getByText("分析矿泉水").first()).toBeVisible();
    await expect(page.getByText("瓶").first()).toBeVisible();
    await expect(page.getByText("到货采购金额", { exact: true })).toBeVisible();
    await expect(page.getByText("¥60.00").first()).toBeVisible();
    await expect(page.getByText("分析供应商")).toBeVisible();
  });

  test("Flow C · Permission Isolation（FRONT_DESK：operations 可见、business 零请求）", async ({
    page,
  }) => {
    const businessRequests: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("/api/bff/analytics/business")) {
        businessRequests.push(req.url());
      }
    });

    await login(page, frontdeskUsername(), frontdeskPassword());
    await page.getByRole("link", { name: "经营分析" }).click();

    // operations 可见
    await expect(page.locator("section", { hasText: "运营概览" })).toBeVisible();
    await expect(page.locator("section", { hasText: "当前快照" })).toBeVisible();
    // business 缺席：无经营区块、无库存与采购 Tab
    await expect(page.getByText("合同房费金额")).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "库存与采购" })).toHaveCount(0);
    // 无任何未授权 business 请求（不允许 fetch → 403 → 静默隐藏）
    expect(businessRequests).toHaveLength(0);
  });

  test("Flow C · Permission Isolation（FINANCE：business 可见、operations 零请求）", async ({
    page,
  }) => {
    const opsRequests: string[] = [];
    page.on("request", (req) => {
      const url = req.url();
      if (
        url.includes("/api/bff/analytics/operations") ||
        url.includes("/api/bff/analytics/forecast")
      ) {
        opsRequests.push(url);
      }
    });

    await login(page, FINANCE_USERNAME, FINANCE_PASSWORD);
    await page.getByRole("link", { name: "经营分析" }).click();

    // business 可见
    await expect(page.locator("section", { hasText: "客房经营" })).toBeVisible();
    await expect(page.locator("section", { hasText: "库存与采购预警" })).toBeVisible();
    // operations 缺席：无运营概览、无运营效率 Tab
    await expect(page.getByText("物理入住率")).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "运营效率" })).toHaveCount(0);
    // 无任何未授权 operations / forecast 请求
    expect(opsRequests).toHaveLength(0);
  });

  test("Flow D · Zero Data（空区间正常渲染，无 NaN / Infinity）", async ({ page }) => {
    await login(page, adminUsername(), adminPassword());
    await page.getByRole("link", { name: "经营分析" }).click();
    await expect(page.getByRole("heading", { name: "经营分析" })).toBeVisible();

    // 自定义空数据区间（无任何业务事实）
    await page.getByRole("button", { name: "自定义" }).click();
    await page.getByLabel("自定义开始日期").fill(todayPlus(-60));
    await page.getByLabel("自定义结束日期").fill(todayPlus(-30));

    const overview = page.locator("section", { hasText: "运营概览" });
    await expect(overview.getByText("物理入住率")).toBeVisible();
    // 0 占用 → 0.0%；null 平均时长 → —
    await expect(overview.getByText("0.0%").first()).toBeVisible();
    await expect(overview.getByText("—").first()).toBeVisible();

    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toContain("NaN");
    expect(bodyText).not.toContain("Infinity");
  });

  test("Flow E · Calendar Comparison（D1：This Month / Last Month 对比语义）", async ({
    page,
  }) => {
    const bd = businessDate();
    const monthStart = `${bd.slice(0, 8)}01`;
    const prevMonthStart = `${addDays(monthStart, -1).slice(0, 8)}01`;
    const prevPrevMonthStart = `${addDays(prevMonthStart, -1).slice(0, 8)}01`;

    // API 层：This Month -> previous_month_elapsed（elapsed 跨度 + 月末 clamp）
    const api = await adminApi();
    try {
      const resp1 = await api.ctx.get("/api/v1/analytics/operations/overview", {
        headers: api.headers,
        params: {
          from: monthStart,
          to: bd,
          compare: "true",
          comparison_mode: "previous_month_elapsed",
        },
      });
      expect(resp1.status(), `This Month 对比失败：${await resp1.text()}`).toBe(200);
      const data1 = (await resp1.json()) as {
        comparison: { period: { from: string; to: string } };
      };
      const elapsedDays = diffDaysIso(monthStart, bd);
      const expectedTo =
        addDays(prevMonthStart, elapsedDays) > monthStart
          ? monthStart
          : addDays(prevMonthStart, elapsedDays);
      expect(data1.comparison.period.from).toBe(prevMonthStart);
      expect(data1.comparison.period.to).toBe(expectedTo);

      // API 层：Last Month -> previous_calendar_month（上一完整自然月）
      const resp2 = await api.ctx.get("/api/v1/analytics/operations/overview", {
        headers: api.headers,
        params: {
          from: prevMonthStart,
          to: monthStart,
          compare: "true",
          comparison_mode: "previous_calendar_month",
        },
      });
      expect(resp2.status(), `Last Month 对比失败：${await resp2.text()}`).toBe(200);
      const data2 = (await resp2.json()) as {
        comparison: { period: { from: string; to: string } };
      };
      expect(data2.comparison.period.from).toBe(prevPrevMonthStart);
      expect(data2.comparison.period.to).toBe(prevMonthStart);
    } finally {
      await closeApi(api);
    }

    // UI 层：本月 + 对比开关 -> 物理入住率变化 chip（elapsed>0 时必有数据侧 +0.x pp）；
    // 上月 -> 范围标签显示上一自然月
    await login(page, adminUsername(), adminPassword());
    await page.getByRole("link", { name: "经营分析" }).click();
    await expect(page.getByRole("heading", { name: "经营分析" })).toBeVisible();

    await page.getByRole("button", { name: "本月" }).click();
    await page.getByLabel("与上一周期对比").check();
    const overviewSection = page.locator("section", { hasText: "运营概览" });
    await expect(overviewSection.getByText("物理入住率", { exact: true })).toBeVisible();
    if (diffDaysIso(monthStart, bd) > 0) {
      // Flow A 的历史房晚在昨日：本月已过天数 > 0 时，当前入住率 > 0、
      // 上一自然月无数据 -> pp_delta 必然非空（+0.x pp）
      await expect(overviewSection.getByText(/\+.*pp/).first()).toBeVisible();
    }

    await page.getByRole("button", { name: "上月" }).click();
    await expect(
      page.getByText(new RegExp(`${prevMonthStart} ~ ${monthStart}`)),
    ).toBeVisible();
    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toContain("NaN");
    expect(bodyText).not.toContain("Infinity");
  });

  test.afterAll(async () => {
    // 清理：取消 Flow A 的阻断维修工单（房间 206 已由保洁任务完成恢复 clean，
    // cancel 按 Last Blocking 规则处理 OOS 恢复，不遗留跨 spec 状态）
    const api = await adminApi();
    try {
      const orders = await api.ctx.get("/api/v1/maintenance/orders", {
        headers: api.headers,
        params: { page_size: 100 },
      });
      const items = ((await orders.json()) as {
        items: { id: number; title: string; status: string }[];
      }).items;
      for (const order of items) {
        if (
          order.title === "E2E 分析空调故障" &&
          order.status !== "CANCELLED" &&
          order.status !== "COMPLETED"
        ) {
          const cancel = await api.ctx.post(
            `/api/v1/maintenance/orders/${order.id}/cancel`,
            { headers: api.headers },
          );
          expect(cancel.status(), `取消维修工单失败：${await cancel.text()}`).toBe(200);
        }
      }
    } finally {
      await closeApi(api);
    }
  });
});
