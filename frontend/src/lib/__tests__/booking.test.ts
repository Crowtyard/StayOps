/**
 * Booking 前端业务工具测试：
 * - Property Business Date（Asia/Shanghai，动态日期，不硬编码年月日）
 * - addDays / validateDateRange（[check_in, check_out) 语义）
 * - 状态/来源标签元数据
 */

import { describe, expect, it } from "vitest";
import {
  RESERVATION_STATUS_META,
  SOURCE_LABELS,
  STAY_STATUS_META,
  addDays,
  businessDate,
  formatMoney,
  validateDateRange,
} from "@/lib/booking";

describe("businessDate（Asia/Shanghai 业务日期）", () => {
  it("返回 YYYY-MM-DD 格式", () => {
    expect(businessDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("与 Asia/Shanghai 实际日期一致（跨时区稳定，UTC 基准对比）", () => {
    const now = new Date();
    const shanghai = new Date(now.getTime() + 8 * 3600 * 1000);
    const expected = `${shanghai.getUTCFullYear()}-${String(
      shanghai.getUTCMonth() + 1,
    ).padStart(2, "0")}-${String(shanghai.getUTCDate()).padStart(2, "0")}`;
    expect(businessDate()).toBe(expected);
  });
});

describe("addDays", () => {
  it("日期加 N 天（跨月进位）", () => {
    expect(addDays("2026-08-30", 2)).toBe("2026-09-01");
  });

  it("支持负数", () => {
    expect(addDays("2026-09-01", -2)).toBe("2026-08-30");
  });
});

describe("validateDateRange（[check_in, check_out)）", () => {
  it("退房晚于入住 → 通过", () => {
    expect(validateDateRange("2026-08-30", "2026-09-01")).toBeNull();
  });

  it("退房等于入住 → 拒绝", () => {
    expect(validateDateRange("2026-08-30", "2026-08-30")).toBe(
      "退房日期必须晚于入住日期",
    );
  });

  it("退房早于入住 → 拒绝", () => {
    expect(validateDateRange("2026-09-01", "2026-08-30")).toBe(
      "退房日期必须晚于入住日期",
    );
  });

  it("缺失日期不报错（由必填校验处理）", () => {
    expect(validateDateRange("", "")).toBeNull();
  });
});

describe("展示元数据", () => {
  it("Reservation / Stay 状态标签齐全", () => {
    expect(RESERVATION_STATUS_META.CONFIRMED.label).toBe("已确认");
    expect(RESERVATION_STATUS_META.CHECKED_IN.label).toBe("已入住");
    expect(RESERVATION_STATUS_META.COMPLETED.label).toBe("已完成");
    expect(STAY_STATUS_META.ACTIVE.label).toBe("在住");
    expect(STAY_STATUS_META.CHECKED_OUT.label).toBe("已退房");
  });

  it("来源标签齐全", () => {
    expect(SOURCE_LABELS.WALK_IN).toBe("散客");
    expect(SOURCE_LABELS.WECHAT).toBe("微信");
  });

  it("金额直接展示后端字符串，不做浮点运算", () => {
    expect(formatMoney("428.00", "CNY")).toBe("CNY 428.00");
    expect(formatMoney(null, "CNY")).toBe("—");
  });
});
