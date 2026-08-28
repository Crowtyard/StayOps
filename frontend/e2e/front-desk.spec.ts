/**
 * Sprint 4 Front Desk E2E（真实 FastAPI + stayops_test，禁止 Mock）：
 * - 28 房 Room Diary + Today Summary
 * - 空白格快速新建 → [check_in, check_out) 时间线正确区间 → Drawer →
 *   Check-in → 刷新 → Check-out → dirty + 保洁任务
 * - 相邻预订首尾相接渲染（无 off-by-one）
 * - Attention 三条规则：脏房到店 / 超期在住 / 停用房未来预订
 * - Housekeeping 集成：脏房到店 → 任务可见 → 完成清扫 → 刷新 clean → Check-in
 * - 搜索定位 + PII（无 guest:read）+ RBAC（HOUSEKEEPING / FINANCE）
 * - Responsive：<768px FrontDeskTodayBoard（不渲染 Room Diary）/ 768-1023 紧凑 Diary
 * 房间号段：110 / 202 / 206 / 207 / 208（不与 Sprint 1-3 用例重叠）。
 */

import { expect, test } from "@playwright/test";
import {
  apiBook,
  apiCompleteTask,
  apiCreatePermissionUser,
  apiEnsureAvailableClean,
  apiEnsureCleaning,
  apiEnsureOccupancy,
  apiCreateTask,
  frontdeskApi,
  login,
  makeStayOverdue,
  reservationBar,
  roomCell,
  uiExpectRoomCellStatus,
  uiOpenFrontDesk,
  uiQuickCreateFromCell,
  businessDate,
  todayPlus,
} from "./front-desk-helpers";
import {
  adminApi,
  apiCancelReservation,
  apiCheckIn,
  apiCreateGuest,
  apiGetRoomByNumber,
  apiListReservations,
  closeApi,
} from "./booking-helpers";
import {
  frontdeskUsername,
  frontdeskPassword,
  housekeepingUsername,
  housekeepingPassword,
} from "./helpers";
import { ensureTestUsers } from "./setup-users";

const TODAY = businessDate();

