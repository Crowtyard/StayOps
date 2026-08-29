/**
 * Analytics 展示层工具测试（Sprint 8 §62）：
 * - metric formatting（rate / money / minutes / count）
 * - null / zero state（"—" / 0 / 暂无数据；无 NaN / Infinity）
 * - percentage points / percent change（previous=0 -> null -> "—"）
 * - date preset（7d/30d/90d/本月/上月）
 * - custom date validation（from<to、to<=业务日期、跨度<=366）
 */

import { describe, expect, it } from "vitest";
import {
  changeTone,
  comparisonModeForPreset,
  diffDays,
  fmtCount,
  fmtDays,
  fmtMinutes,
  fmtMoney,
  fmtPercentChange,
  fmtPpDelta,
  fmtRate,
  presetRange,
  validateAnalyticsRange,
} from "@/lib/analytics";

const BD = "2026-08-29";

describe("fmtRate（ratio 0..1 -> 百分比）", () => {
  it("0.643 -> 64.3%", () => {
    expect(fmtRate(0.643)).toBe("64.3%");
  });
  it("0 -> 0.0%；1 -> 100.0%", () => {
    expect(fmtRate(0)).toBe("0.0%");
    expect(fmtRate(1)).toBe("100.0%");
  });
  it("null / undefined / NaN / Infinity -> —（禁止 NaN/Infinity 展示）", () => {
    expect(fmtRate(null)).toBe("—");
    expect(fmtRate(undefined)).toBe("—");
    expect(fmtRate(Number.NaN)).toBe("—");
    expect(fmtRate(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("fmtMoney（Decimal 字符串）", () => {
  it("3550.00 -> ¥3,550.00", () => {
    expect(fmtMoney("3550.00")).toBe("¥3,550.00");
  });
  it("0.00 -> ¥0.00；null -> —", () => {
    expect(fmtMoney("0.00")).toBe("¥0.00");
    expect(fmtMoney(null)).toBe("—");
    expect(fmtMoney(undefined)).toBe("—");
  });
});

describe("fmtMinutes / fmtDays / fmtCount", () => {
  it("110.0 -> 110.0 分钟；null -> —", () => {
    expect(fmtMinutes(110)).toBe("110.0 分钟");
    expect(fmtMinutes(null)).toBe("—");
    expect(fmtMinutes(Number.NaN)).toBe("—");
  });
  it("2.3 -> 2.3 天", () => {
    expect(fmtDays(2.3)).toBe("2.3 天");
    expect(fmtDays(null)).toBe("—");
  });
  it("13 -> 13；0 -> 0；null -> —", () => {
    expect(fmtCount(13)).toBe("13");
    expect(fmtCount(0)).toBe("0");
    expect(fmtCount(null)).toBe("—");
  });
});

describe("percentage points / percent change（§32）", () => {
  it("fmtPercentChange：+0.123 -> +12.3%；-0.05 -> -5.0%；0 -> 0.0%；null -> —", () => {
    expect(fmtPercentChange(0.123)).toBe("+12.3%");
    expect(fmtPercentChange(-0.05)).toBe("-5.0%");
    expect(fmtPercentChange(0)).toBe("0.0%");
    expect(fmtPercentChange(null)).toBe("—");
    expect(fmtPercentChange(Number.POSITIVE_INFINITY)).toBe("—");
  });
  it("fmtPpDelta：0.05 -> +5.0 pp（percentage points）", () => {
    expect(fmtPpDelta(0.05)).toBe("+5.0 pp");
    expect(fmtPpDelta(-0.05)).toBe("-5.0 pp");
    expect(fmtPpDelta(null)).toBe("—");
  });
  it("changeTone：up / down / flat / none", () => {
    expect(changeTone(0.123)).toBe("up");
    expect(changeTone(-0.123)).toBe("down");
    expect(changeTone(0)).toBe("flat");
    expect(changeTone(null)).toBe("none");
  });
});

describe("date presets（§43，默认 30d；Actual to 至多业务日期）", () => {
  it("7d / 30d / 90d：半开区间 [bd-N, bd)", () => {
    expect(presetRange("7d", BD)).toEqual({ from: "2026-08-22", to: BD });
    expect(presetRange("30d", BD)).toEqual({ from: "2026-07-30", to: BD });
    expect(presetRange("90d", BD)).toEqual({ from: "2026-05-31", to: BD });
  });
  it("本月：monthStart -> bd（Actual 至多统计到业务日期当天之前）", () => {
    expect(presetRange("month", BD)).toEqual({ from: "2026-08-01", to: BD });
  });
  it("上月：上一完整自然月（跨年正确）", () => {
    expect(presetRange("lastMonth", BD)).toEqual({ from: "2026-07-01", to: "2026-08-01" });
    expect(presetRange("lastMonth", "2026-01-15")).toEqual({ from: "2025-12-01", to: "2026-01-01" });
  });
  it("custom -> null（由用户输入）", () => {
    expect(presetRange("custom", BD)).toBeNull();
  });
});

describe("custom date validation（§3/§38）", () => {
  it("from >= to -> 错误", () => {
    expect(validateAnalyticsRange("2026-08-29", "2026-08-29", BD)).toContain("早于");
    expect(validateAnalyticsRange("2026-08-30", "2026-08-29", BD)).toContain("早于");
  });
  it("to > 业务日期 -> 错误（不允许未来实际数据）", () => {
    expect(validateAnalyticsRange("2026-08-01", "2026-08-30", BD)).toContain("不能超过今天");
  });
  it("跨度 > 366 -> 错误", () => {
    expect(validateAnalyticsRange("2025-08-01", "2026-08-29", BD)).toContain("366");
  });
  it("合法区间 -> null", () => {
    expect(validateAnalyticsRange("2026-07-30", BD, BD)).toBeNull();
  });
  it("缺失日期 -> 错误", () => {
    expect(validateAnalyticsRange("", "", BD)).toContain("请选择");
  });
});

describe("diffDays（纯日期算术）", () => {
  it("同月 / 跨月 / 跨年", () => {
    expect(diffDays("2026-08-29", "2026-09-01")).toBe(3);
    expect(diffDays("2025-12-31", "2026-01-01")).toBe(1);
    expect(diffDays("2026-07-30", "2026-08-29")).toBe(30);
  });
});

describe("comparisonModeForPreset（D1：preset -> comparison_mode）", () => {
  it("过去7/30/90 天与自定义 -> equal_length", () => {
    expect(comparisonModeForPreset("7d")).toBe("equal_length");
    expect(comparisonModeForPreset("30d")).toBe("equal_length");
    expect(comparisonModeForPreset("90d")).toBe("equal_length");
    expect(comparisonModeForPreset("custom")).toBe("equal_length");
  });
  it("本月 -> previous_month_elapsed（上一自然月同 elapsed 跨度）", () => {
    expect(comparisonModeForPreset("month")).toBe("previous_month_elapsed");
  });
  it("上月 -> previous_calendar_month（上一完整自然月）", () => {
    expect(comparisonModeForPreset("lastMonth")).toBe("previous_calendar_month");
  });
});
