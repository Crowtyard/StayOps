/**
 * Inventory 前端展示工具测试（Sprint 7 §54）：
 * - computeStockStatus（§19 低库存规则，与后端一致）
 * - recommendedReplenishment（§21，max(target-total, 0)）
 * - 分类 / 流水类型 / 目的地 / 状态元数据完整性与中文标签
 * - qty / fmtQty（Decimal 字符串解析与展示）
 */

import { describe, expect, it } from "vitest";
import {
  computeStockStatus,
  fmtQty,
  ISSUE_DESTINATION_LABELS,
  ITEM_CATEGORY_LABELS,
  MOVEMENT_TYPE_META,
  qty,
  recommendedReplenishment,
  STOCK_STATUS_META,
} from "@/lib/inventory";

describe("computeStockStatus（Sprint 7 §19）", () => {
  it("total == 0 → OUT_OF_STOCK", () => {
    expect(computeStockStatus(0, 0)).toBe("OUT_OF_STOCK");
    expect(computeStockStatus(0, 10)).toBe("OUT_OF_STOCK");
  });

  it("total <= minimum 且 minimum > 0 → LOW_STOCK", () => {
    expect(computeStockStatus(1, 5)).toBe("LOW_STOCK");
    expect(computeStockStatus(5, 5)).toBe("LOW_STOCK");
    expect(computeStockStatus(20, 20)).toBe("LOW_STOCK");
  });

  it("total > minimum → NORMAL", () => {
    expect(computeStockStatus(21, 20)).toBe("NORMAL");
    expect(computeStockStatus(100, 20)).toBe("NORMAL");
  });

  it("minimum = 0：只有 0 是 OUT_OF_STOCK，正库存保持 NORMAL（§19 边界）", () => {
    expect(computeStockStatus(0, 0)).toBe("OUT_OF_STOCK");
    expect(computeStockStatus(1, 0)).toBe("NORMAL");
    expect(computeStockStatus(0.5, 0)).toBe("NORMAL");
  });
});

describe("recommendedReplenishment（Sprint 7 §21）", () => {
  it("max(target - total, 0)", () => {
    expect(recommendedReplenishment(100, 30)).toBe(70);
    expect(recommendedReplenishment(100, 100)).toBe(0);
    expect(recommendedReplenishment(100, 150)).toBe(0);
    expect(recommendedReplenishment(0, 0)).toBe(0);
  });
});

describe("展示元数据（Sprint 7 §4/§5/§8/§11）", () => {
  it("分类：7 个固定一级分类 + 中文标签", () => {
    expect(Object.keys(ITEM_CATEGORY_LABELS)).toEqual([
      "GUEST_AMENITY",
      "LINEN",
      "CLEANING",
      "FRONT_DESK",
      "MAINTENANCE",
      "OFFICE",
      "OTHER",
    ]);
    expect(ITEM_CATEGORY_LABELS.GUEST_AMENITY).toBe("客用品");
    expect(ITEM_CATEGORY_LABELS.LINEN).toBe("布草");
    expect(ITEM_CATEGORY_LABELS.CLEANING).toBe("清洁用品");
  });

  it("流水类型：8 个类型全有标签", () => {
    expect(Object.keys(MOVEMENT_TYPE_META)).toEqual([
      "INITIAL",
      "PURCHASE_RECEIPT",
      "ISSUE",
      "RETURN",
      "TRANSFER_OUT",
      "TRANSFER_IN",
      "ADJUSTMENT_IN",
      "ADJUSTMENT_OUT",
    ]);
    expect(MOVEMENT_TYPE_META.PURCHASE_RECEIPT.label).toBe("采购收货");
    expect(MOVEMENT_TYPE_META.ISSUE.label).toBe("领用出库");
  });

  it("领用目的地：5 个类型 + 中文标签", () => {
    expect(ISSUE_DESTINATION_LABELS.HOUSEKEEPING).toBe("保洁间");
    expect(ISSUE_DESTINATION_LABELS.FRONT_DESK).toBe("前台");
    expect(ISSUE_DESTINATION_LABELS.MAINTENANCE).toBe("维修间");
    expect(ISSUE_DESTINATION_LABELS.ROOM).toBe("房间");
    expect(ISSUE_DESTINATION_LABELS.OTHER).toBe("其他");
  });

  it("库存状态徽标：NORMAL / LOW_STOCK / OUT_OF_STOCK 文字 + 颜色双通道", () => {
    expect(STOCK_STATUS_META.LOW_STOCK.label).toBe("低库存");
    expect(STOCK_STATUS_META.OUT_OF_STOCK.label).toBe("缺货");
    expect(STOCK_STATUS_META.LOW_STOCK.badge).toContain("amber");
    expect(STOCK_STATUS_META.OUT_OF_STOCK.badge).toContain("red");
  });
});

describe("qty / fmtQty（Decimal 字符串）", () => {
  it("qty 解析数字或字符串，空值回退 0", () => {
    expect(qty("10")).toBe(10);
    expect(qty("10.5")).toBe(10.5);
    expect(qty(3)).toBe(3);
    expect(qty(null)).toBe(0);
    expect(qty(undefined)).toBe(0);
    expect(qty("")).toBe(0);
    expect(qty("abc")).toBe(0);
  });

  it("fmtQty 去掉小数尾零", () => {
    expect(fmtQty("10.00")).toBe("10");
    expect(fmtQty("10.50")).toBe("10.5");
    expect(fmtQty(0)).toBe("0");
    expect(fmtQty(null)).toBe("0");
  });
});
