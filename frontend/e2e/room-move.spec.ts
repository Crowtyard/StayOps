/**
 * Sprint 6 Room Move E2E（真实 FastAPI + stayops_test，禁止 Mock）：
 * - Golden Path：Reservation → Check-in Room A → Front Desk [换房] A → B
 *   → B occupied / 当前在住（Stay 条画在 B）→ A dirty + ROOM_MOVE 保洁任务
 *   → Stay 详情房间记录 + 原分配房/当前在住房
 * - blocking Maintenance on occupied Room A → Room Move A → B
 *   → A OOS + MAINTENANCE + dirty → 维修仍 active → B occupied
 * - Front Desk Diary shows current Stay on B, not A（§24）
 * - HTTP 并发（真实 PostgreSQL）：Move A→T vs Move B→T = 1×200 + 1×409；
 *   Move→T vs Create Reservation→T = no double allocation（§22/§23）
 * 房间号段：复用种子房 301-308（测试开始前经 admin API 归一化，
 * 与 S5 同一策略；不新建房间，保持 28 间种子房不变）。
 */

import { expect, test } from "@playwright/test";
import {
  adminApi,
  apiGetRoomByNumber,
  apiLogin,
  apiListReservations,
  businessDate,
  closeApi,
  todayPlus,
} from "./booking-helpers";
import {
  frontdeskPassword,
  frontdeskUsername,
  login,
} from "./helpers";
import { ensureTestUsers } from "./setup-users";
import {
  apiCreateOrder,
  apiGetOrder,
} from "./maintenance-helpers";
import {
  apiListTasksForRoom,
  apiNormalizeRoom,
  apiSetupCheckedInStay,
  uiConfirmMove,
  uiExpectRoomState,
  uiExpectStayBarOnRoom,
  uiOpenMoveDialog,
} from "./room-move-helpers";
import { uiOpenFrontDesk } from "./front-desk-helpers";

