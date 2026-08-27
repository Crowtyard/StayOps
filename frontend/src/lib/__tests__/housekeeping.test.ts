/**
 * Housekeeping 展示元数据（Sprint 3）：
 * 状态/优先级/来源标签、进行中状态集合、任务状态 ↔ 房间清洁状态映射。
 */

import { describe, expect, it } from "vitest";
import {
  HK_ACTIVE_STATUSES,
  HK_SOURCE_LABELS,
  HK_TASK_STATUS_META,
  HK_TASK_TO_CLEANING,
  HK_PRIORITY_META,
} from "@/lib/housekeeping";

describe("lib/housekeeping 展示元数据", () => {
  it("任务状态标签完整（6 个产品固定状态）", () => {
    expect(HK_TASK_STATUS_META.PENDING.label).toBe("待清扫");
    expect(HK_TASK_STATUS_META.IN_PROGRESS.label).toBe("清扫中");
    expect(HK_TASK_STATUS_META.INSPECTION.label).toBe("待验房");
    expect(HK_TASK_STATUS_META.REWORK.label).toBe("返工");
    expect(HK_TASK_STATUS_META.COMPLETED.label).toBe("已完成");
    expect(HK_TASK_STATUS_META.CANCELLED.label).toBe("已取消");
  });

  it("优先级与来源标签", () => {
    expect(HK_PRIORITY_META.NORMAL.label).toBe("普通");
    expect(HK_PRIORITY_META.URGENT.label).toBe("加急");
    expect(HK_SOURCE_LABELS.CHECKOUT).toBe("退房自动");
    expect(HK_SOURCE_LABELS.MANUAL).toBe("手动创建");
  });

  it("进行中状态集合 = PENDING/IN_PROGRESS/INSPECTION/REWORK", () => {
    expect(HK_ACTIVE_STATUSES).toEqual([
      "PENDING",
      "IN_PROGRESS",
      "INSPECTION",
      "REWORK",
    ]);
  });

  it("任务状态 ↔ 房间清洁状态联动映射（与后端一致）", () => {
    expect(HK_TASK_TO_CLEANING.PENDING).toBe("dirty");
    expect(HK_TASK_TO_CLEANING.IN_PROGRESS).toBe("cleaning");
    expect(HK_TASK_TO_CLEANING.INSPECTION).toBe("inspection");
    expect(HK_TASK_TO_CLEANING.REWORK).toBe("rework");
    expect(HK_TASK_TO_CLEANING.COMPLETED).toBe("clean");
    expect(HK_TASK_TO_CLEANING.CANCELLED).toBe("dirty");
  });
});
