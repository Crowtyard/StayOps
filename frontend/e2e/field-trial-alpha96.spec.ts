/**
 * alpha.9.6 Field Trial Operations Improvements · 真实 E2E（Playwright，禁止 Mock）。
 *
 * 覆盖任务书 §12 要求的 4 条真实端到端流程：
 *   Flow 1：新增房间 301 → 编辑为「豪华大床房」→ Rooms / Dashboard 正确出现
 *   Flow 2：创建未来 Reservation → 日期切到入住日 → 对应房间显示「已预订」
 *   Flow 3：创建渠道「电话」→ 创建 Reservation 选择「电话」→ 详情页显示「电话」
 *   Flow 4：经营分析时间范围内 → 渠道统计出现「电话」
 *
 * 全部经浏览器 UI（BFF）+ 真实 FastAPI + stayops_test 库；数据构造用真实 API。
 * 房间使用 9xx 段 + 运行期随机后缀，避免影响其它用例的 28 房断言。
 */

import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import {
  addDays,
  adminApi,
  apiCreateGuest,
  apiCreateReservation,
  apiListChannels,
  businessDate,
  closeApi,
  type ApiSession,
} from "./booking-helpers";
import { adminPassword, adminUsername, login } from "./helpers";

const suffix = () => Math.random().toString(36).slice(2, 6).toUpperCase();

/** 房间卡片链接的可访问名（房号 + 可选名称/标签），避免前缀误匹配。 */
const roomLinkName = (roomNumber: string) =>
  new RegExp(`^${roomNumber}($|\\s|（)`);

/**
 * 运行 e2e/ 下的 Python 辅助脚本（历史时间回填 / 房间清理）。
 *
 * 必须显式注入 DATABASE_URL：脚本自身会拒绝非 `stayops_test` 目标。
 */
