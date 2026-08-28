/**
 * S5 Maintenance Safety（正式 E2E，真实链路，禁止 Mock）：
 *
 * - occupied-room blocker：在住房发生阻断维修，occupancy 保持 occupied
 *   （不覆盖当前 Stay）；Checkout 后 → OOS + MAINTENANCE
 * - Availability / Check-in 感知 Active Blocking Maintenance
 * - future reservation + blocker：不自动取消/换房
 * - Multiple Blockers / Last Blocking 规则
 * - Rework / Cancel / Manual OOS 保护
 * - RBAC 权限矩阵（API 级 + 导航）与 PII 隔离
 *
 * 房间号段：303 / 304 / 305 / 306 / 307 / 308（复用 failures/concurrency
 * 房间段，测试开始前一律归一化保证确定性）。
 */

import { expect, test } from "@playwright/test";
import {
  addDays,
  adminApi,
  apiCheckIn,
  apiCheckOut,
  apiCreateGuest,
  apiCreateReservation,
  apiGetRoomByNumber,
  apiLogin,
  apiSetRoomStatus,
  businessDate,
  closeApi,
  type ApiSession,
} from "./booking-helpers";
import {
  apiCompleteTaskChain,
  apiGetActiveTaskByRoom,
} from "./housekeeping-helpers";
import {
  apiAssignOrder,
  apiCreateOrder,
  apiEnsureRoomAvailableClean,
  apiFindUserId,
  apiOrderAction,
} from "./maintenance-helpers";
import { ensureTestUsers } from "./setup-users";
import {
  frontdeskPassword,
  frontdeskUsername,
  login,
  maintenancePassword,
  maintenanceUsername,
} from "./helpers";

const TODAY = businessDate();

const ROOMS = {
  occupied: "303",
  multiple: "304",
  rework: "305",
  cancel: "306",
  manualOos: "307",
  gating: "308",
};

let admin: ApiSession;

test.beforeAll(async () => {
  await ensureTestUsers();
  admin = await adminApi();
  for (const roomNumber of Object.values(ROOMS)) {
    await apiEnsureRoomAvailableClean(admin, roomNumber);
  }
});

test.afterAll(async () => {
  await closeApi(admin);
});

async function blockingChain(orderId: number): Promise<void> {
  const workerId = await apiFindUserId(admin, maintenanceUsername());
  await apiAssignOrder(admin, orderId, workerId);
  await apiOrderAction(admin, orderId, "start");
  await apiOrderAction(admin, orderId, "resolve");
}

