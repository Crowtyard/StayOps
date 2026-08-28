/**
 * Maintenance 展示层元数据（Sprint 5）：
 * - 状态 / 分类 / 严重度 / 来源标签完整
 * - isActiveBlocking：RESOLVED 仍阻断（维修完成 ≠ 酒店验收通过）
 */

import { describe, expect, it } from "vitest";
import {
  isActiveBlocking,
  MWO_BLOCKING_STATUSES,
  MWO_CATEGORY_LABELS,
  MWO_SEVERITY_META,
  MWO_SOURCE_LABELS,
  MWO_STATUS_META,
} from "@/lib/maintenance";

describe("maintenance 展示元数据", () => {
  it("状态标签覆盖全部 6 个状态", () => {
    expect(Object.keys(MWO_STATUS_META).sort()).toEqual(
      [
        "OPEN",
        "ASSIGNED",
        "IN_PROGRESS",
        "RESOLVED",
        "COMPLETED",
        "CANCELLED",
      ].sort(),
    );
    expect(MWO_STATUS_META.OPEN.label).toBe("待处理");
    expect(MWO_STATUS_META.RESOLVED.label).toBe("待验收");
  });

  it("分类覆盖第一版固定 10 类", () => {
    expect(Object.keys(MWO_CATEGORY_LABELS).sort()).toEqual(
      [
        "ELECTRICAL",
        "PLUMBING",
        "HVAC",
        "LOCK",
        "BATHROOM",
        "FURNITURE",
        "APPLIANCE",
        "NETWORK",
        "FINISHING",
        "OTHER",
      ].sort(),
    );
  });

  it("严重度 4 档 + 来源 4 类（含 PRE_OPENING）", () => {
    expect(Object.keys(MWO_SEVERITY_META).sort()).toEqual(
      ["LOW", "MEDIUM", "HIGH", "CRITICAL"].sort(),
    );
    expect(MWO_SEVERITY_META.CRITICAL.label).toBe("紧急");
    expect(Object.keys(MWO_SOURCE_LABELS).sort()).toEqual(
      ["MANUAL", "FRONT_DESK", "HOUSEKEEPING", "PRE_OPENING"].sort(),
    );
    expect(MWO_SOURCE_LABELS.PRE_OPENING).toBe("开业检查");
  });

  it("isActiveBlocking：blocks_room=true 且非终态才阻断；RESOLVED 仍阻断", () => {
    expect(isActiveBlocking("OPEN", true)).toBe(true);
    expect(isActiveBlocking("ASSIGNED", true)).toBe(true);
    expect(isActiveBlocking("IN_PROGRESS", true)).toBe(true);
    expect(isActiveBlocking("RESOLVED", true)).toBe(true);
    expect(isActiveBlocking("COMPLETED", true)).toBe(false);
    expect(isActiveBlocking("CANCELLED", true)).toBe(false);
    // blocks_room=false 任何状态都不阻断
    expect(isActiveBlocking("OPEN", false)).toBe(false);
    expect(isActiveBlocking("RESOLVED", false)).toBe(false);
  });

  it("BLOCKING_STATUSES 与后端 BLOCKING 语义一致", () => {
    expect(MWO_BLOCKING_STATUSES).toEqual([
      "OPEN",
      "ASSIGNED",
      "IN_PROGRESS",
      "RESOLVED",
    ]);
  });
});
