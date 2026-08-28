/**
 * S5 Maintenance Golden Path（正式 E2E，真实链路，禁止 Mock）：
 *
 *   HOUSEKEEPING 发现设施问题
 *   ↓ 保洁任务详情「发现设施问题 → 报修」（预填房间 + source=HOUSEKEEPING）
 *   ↓ 创建阻断性维修工单（blocks_room=true）
 *   ↓ Room becomes OOS + source=MAINTENANCE（cleaning 保持不变）
 *   MANAGER 派工
 *   ↓ MAINTENANCE 开始维修 → 提交解决
 *   ↓ MANAGER 验收通过 → Work Order COMPLETED
 *   ↓ Room restored（最后一张 blocking 工单）+ cleaning 保持 dirty
 *   ↓ 保洁完成后（clean）才真正 Check-in Ready
 *
 * 另覆盖：PRE_OPENING 报修（来源筛选）；Mobile（390×844）现场报修表单。
 * 房间号段：301 / 302（不与既有 spec 重叠）。
 */

import { expect, test } from "@playwright/test";
import {
  adminApi,
  addDays,
  apiCheckIn,
  apiCreateGuest,
  apiCreateReservation,
  apiGetRoomByNumber,
  apiSetRoomStatus,
  businessDate,
  closeApi,
  type ApiSession,
} from "./booking-helpers";
import {
  apiCompleteTaskChain,
  apiCreateTask,
  apiGetActiveTaskByRoom,
} from "./housekeeping-helpers";
import {
  apiEnsureRoomAvailableClean,
  apiGetOrder,
  apiListOrders,
  apiOrderAction,
  apiFindUserId,
} from "./maintenance-helpers";
import { ensureTestUsers } from "./setup-users";
import {
  housekeepingPassword,
  housekeepingUsername,
  login,
  logout,
  maintenancePassword,
  maintenanceUsername,
  managerPassword,
  managerUsername,
} from "./helpers";

const TODAY = businessDate();
const GOLDEN_ROOM = "301";
const PRE_OPENING_ROOM = "302";
const MOBILE_ROOM = "302";

let admin: ApiSession;

test.beforeAll(async () => {
  await ensureTestUsers();
  admin = await adminApi();
  // 归一化：301 供 Golden Path；302 供 PRE_OPENING / Mobile
  await apiEnsureRoomAvailableClean(admin, GOLDEN_ROOM);
  await apiEnsureRoomAvailableClean(admin, PRE_OPENING_ROOM);
});

test.afterAll(async () => {
  await closeApi(admin);
});