function runPythonHelper(
  script: string,
  args: string[],
): { status: number | null; out: string } {
  const result = spawnSync(
    "..\\backend\\.venv\\Scripts\\python.exe",
    ["e2e\\" + script, ...args],
    {
      cwd: process.cwd(),
      encoding: "utf-8",
      env: {
        ...process.env,
        DATABASE_URL:
          process.env.E2E_DATABASE_URL ??
          "postgresql+psycopg2://stayops:change-me@localhost:5432/stayops_test",
      },
    },
  );
  return {
    status: result.status,
    out: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

/** 经真实 API 新建一间专属房间（9xx 段 + 随机后缀，避免与其它用例冲突）。 */
async function apiCreateRoom(
  api: ApiSession,
): Promise<{ id: number; room_number: string; room_type_id: number }> {
  const typesResp = await api.ctx.get("/api/v1/room-types", {
    headers: api.headers,
    params: { page: 1, page_size: 100 },
  });
  expect(typesResp.status()).toBe(200);
  const roomTypeId = (
    (await typesResp.json()) as { items: { id: number; name: string }[] }
  ).items[0].id;
  const roomNumber = `9${suffix()}${Math.floor(Math.random() * 90 + 10)}`;
  const resp = await api.ctx.post("/api/v1/rooms", {
    headers: api.headers,
    data: { room_number: roomNumber, room_type_id: roomTypeId, floor: 9 },
  });
  expect(resp.status(), `创建房间失败：${await resp.text()}`).toBe(201);
  return (await resp.json()) as {
    id: number;
    room_number: string;
    room_type_id: number;
  };
}

/** 打开房态棋盘并切到「房间资料」管理视图 */
async function openRoomsManage(page: import("@playwright/test").Page) {
  await page.getByRole("link", { name: "房态", exact: true }).click();
  await expect(page.getByRole("heading", { name: "房态棋盘" })).toBeVisible();
  await page.getByRole("tab", { name: "房间资料" }).click();
  await expect(page.getByText("总房间数")).toBeVisible();
}

/** 打开首页房态概览并等待按日期房态加载完成 */
async function openDashboard(page: import("@playwright/test").Page, date: string) {
  await page.goto("/dashboard");
  await expect(
    page.getByRole("heading", { name: `房态概览 · ${date}` }),
  ).toBeVisible({ timeout: 15_000 });
}

test.describe("alpha.9.6 现场反馈闭环", () => {
  let api: ApiSession;

  test.beforeAll(async () => {
    api = await adminApi();
  });

  test.afterAll(async () => {
    await closeApi(api);
  });

  test("Flow 1：新增房间 → 编辑为「豪华大床房」→ Rooms 与 Dashboard 正确出现", async ({
    page,
  }) => {
    const roomNumber = `9${suffix()}`;
    const displayName = `豪华大床房-${suffix()}`;

    await login(page, adminUsername(), adminPassword());
    await openRoomsManage(page);

    const before = await page
      .getByText("总房间数")
      .locator("xpath=following-sibling::p[1]")
      .textContent();
    const beforeCount = Number(before);

    // 新增房间（房号 + 房间名称 + 房型 + 楼层）
    await page.getByRole("button", { name: "新增房间" }).click();
    let dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(/^房号/).fill(roomNumber);
    await dialog.getByLabel(/^房间名称/).fill("大床房");
    await dialog.getByLabel(/^房型/).selectOption({ label: "标准大床房" });
    await dialog.getByLabel(/^楼层/).fill("9");
    await dialog.getByRole("button", { name: "保存" }).click();
    // 列表来自后端真实结果
    await expect(
      page.getByRole("row", { name: new RegExp(`^${roomNumber}`) }),
    ).toBeVisible({ timeout: 20_000 });

    // 房间数量由后端 COUNT 计算（新增后 +1）
    await expect(
      page
        .getByText("总房间数")
        .locator("xpath=following-sibling::p[1]"),
    ).toHaveText(String(beforeCount + 1));

    // 编辑：改名为「豪华大床房」并改房型
    const row = page.getByRole("row", { name: new RegExp(`^${roomNumber}`) });
    await row.getByRole("button", { name: "编辑" }).click();
    dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(/^房间名称/).fill(displayName);
    await dialog.getByLabel(/^房型/).selectOption({ label: "豪华大床房" });
    await dialog.getByRole("button", { name: "保存" }).click();
    await expect(
      page.getByRole("row", { name: new RegExp(`^${roomNumber}`) }),
    ).toContainText(displayName);
    await expect(
      page.getByRole("row", { name: new RegExp(`^${roomNumber}`) }),
    ).toContainText("豪华大床房");

    // 房态棋盘出现该房（卡片沿用 room.name 优先展示）
    await page.getByRole("tab", { name: "房态棋盘" }).click();
    await expect(
      page.getByRole("link", { name: new RegExp(`^${roomNumber}\\s`) }),
    ).toBeVisible({ timeout: 15_000 });

    // Dashboard 房态概览：启用房间数 +1，且该房出现在「可售」分类并可钻取
    const today = businessDate();
    await openDashboard(page, today);
    const enabledCard = page.getByRole("button", { name: /启用房间/ });
    await expect(enabledCard).toContainText(String(beforeCount + 1));
    await page.getByRole("button", { name: /^可售/ }).click();
    const drillLink = page.getByRole("link", {
      name: new RegExp(`^${roomNumber}($|\\s|（)`),
    });
    await expect(drillLink).toBeVisible({ timeout: 15_000 });
    await expect(drillLink).toContainText(displayName);

    // 自清理：该房无任何业务历史，物理删除后不留痕（保护 28 房断言）
    const cleanup = runPythonHelper("cleanup_e2e_room.py", [roomNumber]);
    expect(cleanup.status, `清理房间失败：${cleanup.out}`).toBe(0);
  });

  test("Flow 2：未来 Reservation → 切到入住日 → 对应房间显示「已预订」", async ({
    page,
  }) => {
    // 专属房间 + 未来预订（真实后端）
    const room = await apiCreateRoom(api);

    const checkIn = addDays(businessDate(), 14);
    const checkOut = addDays(businessDate(), 16);
    const guest = await apiCreateGuest(api, {
      name: `日期切房态-${suffix()}`,
      phone: `139${Math.floor(Math.random() * 100000000)
        .toString()
        .padStart(8, "0")}`,
    });
    await apiCreateReservation(api, {
      guest_id: guest.id,
      room_id: room.id,
      room_type_id: room.room_type_id,
      check_in_date: checkIn,
      check_out_date: checkOut,
      agreed_total_amount: "428.00",
    });

    await login(page, adminUsername(), adminPassword());

    // 默认今天：该房可售（未来预订不影响今天）
    await openDashboard(page, businessDate());
    await page.getByRole("button", { name: /^可售/ }).click();
    await expect(
      page.getByRole("link", { name: roomLinkName(room.room_number) }),
    ).toBeVisible({ timeout: 15_000 });

    // 切到入住日：该房进入「已预订」，并标记「今日到店」
    await page.getByLabel("房态日期").fill(checkIn);
    await expect(
      page.getByRole("heading", { name: `房态概览 · ${checkIn}` }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByText("未来日期：物理房态仅供参考，以预订占用为准"),
    ).toBeVisible();

    await page.getByRole("button", { name: /^已预订/ }).click();
    const roomLink = page.getByRole("link", {
      name: roomLinkName(room.room_number),
    });
    await expect(roomLink).toBeVisible({ timeout: 20_000 });
    await expect(roomLink).toContainText("今日到店");

    // 用「后一天」按钮切到次晚（仍为已预订，但不再是到店日）
    await page.getByRole("button", { name: "后一天" }).click();
    const nextDay = addDays(checkIn, 1);
    await expect(
      page.getByRole("heading", { name: `房态概览 · ${nextDay}` }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole("link", { name: roomLinkName(room.room_number) }),
    ).toBeVisible({ timeout: 20_000 });

    // 「今天」按钮回到业务日期
    await page.getByRole("button", { name: "今天" }).click();
    await expect(
      page.getByRole("heading", { name: `房态概览 · ${businessDate()}` }),
    ).toBeVisible({ timeout: 15_000 });

    // 自清理：删除该房及其预订/入住派生记录
    const cleanup = runPythonHelper("cleanup_e2e_room.py", [room.room_number]);
    expect(cleanup.status, `清理房间失败：${cleanup.out}`).toBe(0);
  });

  test("Flow 3：新增渠道「电话」→ 预订选择该渠道 → 详情页显示渠道名", async ({
    page,
  }) => {
    const channelName = `电话-${suffix()}`;

    await login(page, adminUsername(), adminPassword());

    // 渠道管理：新增自定义渠道
    await page.getByRole("link", { name: "渠道", exact: true }).click();
    await expect(page.getByRole("heading", { name: "渠道管理" })).toBeVisible();
    await page.getByRole("button", { name: "新增渠道" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(/^渠道名称/).fill(channelName);
    await dialog.getByLabel(/^类别/).selectOption("OFFLINE");
    await dialog.getByRole("button", { name: "保存" }).click();
    await expect(
      page.getByText(new RegExp(`渠道「${channelName}」已创建`)),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("cell", { name: channelName })).toBeVisible();
    // 系统预置渠道仍在（不被删除/改名）
    await expect(page.getByRole("cell", { name: "美团" })).toBeVisible();

    // 新建预订：来源渠道下拉选择刚建的渠道。
    // **必须使用本用例自建的房间**（不能借用种子房：种子房被其它并发/换房用例
    // 依赖，本用例结束会清理自建数据，借用种子房会破坏其它用例的前置状态）。
    const room = await apiCreateRoom(api);

    await page.goto("/reservations/new");
    await expect(page.getByRole("heading", { name: "新建预订" })).toBeVisible();
    await page.getByRole("button", { name: "新建客人" }).click();
    const guestDialog = page.getByRole("dialog");
    await guestDialog.getByLabel("姓名").fill(`渠道客人-${suffix()}`);
    await guestDialog
      .getByLabel("手机号")
      .fill(`138${Math.floor(Math.random() * 100000000).toString().padStart(8, "0")}`);
    await guestDialog.getByRole("button", { name: "创建", exact: true }).click();
    await expect(guestDialog).not.toBeVisible();

    const checkIn = addDays(businessDate(), 30);
    const checkOut = addDays(businessDate(), 32);
    await page.getByLabel("入住日期").fill(checkIn);
    await page.getByLabel("退房日期").fill(checkOut);

    const roomButton = page.getByRole("button", {
      name: new RegExp(`^${room.room_number}\\s`),
    });
    await expect(roomButton).toBeVisible({ timeout: 15_000 });
    await roomButton.click();

    // 来源渠道：下拉里能选到新渠道（现场需求「其他可编辑/扩展」）
    const channelSelect = page.getByLabel("来源渠道");
    await expect(channelSelect).toBeVisible();
    const createdChannel = (await apiListChannels(api)).find(
      (c) => c.name === channelName,
    );
    expect(createdChannel, `渠道「${channelName}」应存在`).toBeTruthy();
    await channelSelect.selectOption(String(createdChannel?.id));
    await expect(channelSelect).toHaveValue(/.+/);

    await page.getByLabel("约定金额").fill("428.00");
    await page.getByRole("button", { name: "创建预订" }).click();
    await page.waitForURL(/\/reservations\/(\d+)/, { timeout: 15_000 });

    // 详情页展示「来源渠道：<渠道名>」
    await expect(
      page.getByRole("heading", { name: /^预订 RSV/ }),
    ).toBeVisible();
    await expect(page.getByText("来源渠道").first()).toBeVisible();
    await expect(page.getByText(channelName).first()).toBeVisible();
    await expect(page.getByText("来源渠道").first().locator("..")).toContainText(
      channelName,
    );

    // 自清理：该渠道被上面这单引用，无法直接删除；先清掉该房与其预订，
    // 再删除渠道，避免污染其它用例（渠道名称唯一，遗留会累积）
    const cleanup = runPythonHelper("cleanup_e2e_room.py", [room.room_number]);
    expect(cleanup.status, `清理房间失败：${cleanup.out}`).toBe(0);
    const delChannel = await api.ctx.delete(`/api/v1/channels/${createdChannel?.id}`, {
      headers: api.headers,
    });
    expect(delChannel.status(), await delChannel.text()).toBe(204);
  });

  test("Flow 4：经营分析渠道统计出现该渠道（含停用渠道历史仍可见）", async ({
    page,
  }) => {
    const channelName = `渠道分析-${suffix()}`;

    // 用 API 建渠道 + 一笔当天入住的预订（并真实 check-in，使房晚与房费可统计）
    const createResp = await api.ctx.post("/api/v1/channels", {
      headers: api.headers,
      data: { name: channelName, category: "OFFLINE" },
    });
    expect(createResp.status(), await createResp.text()).toBe(201);
    const channel = (await createResp.json()) as { id: number; name: string };

    const room = await apiCreateRoom(api);

    const guest = await apiCreateGuest(api, {
      name: `渠道分析客人-${suffix()}`,
      phone: `137${Math.floor(Math.random() * 100000000).toString().padStart(8, "0")}`,
    });
    const reservation = await apiCreateReservation(api, {
      guest_id: guest.id,
      room_id: room.id,
      room_type_id: room.room_type_id,
      // 计划区间必须「包含今天」（check-in 仅可在业务日期落在区间内办理），
      // 且 planned_nights = 2，使 600.00 分摊为 300.00/晚；
      // 实际入住/退房都在今天 -> 今天贡献 1 个有价房晚 = 300.00
      check_in_date: addDays(businessDate(), -1),
      check_out_date: addDays(businessDate(), 1),
      source_channel_id: channel.id,
      agreed_total_amount: "600.00",
    });
    const checkInResp = await api.ctx.post(
      `/api/v1/reservations/${reservation.id}/check-in`,
      { headers: api.headers },
    );
    expect(checkInResp.status(), await checkInResp.text()).toBe(200);
    const stayId = ((await checkInResp.json()) as { stay: { id: number } }).stay.id;

    // 历史房晚：E2E 只能在今天入住；用仓库既有 backdate 脚本
    // （e2e/setup_backdate_stay.py，仅允许 stayops_test）把实际入住时刻回填到昨天，
    // 使报告期 [today-7, today) 内有确定性的 1 个有价房晚（Actual 不含当天）。
    const backdate = runPythonHelper("setup_backdate_stay.py", [String(stayId), "1"]);
    expect(backdate.status, `回填历史时间戳失败：${backdate.out}`).toBe(0);

    const checkOutResp = await api.ctx.post(`/api/v1/stays/${stayId}/check-out`, {
      headers: api.headers,
    });
    expect(checkOutResp.status(), await checkOutResp.text()).toBe(200);

    await login(page, adminUsername(), adminPassword());
    await page.getByRole("link", { name: "经营分析", exact: true }).click();
    await expect(page.getByRole("heading", { name: "经营分析" })).toBeVisible();

    // 时间范围选「近 7 天」（默认 30 天也可，这里显式选择以覆盖时间范围语义）
    await page.getByRole("button", { name: "过去7天" }).click();

    await page.getByRole("tab", { name: "客源渠道" }).click();
    await expect(
      page.getByRole("columnheader", { name: "合同房费" }),
    ).toBeVisible({ timeout: 20_000 });

    const row = page.getByRole("row", { name: new RegExp(channelName) });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toContainText("300.00");
    // 口径诚实：合同房费 ≠ 实际收款
    await expect(page.getByText(/合同房费为非实际收款/)).toBeVisible();

    // 渠道停用后历史业绩仍出现在经营分析中（不破坏历史）
    const disableResp = await api.ctx.post(
      `/api/v1/channels/${channel.id}/disable`,
      { headers: api.headers },
    );
    expect(disableResp.status()).toBe(200);
    await page.reload();
    await page.getByRole("tab", { name: "客源渠道" }).click();
    const rowAfter = page.getByRole("row", { name: new RegExp(channelName) });
    await expect(rowAfter).toBeVisible({ timeout: 20_000 });
    await expect(rowAfter).toContainText("已停用");
    await expect(rowAfter).toContainText("300.00");

    // 自清理：删除该房（含入住/保洁派生记录）与渠道
    const cleanup = runPythonHelper("cleanup_e2e_room.py", [room.room_number]);
    expect(cleanup.status, `清理房间失败：${cleanup.out}`).toBe(0);
    const delChannel = await api.ctx.delete(`/api/v1/channels/${channel.id}`, {
      headers: api.headers,
    });
    expect(delChannel.status(), await delChannel.text()).toBe(204);
  });
});