test.describe("Maintenance Safety", () => {
  test("occupied 房间 + blocking 工单：不覆盖在住；Checkout 后停用", async () => {
    const room = await apiGetRoomByNumber(admin, ROOMS.occupied);
    const guest = await apiCreateGuest(admin, { name: "在住房维修客人" });
    const reservation = await apiCreateReservation(admin, {
      guest_id: guest.id,
      room_id: room.id,
      room_type_id: room.room_type_id,
      check_in_date: TODAY,
      check_out_date: addDays(TODAY, 2),
      agreed_total_amount: "318.00",
    });
    const checked = await apiCheckIn(admin, reservation.id);
    const stayId = checked.stay.id;

    // 在住期间报修（阻断）→ Room 保持 occupied + source 不变
    const order = await apiCreateOrder(admin, room.id, {
      blocks_room: true,
      category: "HVAC",
      title: "在住房空调故障",
    });
    let roomNow = await apiGetRoomByNumber(admin, ROOMS.occupied);
    expect(roomNow.occupancy_status).toBe("occupied");
    expect(roomNow.unavailability_source ?? null).toBeNull();

    // Availability：仍排除该房间（维修原因）
    const availResp = await admin.ctx.get("/api/v1/availability", {
      headers: admin.headers,
      params: {
        check_in_date: addDays(TODAY, 5),
        check_out_date: addDays(TODAY, 7),
      },
    });
    expect(availResp.ok()).toBeTruthy();
    const avail = (await availResp.json()) as {
      items: { room_id: number; available: boolean; reason?: string }[];
    };
    const item = avail.items.find((i) => i.room_id === room.id);
    expect(item?.available).toBe(false);
    expect(item?.reason ?? "").toContain("阻断性维修工单");

    // Checkout：Stay 正常结束；Room → OOS + MAINTENANCE + dirty；保洁任务照常
    await apiCheckOut(admin, stayId);
    roomNow = await apiGetRoomByNumber(admin, ROOMS.occupied);
    expect(roomNow.occupancy_status).toBe("out_of_service");
    expect(roomNow.unavailability_source).toBe("MAINTENANCE");
    expect(roomNow.cleaning_status).toBe("dirty");
    const task = await apiGetActiveTaskByRoom(admin, ROOMS.occupied);
    expect(task).toBeTruthy();

    // 维修完成 → available + dirty；保洁完成 → clean
    await blockingChain(order.id);
    await apiOrderAction(admin, order.id, "verify");
    roomNow = await apiGetRoomByNumber(admin, ROOMS.occupied);
    expect(roomNow.occupancy_status).toBe("available");
    expect(roomNow.cleaning_status).toBe("dirty");
    await apiCompleteTaskChain(admin, task.id);
  });

  test("未来预订 + blocking 工单：预订保留、不换房", async () => {
    const room = await apiGetRoomByNumber(admin, ROOMS.gating);
    const guest = await apiCreateGuest(admin, { name: "未来预订维修客人" });
    const reservation = await apiCreateReservation(admin, {
      guest_id: guest.id,
      room_id: room.id,
      room_type_id: room.room_type_id,
      check_in_date: addDays(TODAY, 5),
      check_out_date: addDays(TODAY, 7),
      agreed_total_amount: "298.00",
    });

    const order = await apiCreateOrder(admin, room.id, {
      blocks_room: true,
      title: "未来预订房故障",
    });
    let roomNow = await apiGetRoomByNumber(admin, ROOMS.gating);
    expect(roomNow.occupancy_status).toBe("out_of_service");

    // Reservation 保留：仍 CONFIRMED、同房间
    const resResp = await admin.ctx.get(
      `/api/v1/reservations/${reservation.id}`,
      { headers: admin.headers },
    );
    expect(resResp.ok()).toBeTruthy();
    const resAfter = (await resResp.json()) as { status: string; room_id: number };
    expect(resAfter.status).toBe("CONFIRMED");
    expect(resAfter.room_id).toBe(room.id);

    // 维修完成 → 房间恢复；预订不变
    await blockingChain(order.id);
    await apiOrderAction(admin, order.id, "verify");
    roomNow = await apiGetRoomByNumber(admin, ROOMS.gating);
    expect(roomNow.occupancy_status).toBe("available");
    const resFinal = (await admin.ctx
      .get(`/api/v1/reservations/${reservation.id}`, { headers: admin.headers })
      .then((r) => r.json())) as { status: string; room_id: number };
    expect(resFinal.status).toBe("CONFIRMED");
    expect(resFinal.room_id).toBe(room.id);

    // 清理：取消预订
    await admin.ctx.post(`/api/v1/reservations/${reservation.id}/cancel`, {
      headers: admin.headers,
    });
  });

  test("多张 blocking 工单：仅最后一张完成后恢复", async () => {
    const room = await apiGetRoomByNumber(admin, ROOMS.multiple);
    const first = await apiCreateOrder(admin, room.id, {
      blocks_room: true,
      category: "HVAC",
      title: "阻断工单一",
    });
    const second = await apiCreateOrder(admin, room.id, {
      blocks_room: true,
      category: "PLUMBING",
      title: "阻断工单二",
    });
    expect((await apiGetRoomByNumber(admin, ROOMS.multiple)).occupancy_status).toBe(
      "out_of_service",
    );

    await blockingChain(first.id);
    await apiOrderAction(admin, first.id, "verify");
    expect((await apiGetRoomByNumber(admin, ROOMS.multiple)).occupancy_status).toBe(
      "out_of_service", // 仍有第二张阻断
    );

    await blockingChain(second.id);
    await apiOrderAction(admin, second.id, "verify");
    const roomNow = await apiGetRoomByNumber(admin, ROOMS.multiple);
    expect(roomNow.occupancy_status).toBe("available");
    expect(roomNow.unavailability_source ?? null).toBeNull();
  });

  test("Rework：验收不通过 → 继续阻断 → 修复后验收恢复", async () => {
    const room = await apiGetRoomByNumber(admin, ROOMS.rework);
    const order = await apiCreateOrder(admin, room.id, {
      blocks_room: true,
      category: "BATHROOM",
      title: "返工测试工单",
    });
    await blockingChain(order.id);
    const reworked = await apiOrderAction(admin, order.id, "rework");
    expect(reworked.status).toBe("IN_PROGRESS");
    expect((await apiGetRoomByNumber(admin, ROOMS.rework)).occupancy_status).toBe(
      "out_of_service", // 返工继续阻断
    );

    await apiOrderAction(admin, order.id, "resolve");
    await apiOrderAction(admin, order.id, "verify");
    const roomNow = await apiGetRoomByNumber(admin, ROOMS.rework);
    expect(roomNow.occupancy_status).toBe("available");
    expect(roomNow.unavailability_source ?? null).toBeNull();
  });

  test("Cancel：取消最后一张阻断工单恢复房间", async () => {
    const room = await apiGetRoomByNumber(admin, ROOMS.cancel);
    const order = await apiCreateOrder(admin, room.id, {
      blocks_room: true,
      title: "取消测试工单",
    });
    expect((await apiGetRoomByNumber(admin, ROOMS.cancel)).occupancy_status).toBe(
      "out_of_service",
    );
    const cancelled = await apiOrderAction(admin, order.id, "cancel");
    expect(cancelled.status).toBe("CANCELLED");
    const roomNow = await apiGetRoomByNumber(admin, ROOMS.cancel);
    expect(roomNow.occupancy_status).toBe("available");
    expect(roomNow.unavailability_source ?? null).toBeNull();
  });

  test("Manual OOS 保护：维修完成后不得解除人工停用", async () => {
    const room = await apiGetRoomByNumber(admin, ROOMS.manualOos);
    // 人工停用（MANUAL 来源）
    await apiSetRoomStatus(admin, room.id, { occupancy_status: "out_of_service" });
    let roomNow = await apiGetRoomByNumber(admin, ROOMS.manualOos);
    expect(roomNow.unavailability_source).toBe("MANUAL");

    const order = await apiCreateOrder(admin, room.id, {
      blocks_room: true,
      title: "人工停用房维修",
    });
    await blockingChain(order.id);
    await apiOrderAction(admin, order.id, "verify");

    roomNow = await apiGetRoomByNumber(admin, ROOMS.manualOos);
    expect(roomNow.occupancy_status).toBe("out_of_service"); // 仍停用
    expect(roomNow.unavailability_source).toBe("MANUAL"); // 来源未被覆盖

    // 人工解除停用恢复现场
    await apiSetRoomStatus(admin, room.id, { occupancy_status: "available" });
  });

  test("Check-in 纵深防御：blocking 工单 → 409（后端最终权威）", async () => {
    const room = await apiGetRoomByNumber(admin, ROOMS.gating);
    await apiEnsureRoomAvailableClean(admin, ROOMS.gating);
    const guest = await apiCreateGuest(admin, { name: "维修拦截入住客人" });
    const reservation = await apiCreateReservation(admin, {
      guest_id: guest.id,
      room_id: room.id,
      room_type_id: room.room_type_id,
      check_in_date: TODAY,
      check_out_date: addDays(TODAY, 2),
      agreed_total_amount: "318.00",
    });
    const order = await apiCreateOrder(admin, room.id, {
      blocks_room: true,
      title: "入住前故障",
    });
    const resp = await admin.ctx.post(
      `/api/v1/reservations/${reservation.id}/check-in`,
      { headers: admin.headers },
    );
    expect(resp.status()).toBe(409);
    expect(await resp.text()).toContain("阻断性维修工单");

    // 取消工单后 Check-in 恢复可用
    await apiOrderAction(admin, order.id, "cancel");
    await apiCheckIn(admin, reservation.id);
    const checkedRoom = await apiGetRoomByNumber(admin, ROOMS.gating);
    expect(checkedRoom.occupancy_status).toBe("occupied");

    // 清理
    const staysResp = await admin.ctx.get("/api/v1/stays", {
      headers: admin.headers,
      params: { room_id: room.id, status: "ACTIVE", page: 1, page_size: 20 },
    });
    const stays = (await staysResp.json()) as { items: { id: number }[] };
    for (const stay of stays.items) {
      await apiCheckOut(admin, stay.id);
    }
    const task = await apiGetActiveTaskByRoom(admin, ROOMS.gating);
    await apiCompleteTaskChain(admin, task.id);
  });
});

