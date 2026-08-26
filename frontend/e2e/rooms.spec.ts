/**
 * 场景 2：Rooms 基础链路回归（28 房棋盘、详情、状态修改、刷新保持）。
 * 真实后端状态机：available -> occupied 合法；blocked 变更需确认框。
 */

import { expect, test } from "@playwright/test";
import { adminPassword, adminUsername, login, openRoomDetail } from "./helpers";

test("2. Rooms 基础链路回归（28 房棋盘、详情、状态修改、刷新保持）", async ({
  page,
}) => {
  await login(page, adminUsername(), adminPassword());

  await page.getByRole("link", { name: "房态", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "房态棋盘" }),
  ).toBeVisible();

  // 28 间种子房卡片
  const cards = page.locator("ul.grid > li");
  await expect(cards).toHaveCount(28);

  // 房间 101 详情 + 双维度状态
  await openRoomDetail(page, "101");
  await expect(page.getByText("标准大床房").first()).toBeVisible();

  // 合法状态修改：占用 available -> occupied（真实后端）
  const occupancy = page.getByTestId("occupancy-status-form");
  await occupancy.getByLabel("修改占用状态").selectOption("occupied");
  await occupancy.getByRole("button", { name: "应用" }).click();
  await expect(page.getByText(/占用状态已更新为「在住」/)).toBeVisible();

  // 刷新后状态保持
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "房间 101" }),
  ).toBeVisible();
  await expect(page.getByTestId("occupancy-status-form")).toContainText(
    "当前：在住",
  );

  // 房间 102：blocked 变更需确认框
  await openRoomDetail(page, "102");
  const occupancy102 = page.getByTestId("occupancy-status-form");
  await occupancy102.getByLabel("修改占用状态").selectOption("blocked");
  await occupancy102.getByRole("button", { name: "应用" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("确定要将占用状态变更为「锁房」吗？");
  await dialog.getByRole("button", { name: "确认变更" }).click();
  await expect(page.getByText(/占用状态已更新为「锁房」/)).toBeVisible();
});
