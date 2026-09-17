/**
 * 场景 1 & 10：管理员登录进 Dashboard；退出后受保护页面重新要求认证。
 */

import { expect, test } from "@playwright/test";
import { adminPassword, adminUsername, login } from "./helpers";

test("1. 管理员登录并进入 Dashboard（真实后端数据）", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("用户名").fill(adminUsername());
  await page.getByLabel("密码").fill(adminPassword());
  await page.getByRole("button", { name: "登录" }).click();

  await expect(page).toHaveURL(/\/dashboard/);
  await expect(
    page.getByRole("heading", { name: /房态概览/ }),
  ).toBeVisible();
  // 真实种子数据：28 间启用客房（alpha.9.6 F2：首页为「某日房态」，
  // 卡片标签由「总房」改为「启用房间」——停用房间不计入可售口径）
  const main = page.locator("main");
  await expect(main.getByText("启用房间", { exact: true })).toBeVisible();
  await expect(main.getByText("28", { exact: true }).first()).toBeVisible();
  // 顶栏显示当前用户与角色
  await expect(page.getByText("SUPER_ADMIN").first()).toBeVisible();
});

test("10. 退出登录后受保护页面重新要求认证", async ({ page }) => {
  await login(page, adminUsername(), adminPassword());
  await expect(page).toHaveURL(/\/dashboard/);

  await page.getByRole("button", { name: "退出" }).click();
  await expect(page).toHaveURL(/\/login/);

  // 再次直接访问受保护页面 → 被登录守卫重定向
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login/);
});
