/**
 * S2-T3 Booking RBAC（正式 E2E，真实链路）：
 * - SUPER_ADMIN：预订/在住导航可见，列表真实加载
 * - FRONT_DESK：预订/在住导航可见，可完成预订创建与取消（Golden Path 可操作性）
 * - HOUSEKEEPING：预订/在住导航不可见；直连 URL → Forbidden 视图（不跳 /login）
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
import {
  todayPlus,
  uiCreateReservation,
} from "./booking-helpers";

test.beforeAll(() => ensureTestUsers());

test("RBAC：SUPER_ADMIN 可见预订/在住导航且列表真实加载", async ({ page }) => {
  await login(page, adminUsername(), adminPassword());

  await expect(page.getByRole("link", { name: "预订" })).toBeVisible();
  await expect(page.getByRole("link", { name: "在住" })).toBeVisible();

  await page.getByRole("link", { name: "预订" }).click();
  await expect(
    page.getByRole("heading", { name: "预订管理" }),
  ).toBeVisible();

  await page.getByRole("link", { name: "在住" }).click();
  await expect(
    page.getByRole("heading", { name: "在住管理" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "退出" }).click();
  await expect(page).toHaveURL(/\/login/);
});

test("RBAC：FRONT_DESK 可见导航且可完成预订创建与取消", async ({ page }) => {
  await login(page, frontdeskUsername(), frontdeskPassword());

  await expect(page.getByRole("link", { name: "预订" })).toBeVisible();
  await expect(page.getByRole("link", { name: "在住" })).toBeVisible();

  // 未来日期（不与其它用例的房间/日期重叠）：证明创建链路可操作
  await uiCreateReservation(page, {
    guest: { create: { name: "RBAC客人", phone: "13700004444" } },
    checkIn: todayPlus(5),
    checkOut: todayPlus(7),
    roomNumber: "205",
    source: "PHONE",
    amount: "268.00",
  });
  await expect(
    page.locator("main").getByText("已确认", { exact: true }).first(),
  ).toBeVisible();

  // 取消预订（reservation:cancel；真实后端状态机 CONFIRMED → CANCELLED）
  await page.getByRole("button", { name: "取消预订" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "取消预订" }).click();
  await expect(page.getByText("预订已取消（CANCELLED）")).toBeVisible();
  await expect(
    page.locator("main").getByText("已取消", { exact: true }).first(),
  ).toBeVisible();

  // 取消后详情页无办理入住入口（状态机只读展示）
  await expect(page.getByRole("button", { name: "办理入住" })).toHaveCount(0);
});

test("RBAC：HOUSEKEEPING 预订/在住导航不可见 + 直连 URL Forbidden（不跳 /login）", async ({
  page,
}) => {
  await login(page, housekeepingUsername(), housekeepingPassword());

  await expect(page.getByRole("link", { name: "预订" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "在住" })).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "房态", exact: true }),
  ).toBeVisible();

  for (const [path, forbiddenText] of [
    ["/reservations", "无权限查看预订列表"],
    ["/reservations/new", "无权限新建预订"],
    ["/stays", "无权限查看看在住列表"],
  ] as const) {
    await page.goto(path);
    await expect(page.getByText(forbiddenText)).toBeVisible();
    await expect(page).not.toHaveURL(/\/login/);
  }
});