test.describe("Maintenance RBAC 与 PII", () => {
  test("权限矩阵（API 级）：FRONT_DESK / MAINTENANCE / FINANCE", async () => {
    const room = await apiGetRoomByNumber(admin, ROOMS.multiple);
    await apiEnsureRoomAvailableClean(admin, ROOMS.multiple);

    // FRONT_DESK：read/write 可；work/verify/cancel 403
    const fd = await apiLogin(frontdeskUsername(), frontdeskPassword());
    const fdOrder = await apiCreateOrder(fd, room.id, { title: "FD 报修" });
    const fdStart = await fd.ctx.post(
      `/api/v1/maintenance/orders/${fdOrder.id}/start`,
      { headers: fd.headers },
    );
    expect(fdStart.status()).toBe(403);
    const fdVerify = await fd.ctx.post(
      `/api/v1/maintenance/orders/${fdOrder.id}/verify`,
      { headers: fd.headers },
    );
    expect(fdVerify.status()).toBe(403);
    const fdCancel = await fd.ctx.post(
      `/api/v1/maintenance/orders/${fdOrder.id}/cancel`,
      { headers: fd.headers },
    );
    expect(fdCancel.status()).toBe(403);
    await closeApi(fd);

    // MAINTENANCE：read/work 可；write/verify/cancel 403
    const mnt = await apiLogin(maintenanceUsername(), maintenancePassword());
    const listResp = await mnt.ctx.get("/api/v1/maintenance/orders", {
      headers: mnt.headers,
      params: { page: 1, page_size: 20 },
    });
    expect(listResp.status()).toBe(200);
    const createResp = await mnt.ctx.post("/api/v1/maintenance/orders", {
      headers: mnt.headers,
      data: { room_id: room.id, category: "HVAC", title: "无权创建" },
    });
    expect(createResp.status()).toBe(403);
    // work 权限可执行（把 FD 的工单派给维修工再 start）
    const workerId = await apiFindUserId(admin, maintenanceUsername());
    await apiAssignOrder(admin, fdOrder.id, workerId);
    const mntStart = await mnt.ctx.post(
      `/api/v1/maintenance/orders/${fdOrder.id}/start`,
      { headers: mnt.headers },
    );
    expect(mntStart.status()).toBe(200);
    const mntVerify = await mnt.ctx.post(
      `/api/v1/maintenance/orders/${fdOrder.id}/verify`,
      { headers: mnt.headers },
    );
    expect(mntVerify.status()).toBe(403);
    await closeApi(mnt);

    // FINANCE：无 Maintenance 权限 → 403
    const financeUser = await admin.ctx.post("/api/v1/users", {
      headers: admin.headers,
      data: { username: "e2e_finance_mwo", password: "FinE2e@Stable2026x", is_active: true },
    });
    expect(financeUser.ok()).toBeTruthy();
    const financeId = ((await financeUser.json()) as { id: number }).id;
    const rolesResp = await admin.ctx.get("/api/v1/roles", {
      headers: admin.headers,
      params: { page: 1, page_size: 100 },
    });
    const roles = (await rolesResp.json()) as { items: { id: number; name: string }[] };
    const financeRoleId = roles.items.find((r) => r.name === "FINANCE")?.id;
    await admin.ctx.post(`/api/v1/users/${financeId}/roles`, {
      headers: admin.headers,
      data: { role_ids: [financeRoleId] },
    });
    const fin = await apiLogin("e2e_finance_mwo", "FinE2e@Stable2026x");
    const finList = await fin.ctx.get("/api/v1/maintenance/orders", {
      headers: fin.headers,
      params: { page: 1, page_size: 20 },
    });
    expect(finList.status()).toBe(403);
    await closeApi(fin);

    // 清理 FD 工单
    await apiOrderAction(admin, fdOrder.id, "cancel");
  });

  test("PII：维修工单无 Guest 数据；MAINTENANCE 无 Booking PII 出口", async ({
    page,
  }) => {
    // 维修工单列表/详情响应不含 Guest PII
    const room = await apiGetRoomByNumber(admin, ROOMS.multiple);
    await apiEnsureRoomAvailableClean(admin, ROOMS.multiple);
    const order = await apiCreateOrder(admin, room.id, {
      title: "PII 检查工单",
      blocks_room: false,
    });
    const detailResp = await admin.ctx.get(
      `/api/v1/maintenance/orders/${order.id}`,
      { headers: admin.headers },
    );
    const detailText = await detailResp.text();
    expect(detailText).not.toContain("13800138000");
    expect(detailText).not.toContain("guest_name");
    expect(detailText).not.toContain("reservation_no");

    // UI：MAINTENANCE 打开维修工作台，不出现任何 Guest 姓名/联系方式
    await login(page, maintenanceUsername(), maintenancePassword());
    await page.goto("/maintenance");
    await expect(
      page.getByRole("heading", { name: "维修运营" }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: /维修/ }).first()).toBeVisible();

    // 直连 Booking PII 出口 → 403
    const mnt = await apiLogin(maintenanceUsername(), maintenancePassword());
    for (const path of [
      "/api/v1/guests?page=1&page_size=20",
      "/api/v1/reservations?page=1&page_size=20",
      "/api/v1/stays?page=1&page_size=20",
    ]) {
      const resp = await mnt.ctx.get(path, { headers: mnt.headers });
      expect(resp.status(), `${path} 应 403`).toBe(403);
    }
    await closeApi(mnt);

    // 清理
    await apiOrderAction(admin, order.id, "cancel");
  });

  test("维修完成 ≠ 房间清洁：verify 后仍 dirty，保洁完成后 Ready", async () => {
    const room = await apiGetRoomByNumber(admin, ROOMS.multiple);
    await apiEnsureRoomAvailableClean(admin, ROOMS.multiple);
    await apiSetRoomStatus(admin, room.id, { cleaning_status: "dirty" });
    const order = await apiCreateOrder(admin, room.id, {
      blocks_room: true,
      title: "完成≠清洁工单",
    });
    await blockingChain(order.id);
    await apiOrderAction(admin, order.id, "verify");
    const afterVerify = await apiGetRoomByNumber(admin, ROOMS.multiple);
    expect(afterVerify.occupancy_status).toBe("available");
    expect(afterVerify.cleaning_status).toBe("dirty");
    // 保洁完成后 Ready
    const task = await apiCreateOrderTaskAndComplete(admin, room.id);
    expect(task).toBeTruthy();
    const final = await apiGetRoomByNumber(admin, ROOMS.multiple);
    expect(final.cleaning_status).toBe("clean");
  });

  test("S5 Blocking Defect：occupied + 未来预订 + blocking MWO → 前台主动显示维修风险（房间 203）", async ({
    page,
  }) => {
    // 准备：房间 203 归一化 → ACTIVE Stay（occupied）→ 非重叠未来 CONFIRMED 预订
    await apiEnsureRoomAvailableClean(admin, "203");
    const room = await apiGetRoomByNumber(admin, "203");
    const inHouseGuest = await apiCreateGuest(admin, { name: "203在住客人" });
    const inHouseRes = await apiCreateReservation(admin, {
      guest_id: inHouseGuest.id,
      room_id: room.id,
      room_type_id: room.room_type_id,
      check_in_date: TODAY,
      check_out_date: addDays(TODAY, 2),
      agreed_total_amount: "318.00",
    });
    const checked = await apiCheckIn(admin, inHouseRes.id);
    expect(checked.stay.status).toBe("ACTIVE");

    const futureGuest = await apiCreateGuest(admin, { name: "203未来客人" });
    const futureRes = await apiCreateReservation(admin, {
      guest_id: futureGuest.id,
      room_id: room.id,
      room_type_id: room.room_type_id,
      check_in_date: addDays(TODAY, 4),
      check_out_date: addDays(TODAY, 6),
      agreed_total_amount: "328.00",
    });
    expect(futureRes.status).toBe("CONFIRMED");

    // 阻断性维修工单（active blocking）
    const order = await apiCreateOrder(admin, room.id, {
      blocks_room: true,
      category: "HVAC",
      title: "203 空调故障（阻断）",
    });
    expect(["OPEN", "ASSIGNED", "IN_PROGRESS", "RESOLVED"]).toContain(order.status);

    // Backend 安全保持不变：Room 保持 occupied（不被维修覆盖）
    const roomAfter = await apiGetRoomByNumber(admin, "203");
    expect(roomAfter.occupancy_status).toBe("occupied");
    expect(roomAfter.unavailability_source ?? null).toBeNull();

    // Availability 排除该房间（维修原因，后端安全）
    const availResp = await admin.ctx.get("/api/v1/availability", {
      headers: admin.headers,
      params: {
        check_in_date: addDays(TODAY, 5),
        check_out_date: addDays(TODAY, 7),
      },
    });
    expect(availResp.ok()).toBeTruthy();
    const avail = (await availResp.json()) as {
      items: { room_id: number; available: boolean; reason?: string }[];
    };
    const availItem = avail.items.find((i) => i.room_id === room.id);
    expect(availItem?.available).toBe(false);
    expect(availItem?.reason ?? "").toContain("阻断性维修工单");

    // ---- 前台主动风险：不打开任何 Drawer，风险直接在 Today 运营面出现 ----
    await login(page, frontdeskUsername(), frontdeskPassword());
    await page.goto("/front-desk");
    await page
      .getByRole("heading", { name: "前台指挥台" })
      .waitFor({ state: "visible", timeout: 15_000 });
    const attentionCard = page.locator('[data-summary-card="attention"]');
    await expect(attentionCard).toBeVisible();
    // 需关注计数 ≥ 1（未来预订维修风险主动出现）
    const attentionText = (await attentionCard.textContent()) ?? "";
    expect(attentionText).toContain("需关注");

    await attentionCard.click();
    const dialog = page.getByRole("dialog", { name: "需关注" });
    await expect(dialog).toBeVisible();
    // 维修风险主动出现（scoped 到本场景的预订号与工单号）
    await expect(dialog.getByText(/预订存在维修风险/).first()).toBeVisible();
    await expect(dialog.getByText(new RegExp(futureRes.reservation_no))).toBeVisible();
    await expect(dialog.getByText(new RegExp(order.work_order_no))).toBeVisible();
    await expect(
      dialog.getByRole("link", { name: /查看维修/ }).first(),
    ).toHaveAttribute("href", `/maintenance/${order.id}`);
    await expect(dialog.getByText("查看预订").first()).toBeVisible();

    // ---- 清理：恢复 203 ----
    await apiOrderAction(admin, order.id, "cancel");
    const cancelResp = await admin.ctx.post(
      `/api/v1/reservations/${futureRes.id}/cancel`,
      { headers: admin.headers },
    );
    expect(cancelResp.ok()).toBeTruthy();
    await apiCheckOut(admin, checked.stay.id);
    const checkoutTask = await apiGetActiveTaskByRoom(admin, "203");
    await apiCompleteTaskChain(admin, checkoutTask.id);
    const final = await apiGetRoomByNumber(admin, "203");
    expect(final.occupancy_status).toBe("available");
    expect(final.cleaning_status).toBe("clean");
  });
});

/** 创建保洁任务并完成翻房链（房间必须先 dirty）。 */
async function apiCreateOrderTaskAndComplete(
  api: ApiSession,
  roomId: number,
): Promise<boolean> {
  const createResp = await api.ctx.post("/api/v1/housekeeping/tasks", {
    headers: api.headers,
    data: { room_id: roomId, priority: "NORMAL" },
  });
  expect(createResp.status(), `创建保洁任务失败：${await createResp.text()}`).toBe(
    201,
  );
  const task = (await createResp.json()) as { id: number };
  await apiCompleteTaskChain(api, task.id);
  return true;
}
