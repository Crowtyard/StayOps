/**
 * E2E 共用工具：UI 登录（经 /api/auth/login BFF，浏览器不接触 Token）。
 */

import { expect, type Page } from "@playwright/test";

export function adminUsername(): string {
  const v = process.env.E2E_ADMIN_USERNAME;
  if (!v) throw new Error("缺少 E2E_ADMIN_USERNAME 环境变量（检查凭据文件）");
  return v;
}

export function adminPassword(): string {
  const v = process.env.E2E_ADMIN_PASSWORD;
  if (!v) throw new Error("缺少 E2E_ADMIN_PASSWORD 环境变量（检查凭据文件）");
  return v;
}

export function frontdeskUsername(): string {
  const v = process.env.E2E_FRONT_DESK_USERNAME;
  if (!v) throw new Error("缺少 E2E_FRONT_DESK_USERNAME 环境变量");
  return v;
}

export function frontdeskPassword(): string {
  const v = process.env.E2E_FRONT_DESK_PASSWORD;
  if (!v) throw new Error("缺少 E2E_FRONT_DESK_PASSWORD 环境变量");
  return v;
}

export function housekeepingUsername(): string {
  const v = process.env.E2E_HOUSEKEEPING_USERNAME;
  if (!v) throw new Error("缺少 E2E_HOUSEKEEPING_USERNAME 环境变量");
  return v;
}

export function housekeepingPassword(): string {
  const v = process.env.E2E_HOUSEKEEPING_PASSWORD;
  if (!v) throw new Error("缺少 E2E_HOUSEKEEPING_PASSWORD 环境变量");
  return v;
}

export function managerUsername(): string {
  const v = process.env.E2E_MANAGER_USERNAME;
  if (!v) throw new Error("缺少 E2E_MANAGER_USERNAME 环境变量");
  return v;
}

export function managerPassword(): string {
  const v = process.env.E2E_MANAGER_PASSWORD;
  if (!v) throw new Error("缺少 E2E_MANAGER_PASSWORD 环境变量");
  return v;
}

export function maintenanceUsername(): string {
  const v = process.env.E2E_MAINTENANCE_USERNAME;
  if (!v) throw new Error("缺少 E2E_MAINTENANCE_USERNAME 环境变量");
  return v;
}

export function maintenancePassword(): string {
  const v = process.env.E2E_MAINTENANCE_PASSWORD;
  if (!v) throw new Error("缺少 E2E_MAINTENANCE_PASSWORD 环境变量");
  return v;
}

export async function login(
  page: Page,
  username: string,
  password: string,
): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

/** 顶栏退出登录并等待回到登录页（切换账号前调用）。 */
export async function logout(page: Page): Promise<void> {
  await page.getByRole("button", { name: "退出" }).click();
  await expect(page).toHaveURL(/\/login/);
}

/** 打开侧边导航中的房态棋盘并进入指定房号详情 */
export async function openRoomDetail(page: Page, roomNumber: string) {
  await page.getByRole("link", { name: "房态", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "房态棋盘" }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: new RegExp(`^${roomNumber}\\s`) })
    .click();
  await expect(
    page.getByRole("heading", { name: `房间 ${roomNumber}` }),
  ).toBeVisible();
}
