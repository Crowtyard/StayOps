/**
 * 场景 6/7/8/9：管理页真实读取 + 审计能看到实际房态变更。
 */

import { expect, test } from "@playwright/test";
import {
  adminPassword,
  adminUsername,
  frontdeskUsername,
  login,
  openRoomDetail,
} from "./helpers";
import { ensureTestUsers } from "./setup-users";

test.beforeAll(() => ensureTestUsers());

test("6. 用户管理真实读取（列表来自后端）", async ({ page }) => {
  await login(page, adminUsername(), adminPassword());
  await page.getByRole("link", { name: "用户" }).click();
  await expect(
    page.getByRole("heading", { name: "用户管理" }),
  ).toBeVisible();

  // 种子 admin + setup-users.ts（beforeAll）创建的 E2E 账号均来自后端
  await expect(page.getByText("admin", { exact: true })).toBeVisible();
  await expect(
    page.getByText(frontdeskUsername(), { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByText("SUPER_ADMIN").first()).toBeVisible();
  await expect(page.getByText("FRONT_DESK").first()).toBeVisible();
});

test("7. 角色和权限真实读取", async ({ page }) => {
  await login(page, adminUsername(), adminPassword());
  await page.getByRole("link", { name: "角色与权限" }).click();
  await expect(
    page.getByRole("heading", { name: "角色与权限" }),
  ).toBeVisible();

  for (const name of ["SUPER_ADMIN", "FRONT_DESK", "HOUSEKEEPING", "MAINTENANCE"]) {
    await expect(page.getByText(name).first()).toBeVisible();
  }

  // 打开 FRONT_DESK 的权限查看
  const row = page.getByRole("row", { name: /FRONT_DESK/ }).first();
  await row.getByRole("button", { name: /权限/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("room:read")).toBeVisible();
  await expect(dialog.getByText("room_type:read")).toBeVisible();
  await dialog.getByRole("button", { name: "取消" }).click();
});

test("8. 房型真实读取", async ({ page }) => {
  await login(page, adminUsername(), adminPassword());
  await page.getByRole("link", { name: "房型" }).click();
  await expect(
    page.getByRole("heading", { name: "房型管理" }),
  ).toBeVisible();

  await expect(page.getByText("共 6 个房型")).toBeVisible();
  for (const name of ["标准大床房", "标准双床房", "豪华套房", "行政套房"]) {
    await expect(page.getByText(name, { exact: true })).toBeVisible();
  }
  // 房间数来自后端 room_count
  await expect(page.getByText("8 间", { exact: true }).first()).toBeVisible();
});

test("9. Audit Log 能看到实际房态变更记录", async ({ page }) => {
  await login(page, adminUsername(), adminPassword());

  // 真实修改房间 104 的清洁状态 clean -> dirty
  await openRoomDetail(page, "104");
  const cleaning = page.getByTestId("cleaning-status-form");
  await cleaning.getByLabel("修改清洁状态").selectOption("dirty");
  await cleaning.getByRole("button", { name: "应用" }).click();
  await expect(page.getByText(/清洁状态已更新为「待清扫」/)).toBeVisible();

  // 审计页应出现该变更（action=room.status_change）
  await page.getByRole("link", { name: "审计日志" }).click();
  await expect(
    page.getByRole("heading", { name: "审计日志" }),
  ).toBeVisible();

  await page.getByLabel("操作类型").selectOption("room.status_change");
  const row = page.getByRole("row", { name: /room\.status_change/ }).first();
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "详情" }).click();
  const pre = page.locator("pre").first();
  await expect(pre).toContainText('"cleaning_status"');
  await expect(pre).toContainText('"from": "clean"');
  await expect(pre).toContainText('"to": "dirty"');
});