test.describe("Sprint 6 Room Move", () => {
  test.beforeAll(() => ensureTestUsers());

  test("Golden Path：Check-in A → 换房 A→B → B 在住 + A dirty + ROOM_MOVE 任务 + Diary 画在 B", async ({ page }) => {
    test.setTimeout(180_000);
    const api = await adminApi();
    await apiNormalizeRoom(api, "301");
    await apiNormalizeRoom(api, "302");

    // Reservation → Check-in Room A（真实 API 构造）
    const setup = await apiSetupCheckedInStay(
      api,
      "301",
      "E2E换房客人",
      "13800002222",
    );
    expect(setup.stay.room_id).toBe(setup.room.id);
    const target302 = await apiGetRoomByNumber(api, "302");
    await closeApi(api);

    // Front Desk → 当前在住抽屉 → [换房]
    await login(page, frontdeskUsername(), frontdeskPassword());
    await uiOpenFrontDesk(page);
    // 房间 A：在住（当前实际占用）
    await uiExpectRoomState(page, "301", "在住", "干净");

    const moveDialog = await uiOpenMoveDialog(page, setup.stay.stay_no);
    // 目标房由后端 room-move-options 驱动：当前房 301 不可选
    await expect(
      moveDialog.getByRole("option", { name: /301（不可换入/ }),
    ).toBeDisabled();

    await uiConfirmMove(page, moveDialog, target302.id as number, "302", "MAINTENANCE", "301");
    // 成功后抽屉关闭
    await expect(
      page.getByRole("dialog", { name: "换房", exact: true }),
    ).not.toBeVisible();

    // B shown occupied / 当前在住；A dirty + 可售
    await uiExpectRoomState(page, "302", "在住", "干净");
    await uiExpectRoomState(page, "301", "可售", "待清扫");

    // Front Desk Diary：current Stay 画在 B，不画在 A（§24）
    await uiExpectStayBarOnRoom(page, "302", setup.stay.stay_no, true);
    await uiExpectStayBarOnRoom(page, "301", setup.stay.stay_no, false);

    // 旧房保洁任务：ROOM_MOVE + PENDING（§14）
    const api2 = await adminApi();
    const tasks = await apiListTasksForRoom(api2, setup.room.id);
    expect(
      tasks.items.filter((t) => t.source === "ROOM_MOVE" && t.status === "PENDING"),
    ).toHaveLength(1);
    await closeApi(api2);

    // Stay 详情：房间记录 + 原分配房 vs 当前在住房（§27/§28）
    await page.goto(`/stays/${setup.stay.id}`);
    await expect(page.getByRole("heading", { name: /^入住 STY/ })).toBeVisible();
    await expect(page.getByText("房间记录")).toBeVisible();
    await expect(page.getByText("房间 301", { exact: true })).toBeVisible();
    await expect(page.getByText("房间 302", { exact: true })).toBeVisible();
    await expect(page.getByText("换房信息")).toBeVisible();
    await expect(page.getByText("原分配房")).toBeVisible();
    await expect(page.getByText("当前在住房")).toBeVisible();
  });

  test("blocking Maintenance on occupied A → 换房 A→B → A OOS+MAINTENANCE+dirty、维修仍 active、B occupied", async ({ page }) => {
    test.setTimeout(180_000);
    const api = await adminApi();
    await apiNormalizeRoom(api, "303");
    await apiNormalizeRoom(api, "304");

    const setup = await apiSetupCheckedInStay(
      api,
      "303",
      "E2E维修换房客人",
      "13800003333",
    );
    // occupied 房上的阻断维修：S5 语义（不改变占用，工单阻断可售性）
    const order = await apiCreateOrder(api, setup.room.id as number, {
      blocks_room: true,
      title: "E2E 在住房阻断维修",
    });
    const target304 = await apiGetRoomByNumber(api, "304");
    await closeApi(api);

    await login(page, frontdeskUsername(), frontdeskPassword());
    const moveDialog = await uiOpenMoveDialog(page, setup.stay.stay_no);
    await uiConfirmMove(page, moveDialog, target304.id as number, "304", "MAINTENANCE", "303");

    // A：OOS + MAINTENANCE + dirty（§13 maintenance-aware release）
    await uiExpectRoomState(page, "303", "停用", "待清扫");
    // B：occupied
    await uiExpectRoomState(page, "304", "在住", "干净");
    // Diary：Stay 画在 B
    await uiExpectStayBarOnRoom(page, "304", setup.stay.stay_no, true);
    await uiExpectStayBarOnRoom(page, "303", setup.stay.stay_no, false);

    // 维修独立性（§16）：MWO 仍 active、仍属原房；原房 unavailability_source = MAINTENANCE
    const api2 = await adminApi();
    const room303 = await apiGetRoomByNumber(api2, "303");
    expect(room303.unavailability_source).toBe("MAINTENANCE");
    const mwo = await apiGetOrder(api2, order.id);
    expect(mwo.status).toBe("OPEN");
    expect(mwo.room_id).toBe(setup.room.id);
    await closeApi(api2);
  });

  test("HTTP 并发：Move A→T vs Move B→T = exactly one success（§23）", async () => {
    test.setTimeout(180_000);
    const api = await adminApi();
    await apiNormalizeRoom(api, "305");
    await apiNormalizeRoom(api, "306");
    await apiNormalizeRoom(api, "307");
    const stayA = await apiSetupCheckedInStay(api, "305", "并发换房A", "13800004441");
    const stayB = await apiSetupCheckedInStay(api, "306", "并发换房B", "13800004442");
    const target = await apiGetRoomByNumber(api, "307");
    await closeApi(api);

    const workerA = await apiLogin(frontdeskUsername(), frontdeskPassword());
    const workerB = await apiLogin(frontdeskUsername(), frontdeskPassword());
    const [respA, respB] = await Promise.all([
      workerA.ctx.post(`/api/v1/stays/${stayA.stay.id}/room-move`, {
        headers: workerA.headers,
        data: { target_room_id: target.id, reason: "MAINTENANCE" },
      }),
      workerB.ctx.post(`/api/v1/stays/${stayB.stay.id}/room-move`, {
        headers: workerB.headers,
        data: { target_room_id: target.id, reason: "UPGRADE" },
      }),
    ]);
    const statuses = [respA.status(), respB.status()].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);
    // 目标房最终只有一个 ACTIVE Stay
    const api2 = await adminApi();
    const staysOnTarget = await api2.ctx
      .get("/api/v1/stays", {
        headers: api2.headers,
        params: { room_id: target.id, status: "ACTIVE", page: 1, page_size: 100 },
      })
      .then((r) => r.json());
    expect(staysOnTarget.items).toHaveLength(1);
    await closeApi(api2);
    await closeApi(workerA);
    await closeApi(workerB);
  });

  test("HTTP 并发：Move→T vs Create Reservation→T = no double allocation（§22）", async () => {
    test.setTimeout(180_000);
    const api = await adminApi();
    await apiNormalizeRoom(api, "305");
    await apiNormalizeRoom(api, "308");
    const stay = await apiSetupCheckedInStay(api, "305", "并发换房订房", "13800005551");
    const target = await apiGetRoomByNumber(api, "308");
    const guest = await api.ctx
      .post("/api/v1/guests", {
        headers: api.headers,
        data: { name: "并发抢房客人", phone: "13800005552" },
      })
      .then((r) => r.json());
    await closeApi(api);

    const mover = await apiLogin(frontdeskUsername(), frontdeskPassword());
    const booker = await apiLogin(frontdeskUsername(), frontdeskPassword());
    const [moveResp, bookResp] = await Promise.all([
      mover.ctx.post(`/api/v1/stays/${stay.stay.id}/room-move`, {
        headers: mover.headers,
        data: { target_room_id: target.id, reason: "GUEST_REQUEST" },
      }),
      booker.ctx.post("/api/v1/reservations", {
        headers: booker.headers,
        data: {
          guest_id: guest.id,
          room_id: target.id,
          room_type_id: target.room_type_id,
          check_in_date: businessDate(),
          check_out_date: todayPlus(2),
          agreed_total_amount: "399.00",
        },
      }),
    ]);
    const statuses = [moveResp.status(), bookResp.status()].sort((a, b) => a - b);
    // exactly one winner：换房成功 = 200 / 预订创建成功 = 201；失败方 = 409
    expect(statuses[1]).toBe(409);
    expect([200, 201]).toContain(statuses[0]);

    // exactly one logical allocation：目标房要么 ACTIVE Stay、要么重叠 CONFIRMED 预订
    const api2 = await adminApi();
    const staysOnTarget = await api2.ctx
      .get("/api/v1/stays", {
        headers: api2.headers,
        params: { room_id: target.id, status: "ACTIVE", page: 1, page_size: 100 },
      })
      .then((r) => r.json());
    const reservationsOnTarget = await apiListReservations(api2, {
      room_id: target.id,
      status: "CONFIRMED",
    });
    const hasStay = staysOnTarget.items.length === 1;
    const hasReservation = reservationsOnTarget.items.length >= 1;
    expect(hasStay !== hasReservation).toBe(true);
    await closeApi(api2);
    await closeApi(mover);
    await closeApi(booker);
  });
});