test.describe("Sprint 4 Front Desk Command Center", () => {
  test.beforeAll(() => ensureTestUsers());

  test("Room Diary：28 间房全量展示 + 7 天窗口 + Today Summary 卡片", async ({ page }) => {
    await login(page, frontdeskUsername(), frontdeskPassword());
    await uiOpenFrontDesk(page);

    // 28 间房（无分页），按楼层分组（限定在房态日历区域，排除筛选下拉选项）
    await expect(page.locator("[data-room-cell]")).toHaveCount(28);
    const diary = page.getByRole("region", { name: "房态日历（可横向滚动）" });
    await expect(diary.getByText("1 层")).toBeVisible();
    await expect(diary.getByText("2 层")).toBeVisible();
    await expect(diary.getByText("3 层")).toBeVisible();

    // 默认 7 天窗口
    await expect(page.locator("[data-day-header]")).toHaveCount(7);

    // Today Summary 五卡
    for (const kind of ["arrivals", "departures", "inhouse", "vacantClean", "attention"]) {
      await expect(page.locator(`[data-summary-card="${kind}"]`).first()).toBeVisible();
    }
  });

  test("Golden Path：空白格快速新建 → 正确时间线 → Drawer → Check-in → Check-out → dirty + 保洁任务", async ({ page }) => {
    test.setTimeout(180_000);
    const api = await frontdeskApi();
    await apiEnsureAvailableClean(api, "110");
    await closeApi(api);

    await login(page, frontdeskUsername(), frontdeskPassword());
    await uiOpenFrontDesk(page);

    // 点击房间 110 今天列的空白格 → 新建预订（预填 room/check_in/check_out=+1）
    const { reservationNo } = await uiQuickCreateFromCell(page, "110", {
      dayIndex: 0,
      guestName: "E2E到店客人",
      guestPhone: "13800001111",
      amount: "399.00",
    });

    // 时间线：1 晚预订条 = 1 列宽（64px），[check_in, check_out) 语义
    const bar = reservationBar(page, reservationNo);
    await expect(bar).toBeVisible();
    const box = await bar.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(58);
    expect(box!.width).toBeLessThanOrEqual(70);
    await expect(bar).toContainText("E2E到店客人");

    // 预订条 → Reservation Drawer：字段完整
    await bar.click();
    const drawer = page.getByRole("dialog", { name: "预订速览" });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText(reservationNo, { exact: true })).toBeVisible();
    await expect(drawer.getByText("110", { exact: true })).toBeVisible();
    await expect(drawer.getByText("1 晚", { exact: true })).toBeVisible();
    await expect(drawer.getByText(/CNY 399\.00/)).toBeVisible();

    // Check-in（房间 clean → 主操作可用）
    await drawer.getByRole("button", { name: "办理入住" }).click();
    const confirm = page.getByRole("dialog", { name: "办理入住" });
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "办理入住" }).click();
    await expect(drawer.getByText("入住办理成功")).toBeVisible();
    // 房间栏双状态刷新为 在住
    await uiExpectRoomCellStatus(page, "110", "在住", "干净");

    // 前往在住详情办理退房
    await drawer.getByRole("link", { name: "查看入住记录" }).click();
    await page.waitForURL(/\/stays\/\d+/);
    await page.getByRole("button", { name: "办理退房" }).click();
    const outDialog = page.getByRole("dialog");
    await expect(outDialog).toBeVisible();
    await outDialog.getByRole("button", { name: "确认退房" }).click();
    await expect(
      page.getByText("退房完成：房间已置为可售 + 待清扫"),
    ).toBeVisible({ timeout: 15_000 });

    // 回到前台：房间 dirty + 自动保洁任务指示；COMPLETED 不再作为占用条
    await uiOpenFrontDesk(page);
    await uiExpectRoomCellStatus(page, "110", "可售", "待清扫");
    await expect(roomCell(page, "110").locator('[title="保洁任务进行中"]')).toBeVisible();
    await expect(reservationBar(page, reservationNo)).toHaveCount(0);
  });

  test("相邻预订 [d+1,d+3) 与 [d+3,d+5)：首尾相接、互不重叠", async ({ page }) => {
    const api = await frontdeskApi();
    await apiEnsureAvailableClean(api, "202");
    const guest = await apiCreateGuest(api, {
      name: "相邻预订客人",
      phone: "13800002222",
    });
    const first = await apiBook(api, "202", guest.id, todayPlus(1), todayPlus(3));
    const second = await apiBook(api, "202", guest.id, todayPlus(3), todayPlus(5));

    await login(page, frontdeskUsername(), frontdeskPassword());
    await uiOpenFrontDesk(page);

    const barA = reservationBar(page, first.reservation_no);
    const barB = reservationBar(page, second.reservation_no);
    await expect(barA).toBeVisible();
    await expect(barB).toBeVisible();
    const boxA = await barA.boundingBox();
    const boxB = await barB.boundingBox();
    expect(boxA).not.toBeNull();
    expect(boxB).not.toBeNull();
    // 两晚各 2 列宽（128px）
    expect(boxA!.width).toBeGreaterThanOrEqual(124);
    expect(boxA!.width).toBeLessThanOrEqual(132);
    expect(boxB!.width).toBeGreaterThanOrEqual(124);
    expect(boxB!.width).toBeLessThanOrEqual(132);
    // 首尾相接：[d+3) 左缘 = 前一晚条右缘（允许 2px 容差）
    const gap = boxB!.x - (boxA!.x + boxA!.width);
    expect(Math.abs(gap)).toBeLessThanOrEqual(2);

    // 清理：取消两笔（保持后续用例确定）
    await apiCancelReservation(api, first.id);
    await apiCancelReservation(api, second.id);
    await closeApi(api);
  });

  test("Attention 三条规则：脏房到店(A) / 超期在住(B) / 停用房未来预订(C)", async ({ page }) => {
    test.setTimeout(150_000);
    const api = await adminApi();

    // A：206 脏房 + 今日到店 CONFIRMED
    await apiEnsureAvailableClean(api, "206");
    await apiEnsureCleaning(api, "206", "dirty");
    const guestA = await apiCreateGuest(api, { name: "脏房到店客", phone: "13800003333" });
    await apiBook(api, "206", guestA.id, TODAY, todayPlus(1));

    // B：207 入住后把计划退房日改为昨天（真实 UPDATE，见 setup_overdue_stay.py）
    await apiEnsureAvailableClean(api, "207");
    const guestB = await apiCreateGuest(api, { name: "超期在住客", phone: "13800004444" });
    const resB = await apiBook(api, "207", guestB.id, todayPlus(-2), todayPlus(2));
    const { stay } = await apiCheckIn(api, resB.id);
    makeStayOverdue(stay.id);

    // C：208 先预订，再锁房（房间后来不可用的真实场景）
    await apiEnsureAvailableClean(api, "208");
    const guestC = await apiCreateGuest(api, { name: "锁房预订客", phone: "13800005555" });
    await apiBook(api, "208", guestC.id, todayPlus(2), todayPlus(4));
    await apiEnsureOccupancy(api, "208", "blocked");
    await closeApi(api);

    await login(page, frontdeskUsername(), frontdeskPassword());
    await uiOpenFrontDesk(page);

    // 需关注 ≥ 3（全套件顺序运行下，此前 spec 可能遗留其它注意力条目，
    // 本用例只断言三条目标规则的条目存在）
    const attentionCard = page.locator('[data-summary-card="attention"]').first();
    await expect(attentionCard).toBeVisible();
    await attentionCard.click();

    const drawer = page.getByRole("dialog", { name: "需关注" });
    await expect(drawer).toBeVisible();
    // A：脏房到店（206；其它 spec 可能也有脏房到店条目，取 first）
    await expect(drawer.getByText(/到店房间未准备/).first()).toBeVisible();
    await expect(drawer.getByText(/尚未准备完成/).first()).toBeVisible();
    // B：207 超期在住
    await expect(drawer.getByText(/在住超期/)).toBeVisible();
    await expect(drawer.getByText(/已超过计划退房日/)).toBeVisible();
    // C：208 锁房未来预订
    await expect(drawer.getByText(/房间不可用/)).toBeVisible();
    await expect(drawer.getByText(/blocked/)).toBeVisible();
  });

  test("Housekeeping 集成：脏房到店 → 任务可见 → 完成清扫 → 刷新 clean → Check-in 成功", async ({ page }) => {
    test.setTimeout(180_000);
    const api = await frontdeskApi();
    // 状态准备（幂等）：206 可售 + 脏房 + 今日到店预订 + 进行中任务
    // （注意：dirty→clean 只能经保洁任务闭环，不能走手动房态 API）
    await apiEnsureOccupancy(api, "206", "available");
    await apiEnsureCleaning(api, "206", "dirty");
    const room206 = await apiGetRoomByNumber(api, "206");
    let arrival = (
      await apiListReservations(api, {
        room_id: room206.id as number,
        page: 1,
        page_size: 20,
      })
    ).items.find(
      (r) => r.status === "CONFIRMED" && r.check_in_date === TODAY,
    );
    if (!arrival) {
      const guest = await apiCreateGuest(api, {
        name: "翻房后入住客",
        phone: "13800006666",
      });
      arrival = await apiBook(api, "206", guest.id, TODAY, todayPlus(1));
    }
    const tasks = await api.ctx.get("/api/v1/housekeeping/tasks", {
      headers: api.headers,
      params: { room_id: room206.id, page: 1, page_size: 20 },
    });
    expect(tasks.ok()).toBeTruthy();
    const taskItems = (
      (await tasks.json()) as {
        items: { id: number; status: string; task_no: string }[];
      }
    ).items;
    const active = taskItems.find((t) =>
      ["PENDING", "IN_PROGRESS", "INSPECTION", "REWORK"].includes(t.status),
    );
    const task = active ?? (await apiCreateTask(api, room206.id as number));
    await closeApi(api);

    await login(page, frontdeskUsername(), frontdeskPassword());
    await uiOpenFrontDesk(page);

    // Attention → 查看预订（脏房到店条目，限定房间 206；其它 spec 可能遗留同类条目）
    await page.locator('[data-summary-card="attention"]').first().click();
    const attentionDrawer = page.getByRole("dialog", { name: "需关注" });
    const dirtyItem = attentionDrawer.locator("li", {
      hasText: "房间 206",
    });
    await expect(dirtyItem).toBeVisible();
    await dirtyItem.getByText("查看预订").click();
    const resDrawer = page.getByRole("dialog", { name: "预订速览" });
    await expect(resDrawer.getByText("房间尚未准备完成")).toBeVisible();
    await expect(resDrawer.getByText(new RegExp(task.task_no))).toBeVisible();
    await expect(
      resDrawer.getByRole("button", { name: "办理入住" }),
    ).toHaveCount(0);
    await resDrawer.getByRole("link", { name: /查看保洁任务/ }).click();
    await page.waitForURL(/\/housekeeping\/\d+/);
    await expect(
      page.getByRole("heading", { name: new RegExp(task.task_no) }),
    ).toBeVisible();

    // 保洁完成（真实闭环：start → submit → pass），房间 clean
    await apiCompleteTask(task.id);

    // 前台刷新后：房间 clean、Check-in 可用且成功
    await uiOpenFrontDesk(page);
    await uiExpectRoomCellStatus(page, "206", "可售", "干净");
    await reservationBar(page, arrival.reservation_no).click();
    const drawer = page.getByRole("dialog", { name: "预订速览" });
    await expect(drawer.getByRole("button", { name: "办理入住" })).toBeVisible();
    await drawer.getByRole("button", { name: "办理入住" }).click();
    const confirm = page.getByRole("dialog", { name: "办理入住" });
    await confirm.getByRole("button", { name: "办理入住" }).click();
    await expect(drawer.getByText("入住办理成功")).toBeVisible();
    await uiExpectRoomCellStatus(page, "206", "在住", "干净");
  });

  test("搜索定位：房号 → Room Drawer；预订单号 → Reservation Drawer + 日期定位", async ({ page }) => {
    const api = await frontdeskApi();
    await apiEnsureAvailableClean(api, "202");
    const guest = await apiCreateGuest(api, { name: "搜索目标客", phone: "13800007777" });
    const res = await apiBook(api, "202", guest.id, todayPlus(1), todayPlus(3));

    await login(page, frontdeskUsername(), frontdeskPassword());
    await uiOpenFrontDesk(page);

    // 房号搜索 → Room Drawer（本地匹配，不触发 PII 搜索）
    const search = page.getByLabel("搜索房号、客人、预订单号").first();
    await search.fill("202");
    await page.locator('[data-search-room="202"]').click();
    const roomDrawer = page.getByRole("dialog", { name: "房间速览" });
    await expect(roomDrawer.getByText("房间 202", { exact: true })).toBeVisible();
    await roomDrawer.getByRole("button", { name: "关闭" }).click();

    // 预订单号搜索 → Reservation Drawer（含日期信息）
    await search.fill(res.reservation_no);
    await page.locator(`[data-search-reservation="${res.id}"]`).click();
    const resDrawer = page.getByRole("dialog", { name: "预订速览" });
    await expect(resDrawer.getByText("2 晚", { exact: true })).toBeVisible();
    await expect(
      resDrawer.getByText(`${todayPlus(1)} → ${todayPlus(3)}`, { exact: true }),
    ).toBeVisible();

    await apiCancelReservation(api, res.id);
    await closeApi(api);
  });

  test("PII：无 guest:read 用户看不到姓名、姓名/手机号搜索受限", async ({ page }) => {
    const api = await adminApi();
    await apiCreatePermissionUser("fd_nopii", ["room:read", "reservation:read"]);
    await apiEnsureAvailableClean(api, "202");
    const guest = await apiCreateGuest(api, {
      name: "隐私客人乙",
      phone: "13900001111",
    });
    const res = await apiBook(api, "202", guest.id, todayPlus(2), todayPlus(4));
    await closeApi(api);

    await login(page, "fd_nopii", "User@123456");
    await uiOpenFrontDesk(page);

    // 时间线预订条不显示姓名（后端裁剪 + 前端双保险）
    const bar = reservationBar(page, res.reservation_no);
    await expect(bar).toBeVisible();
    await expect(bar).not.toContainText("隐私客人乙");
    await expect(bar).toContainText(res.reservation_no);

    // 姓名/手机号搜索受限：提示权限文案，不发起 PII 搜索
    const search = page.getByLabel("搜索房号、客人、预订单号").first();
    await search.fill("13900001111");
    await expect(
      page.getByText(/按客人姓名 \/ 手机号搜索需要 guest:read 权限/),
    ).toBeVisible();

    // 预订单号搜索可用 → Drawer 显示 ID 而非姓名
    await search.fill(res.reservation_no);
    await page.locator(`[data-search-reservation="${res.id}"]`).click();
    const drawer = page.getByRole("dialog", { name: "预订速览" });
    await expect(drawer.getByText(new RegExp(`ID ${guest.id}`))).toBeVisible();
    await expect(drawer.getByText("隐私客人乙")).toHaveCount(0);
  });

  test("RBAC：HOUSEKEEPING / FINANCE 无前台入口，直连 /front-desk → 无权限", async ({ page }) => {
    // FINANCE 角色用户（真实种子角色 + API 分配）
    const api = await adminApi();
    const rolesResp = await api.ctx.get("/api/v1/roles", {
      headers: api.headers,
      params: { page: 1, page_size: 100 },
    });
    const roles = ((await rolesResp.json()) as { items: { id: number; name: string }[] }).items;
    const financeRole = roles.find((r) => r.name === "FINANCE");
    expect(financeRole).toBeTruthy();
    const userResp = await api.ctx.post("/api/v1/users", {
      headers: api.headers,
      data: { username: "fd_finance", password: "User@123456", is_active: true },
    });
    expect(userResp.ok()).toBeTruthy();
    const user = (await userResp.json()) as { id: number };
    await api.ctx.post(`/api/v1/users/${user.id}/roles`, {
      headers: api.headers,
      data: { role_ids: [financeRole!.id] },
    });
    await closeApi(api);

    // HOUSEKEEPING：导航无前台入口，直连 403 语义
    await login(page, housekeepingUsername(), housekeepingPassword());
    await expect(page.getByRole("link", { name: "前台" })).toHaveCount(0);
    await page.goto("/front-desk");
    await expect(page.getByText(/无权限访问前台工作台/)).toBeVisible();

    // FINANCE：同矩阵（先清 Cookie，登录页对已登录用户会跳转 /dashboard）
    await page.context().clearCookies();
    await login(page, "fd_finance", "User@123456");
    await expect(page.getByRole("link", { name: "前台" })).toHaveCount(0);
    await page.goto("/front-desk");
    await expect(page.getByText(/无权限访问前台工作台/)).toBeVisible();
  });
});