test.describe("Maintenance Golden Path（UI 全链路）", () => {
  test("保洁发现 → 阻断报修 → 派工 → 维修 → 验收 → 房间恢复 → 清洁后 Ready", async ({
    page,
  }) => {
    // ---- 准备：301 待清扫 + 保洁任务（保洁在翻房中发现设施问题）----
    const room301 = await apiGetRoomByNumber(admin, GOLDEN_ROOM);
    await apiSetRoomStatus(admin, room301.id, { cleaning_status: "dirty" });
    const task = await apiCreateTask(admin, room301.id);
    expect(task.status).toBe("PENDING");

    // ---- HOUSEKEEPING：任务详情「发现设施问题 → 报修」----
    await login(page, housekeepingUsername(), housekeepingPassword());
    await page.goto(`/housekeeping/${task.id}`);
    await page
      .getByRole("link", { name: /发现设施问题/ })
      .waitFor({ state: "visible", timeout: 15_000 });
    // 预填校验：链接携带 room_id + source=HOUSEKEEPING
    await expect(page.getByRole("link", { name: /发现设施问题/ })).toHaveAttribute(
      "href",
      new RegExp(`room_id=${room301.id}`),
    );
    await page.getByRole("link", { name: /发现设施问题/ }).click();

    // ---- 报修表单：预填房间 + 来源；阻断客房；提交 ----
    await expect(page).toHaveURL(/\/maintenance\/new/);
    await expect(
      page.getByRole("heading", { name: "现场报修" }),
    ).toBeVisible();
    await expect(page.getByLabel("报修房间")).toHaveValue(String(room301.id));
    await expect(page.getByLabel("报修来源")).toHaveValue("HOUSEKEEPING");
    await page.getByLabel("故障分类").selectOption("PLUMBING");
    await page.getByRole("button", { name: "高", exact: true }).click();
    await page.getByLabel("阻断客房销售").check();
    await page.getByLabel("故障标题").fill("淋浴间严重漏水");
    await page.getByLabel("故障描述").fill("翻房时发现淋浴间地面积水");
    await page.getByRole("button", { name: "提交报修" }).click();

    // ---- 工单详情：OPEN + 房间停用（cleaning 不变）----
    await expect(page).toHaveURL(/\/maintenance\/\d+/);
    await expect(
      page.getByRole("heading", { name: /维修工单 MWO/ }),
    ).toBeVisible();
    await expect(page.getByText("待处理")).toBeVisible();
    await expect(page.getByText("阻断客房").first()).toBeVisible();
    await expect(page.getByText("停用")).toBeVisible(); // Room occupancy = OOS
    await expect(page.getByText("待清扫")).toBeVisible(); // cleaning 保持 dirty

    // API 断言：Room OOS + source=MAINTENANCE；工单 OPEN + blocks_room
    const roomAfterReport = await apiGetRoomByNumber(admin, GOLDEN_ROOM);
    expect(roomAfterReport.occupancy_status).toBe("out_of_service");
    expect(roomAfterReport.unavailability_source).toBe("MAINTENANCE");
    expect(roomAfterReport.cleaning_status).toBe("dirty");

    const orders = await apiListOrders(admin, { room_id: room301.id });
    expect(orders.total).toBeGreaterThanOrEqual(1);
    const order = orders.items.find((o) => o.status === "OPEN");
    expect(order).toBeTruthy();
    expect(order?.blocks_room).toBe(true);
    expect(order?.source).toBe("HOUSEKEEPING");
    const orderId = order!.id;

    // ---- MANAGER：派工给维修工 ----
    await logout(page);
    await login(page, managerUsername(), managerPassword());
    await page.goto(`/maintenance/${orderId}`);
    await expect(
      page.getByRole("heading", { name: /维修工单 MWO/ }),
    ).toBeVisible();
    const workerId = await apiFindUserId(admin, maintenanceUsername());
    await page
      .getByLabel("指派维修负责人")
      .selectOption(String(workerId));
    await page.getByRole("button", { name: "派工" }).click();
    await expect(page.getByText("已派工").first()).toBeVisible();
    const assigned = await apiGetOrder(admin, orderId);
    expect(assigned.status).toBe("ASSIGNED");
    expect(assigned.assigned_to_user_id).toBe(workerId);

    // ---- MAINTENANCE：开始维修 → 提交解决 ----
    await logout(page);
    await login(page, maintenanceUsername(), maintenancePassword());
    await page.goto(`/maintenance/${orderId}`);
    await expect(
      page.getByRole("heading", { name: /维修工单 MWO/ }),
    ).toBeVisible();
    await page.getByRole("button", { name: "开始维修" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "开始维修" }).click();
    await expect(page.getByText("维修中").first()).toBeVisible();
    await page.getByRole("button", { name: "提交验收" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "提交验收" }).click();
    await expect(page.getByText("待验收").first()).toBeVisible();

    const resolved = await apiGetOrder(admin, orderId);
    expect(resolved.status).toBe("RESOLVED");
    // RESOLVED 仍阻断：房间保持停用
    const roomWhileResolved = await apiGetRoomByNumber(admin, GOLDEN_ROOM);
    expect(roomWhileResolved.occupancy_status).toBe("out_of_service");

    // ---- MANAGER：验收通过 → 工单完成；房间恢复 available（仍 dirty）----
    await logout(page);
    await login(page, managerUsername(), managerPassword());
    await page.goto(`/maintenance/${orderId}`);
    await expect(
      page.getByRole("heading", { name: /维修工单 MWO/ }),
    ).toBeVisible();
    await page.getByRole("button", { name: "验收通过" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "确认通过" })
      .click();
    await expect(page.getByText("已完成").first()).toBeVisible();

    const completed = await apiGetOrder(admin, orderId);
    expect(completed.status).toBe("COMPLETED");
    expect(completed.verified_at).toBeTruthy();

    // 房间恢复可售但保持 dirty（Maintenance Complete ≠ Room Clean）
    const roomAfterVerify = await apiGetRoomByNumber(admin, GOLDEN_ROOM);
    expect(roomAfterVerify.occupancy_status).toBe("available");
    expect(roomAfterVerify.unavailability_source ?? null).toBeNull();
    expect(roomAfterVerify.cleaning_status).toBe("dirty");

    // ---- 清洁保持：dirty 时不能 Check-in（后端 409）----
    const guest = await apiCreateGuest(admin, { name: "维修后入住客人" });
    const reservation = await apiCreateReservation(admin, {
      guest_id: guest.id,
      room_id: room301.id,
      room_type_id: room301.room_type_id,
      check_in_date: TODAY,
      check_out_date: addDays(TODAY, 2),
      agreed_total_amount: "318.00",
    });
    const dirtyCheckIn = await admin.ctx.post(
      `/api/v1/reservations/${reservation.id}/check-in`,
      { headers: admin.headers },
    );
    expect(dirtyCheckIn.status()).toBe(409);
    expect(await dirtyCheckIn.text()).toContain("清洁");

    // ---- 保洁完成 → clean → Check-in Ready ----
    const activeTask = await apiGetActiveTaskByRoom(admin, GOLDEN_ROOM);
    await apiCompleteTaskChain(admin, activeTask.id);
    const roomClean = await apiGetRoomByNumber(admin, GOLDEN_ROOM);
    expect(roomClean.cleaning_status).toBe("clean");
    await apiCheckIn(admin, reservation.id);

    // ---- 审计证据：全链路 audit 存在（后端自动，非前端生成）----
    const auditResp = await admin.ctx.get("/api/v1/audit-logs", {
      headers: admin.headers,
      params: { resource_type: "maintenance_work_order", page: 1, page_size: 100 },
    });
    expect(auditResp.ok()).toBeTruthy();
    const auditItems = ((await auditResp.json()) as { items: { action: string; resource_id: number }[] }).items;
    for (const action of [
      "maintenance.create",
      "maintenance.assign",
      "maintenance.start",
      "maintenance.resolve",
      "maintenance.verify",
    ]) {
      expect(
        auditItems.some((a) => a.action === action && a.resource_id === orderId),
        `缺少审计 ${action}`,
      ).toBeTruthy();
    }

    // 清理：退房 + 完成翻房链，恢复 301 干净可售
    const stayResp = await admin.ctx.get("/api/v1/stays", {
      headers: admin.headers,
      params: { room_id: room301.id, status: "ACTIVE", page: 1, page_size: 20 },
    });
    const stays = (await stayResp.json()) as { items: { id: number }[] };
    for (const stay of stays.items) {
      const out = await admin.ctx.post(`/api/v1/stays/${stay.id}/check-out`, {
        headers: admin.headers,
      });
      expect(out.ok()).toBeTruthy();
    }
    const checkoutTask = await apiGetActiveTaskByRoom(admin, GOLDEN_ROOM);
    await apiCompleteTaskChain(admin, checkoutTask.id);
  });

  test("PRE_OPENING：开业前整改报修 + 来源筛选", async ({ page }) => {
    const room302 = await apiGetRoomByNumber(admin, PRE_OPENING_ROOM);
    await login(page, housekeepingUsername(), housekeepingPassword());
    await page.goto("/maintenance/new");
    await expect(
      page.getByRole("heading", { name: "现场报修" }),
    ).toBeVisible();
    await page.getByLabel("报修房间").selectOption(String(room302.id));
    await page.getByLabel("报修来源").selectOption("PRE_OPENING");
    await page.getByLabel("故障标题").fill("开业前整改：插座松动");
    await page.getByRole("button", { name: "提交报修" }).click();
    await expect(page).toHaveURL(/\/maintenance\/\d+/);
    await expect(page.getByText("开业检查")).toBeVisible();

    // 工作台来源筛选：PRE_OPENING 可见
    await page.goto("/maintenance");
    await expect(
      page.getByRole("heading", { name: "维修运营" }),
    ).toBeVisible();
    await page.getByLabel("来源筛选").selectOption("PRE_OPENING");
    await expect(
      page.getByRole("link", { name: `房间 ${PRE_OPENING_ROOM}`, exact: true }),
    ).toBeVisible();
    // 清理：取消该工单（admin 有 cancel 权限）
    const orders = await apiListOrders(admin, {
      room_id: room302.id,
      source: "PRE_OPENING",
    });
    for (const o of orders.items) {
      if (o.status !== "CANCELLED" && o.status !== "COMPLETED") {
        await apiOrderAction(admin, o.id, "cancel");
      }
    }
  });

  test("Mobile：390×844 现场报修表单可完成提交", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const room302 = await apiGetRoomByNumber(admin, MOBILE_ROOM);
    await login(page, housekeepingUsername(), housekeepingPassword());
    await page.goto(`/maintenance/new?room_id=${room302.id}&source=HOUSEKEEPING`);
    await expect(
      page.getByRole("heading", { name: "现场报修" }),
    ).toBeVisible();
    await expect(page.getByLabel("报修房间")).toHaveValue(String(room302.id));
    await page.getByLabel("故障分类").selectOption("APPLIANCE");
    await page.getByLabel("故障标题").fill("迷你吧不制冷（移动端报修）");
    await page.getByRole("button", { name: "提交报修" }).click();
    await expect(page).toHaveURL(/\/maintenance\/\d+/);
    await expect(
      page.getByRole("heading", { name: /维修工单 MWO/ }),
    ).toBeVisible();
    // 清理
    const orders = await apiListOrders(admin, { room_id: room302.id });
    for (const o of orders.items) {
      if (o.status !== "CANCELLED" && o.status !== "COMPLETED") {
        await apiOrderAction(admin, o.id, "cancel");
      }
    }
    // 归一化 302 供后续 spec
    await apiEnsureRoomAvailableClean(admin, MOBILE_ROOM);
  });
});
