/**
 * 场景 3/4/5：RBAC 权限边界。
 * - SUPER_ADMIN 可访问用户与角色管理
 * - FRONT_DESK 无法访问角色管理（导航不可见 + 直连 BFF 403 + 页面 403 语义）
 * - HOUSEKEEPING 无权限访问用户管理
 */

import { expect, test } from "@playwright/test";
import {
  adminPassword,
  adminUsername,
  frontdeskPassword,
  frontdeskUsername,
  housekeepingPassword,
  housekeepingUsername,
  login,
} from "./helpers";
import { ensureTestUsers } from "./setup-users";

test.beforeAll(() => ensureTestUsers());

test("3. SUPER_ADMIN 可访问用户与角色管理", async ({ page }) => {
  await login(page, adminUsername(), adminPassword());

  await page.getByRole("link", { name: "用户" }).click();
  await expect(
    page.getByRole("heading", { name: "用户管理" }),
  ).toBeVisible();
  await expect(page.getByText("admin", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "角色与权限" }).click();
  await expect(
    page.getByRole("heading", { name: "角色与权限" }),
  ).toBeVisible();
  await expect(page.getByText("SUPER_ADMIN").first()).toBeVisible();
});

test("4. FRONT_DESK 无法访问角色管理（导航不可见 + 直连请求 403）", async ({
  page,
}) => {
  await login(page, frontdeskUsername(), frontdeskPassword());

  // 导航不可见
  await expect(page.getByRole("link", { name: "用户" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "角色与权限" })).toHaveCount(0);
  // 可见其权限范围内的房态/房型/审计入口
  await expect(
    page.getByRole("link", { name: "房态", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "房型" })).toBeVisible();

  // 直连 BFF 请求角色列表 → 后端 403
  const resp = await page.request.get("/api/bff/roles", {
    params: { page: 1, page_size: 20 },
  });
  expect(resp.status()).toBe(403);

  // 直接访问角色管理页面 → 显示无权限（不误跳登录）
  await page.goto("/settings/roles");
  await expect(page.getByText("无权限访问该页面")).toBeVisible();
  await expect(page).not.toHaveURL(/\/login/);
});

test("5. HOUSEKEEPING 无权限访问用户管理", async ({ page }) => {
  await login(page, housekeepingUsername(), housekeepingPassword());

  // 保洁无用户/房型管理入口
  await expect(page.getByRole("link", { name: "用户" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "房型" })).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "房态", exact: true }),
  ).toBeVisible();

  // 直连 BFF 请求用户列表 → 后端 403
  const resp = await page.request.get("/api/bff/users");
  expect(resp.status()).toBe(403);

  // 直接访问用户管理 → 显示无权限，不跳登录
  await page.goto("/settings/users");
  await expect(page.getByText("无权限访问该页面")).toBeVisible();
  await expect(page).not.toHaveURL(/\/login/);
});