test.describe("Sprint 4 Front Desk Responsive", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test.beforeAll(() => ensureTestUsers());

  test("Mobile（<768px）：FrontDeskTodayBoard，不渲染完整 Room Diary", async ({ page }) => {
    await login(page, frontdeskUsername(), frontdeskPassword());
    await page.goto("/front-desk");
    await expect(page.getByRole("heading", { name: "前台指挥台" }).first()).toBeVisible();

    // Today Board 结构（matchMedia 树切换：移动端不渲染完整 Room Diary）
    await expect(page.getByRole("heading", { name: "需关注" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "今日到店" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "今日离店" })).toBeVisible();
    await expect(
      page.getByLabel("搜索房号、客人、预订单号"),
    ).toBeVisible();
    await expect(
      page.locator('[data-summary-card="vacantClean"]'),
    ).toBeVisible();

    // 不渲染完整 Room Diary（DOM 中不存在）
    await expect(page.locator("[data-room-cell]")).toHaveCount(0);
    await expect(page.locator("[data-room-track]")).toHaveCount(0);
  });
});

test.describe("Sprint 4 Front Desk Tablet", () => {
  test.use({ viewport: { width: 900, height: 720 } });
  test.beforeAll(() => ensureTestUsers());

  test("Tablet（768-1023px）：紧凑 Room Diary 可用", async ({ page }) => {
    await login(page, frontdeskUsername(), frontdeskPassword());
    await page.goto("/front-desk");
    await expect(page.getByRole("heading", { name: "前台指挥台" }).first()).toBeVisible();
    await expect(page.locator("[data-room-cell]")).toHaveCount(28);
    await expect(page.locator("[data-day-header]")).toHaveCount(7);
  });
});
