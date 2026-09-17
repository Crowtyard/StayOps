/**
 * S2-T3 Sprint 1 回归补充（与既有 10 条用例互补，不得替代）：
 * 登录 → Dashboard 真实房态 → BFF 真实代理 → 房态棋盘 → 房间 103 状态修改
 * → 审计真实记录 → 登出后受保护页面守卫。
 *
 * 既有 auth.spec / rbac.spec / rooms.spec / settings.spec（10 条）保持原样。
 */

import { expect, test } from "@playwright/test";
import { adminPassword, adminUsername, login, openRoomDetail } from "./helpers";

test("Sprint 1 回归补充：登录 / BFF / 房态 / 状态修改 / 审计 / 登出守卫", async ({
  page,
}) => {
  await login(page, adminUsername(), adminPassword());

  // Dashboard：真实后端数据（28 间种子房）
  const main = page.locator("main");
  await expect(main.getByText("启用房间", { exact: true })).toBeVisible();
  await expect(main.getByText("28", { exact: true }).first()).toBeVisible();

  // BFF 真实代理链路（浏览器 → BFF → FastAPI）
  const resp = await page.request.get("/api/bff/rooms", {
    params: { page: 1, page_size: 100 },
  });
  expect(resp.status()).toBe(200);
  const roomsPage = (await resp.json()) as { total: number };
  expect(roomsPage.total).toBe(28);

  // 房态棋盘：28 张房卡
  await page.getByRole("link", { name: "房态", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "房态棋盘" }),
  ).toBeVisible();
  await expect(page.locator("ul.grid > li")).toHaveCount(28);

  // 房间 103 清洁状态变更（真实后端状态机）
  await openRoomDetail(page, "103");
  const cleaning = page.getByTestId("cleaning-status-form");
  await cleaning.getByLabel("修改清洁状态").selectOption("dirty");
  await cleaning.getByRole("button", { name: "应用" }).click();
  await expect(page.getByText(/清洁状态已更新为「待清扫」/)).toBeVisible();

  // 审计日志真实记录 room.status_change
  await page.getByRole("link", { name: "审计日志" }).click();
  await expect(
    page.getByRole("heading", { name: "审计日志" }),
  ).toBeVisible();
  await page.getByLabel("操作类型").selectOption("room.status_change");
  await expect(
    page.getByRole("row", { name: /room\.status_change/ }).first(),
  ).toBeVisible();

  // 登出后受保护页面重新要求认证
  await page.getByRole("button", { name: "退出" }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto("/rooms");
  await expect(page).toHaveURL(/\/login/);
});
