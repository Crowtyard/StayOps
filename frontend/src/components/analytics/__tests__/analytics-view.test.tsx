/**
 * AnalyticsView 测试（Sprint 8 §62/§59）：
 * - permission-based fetching：无权限域不请求（operations/business 分离）
 * - permission-based tabs / Forbidden
 * - 零数据渲染：0 / "—" / 暂无数据，无 NaN / Infinity
 * - 日期预设与自定义校验的交互
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MeOut } from "@/lib/api/types";
import AnalyticsView from "@/components/analytics/analytics-view";
import { UserContext } from "@/components/app-shell";

const {
  operationsOverviewMock,
  operationsBookingsMock,
  operationsHousekeepingMock,
  operationsMaintenanceMock,
  operationsRoomMovesMock,
  businessRoomsMock,
  businessInventoryMock,
  businessProcurementMock,
  forecastMock,
} = vi.hoisted(() => ({
  operationsOverviewMock: vi.fn(),
  operationsBookingsMock: vi.fn(),
  operationsHousekeepingMock: vi.fn(),
  operationsMaintenanceMock: vi.fn(),
  operationsRoomMovesMock: vi.fn(),
  businessRoomsMock: vi.fn(),
  businessInventoryMock: vi.fn(),
  businessProcurementMock: vi.fn(),
  forecastMock: vi.fn(),
}));

const routerMock = vi.hoisted(() => ({
  replace: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      analytics: {
        operationsOverview: operationsOverviewMock,
        operationsBookings: operationsBookingsMock,
        operationsHousekeeping: operationsHousekeepingMock,
        operationsMaintenance: operationsMaintenanceMock,
        operationsRoomMoves: operationsRoomMovesMock,
        businessRooms: businessRoomsMock,
        businessInventory: businessInventoryMock,
        businessProcurement: businessProcurementMock,
        forecast: forecastMock,
      },
    },
  };
});

function makeUser(permissions: string[]): MeOut {
  return {
    id: 1,
    username: "tester",
    display_name: null,
    email: null,
    phone: null,
    is_active: true,
    created_at: "x",
    updated_at: "x",
    roles: [{ id: 2, name: "MANAGER" }],
    permissions,
  };
}

function renderWithUser(permissions: string[]) {
  return render(
    <UserContext.Provider value={makeUser(permissions)}>
      <AnalyticsView />
    </UserContext.Provider>,
  );
}

const zeroOverview = {
  business_date: "2026-08-29",
  period: { from: "2026-07-30", to: "2026-08-29", days: 30 },
  metrics: {
    actual_occupied_room_nights: 0,
    physical_room_nights: 840,
    physical_occupancy_rate: 0,
    completed_stays: 0,
    average_length_of_stay: null,
    scheduled_arrivals: 0,
    cancelled_arrivals: 0,
    cancellation_rate: null,
    no_show_count: 0,
    no_show_rate: null,
    average_booking_lead_days: null,
    room_move_count: 0,
    moved_stay_count: 0,
    room_move_rate: null,
    housekeeping_completed_tasks: 0,
  },
  snapshot: {
    active_stays: 0,
    overdue_active_stays: 0,
    housekeeping_backlog: 0,
    active_maintenance: 0,
    active_blocking_maintenance: 0,
  },
  on_books: {
    "7d": { days: 7, physical_room_nights: 196, on_books_room_nights: 0, occupancy_rate: 0 },
    "14d": { days: 14, physical_room_nights: 392, on_books_room_nights: 0, occupancy_rate: 0 },
    "30d": { days: 30, physical_room_nights: 840, on_books_room_nights: 0, occupancy_rate: 0 },
  },
  comparison: null,
};

const zeroInventory = {
  business_date: "2026-08-29",
  period: { from: "2026-07-30", to: "2026-08-29", days: 30 },
  current_low_stock_items: 0,
  current_out_of_stock_items: 0,
  occupied_room_nights: 0,
  items: [],
};

const zeroProcurement = {
  business_date: "2026-08-29",
  period: { from: "2026-07-30", to: "2026-08-29", days: 30 },
  purchase_requests_created: 0,
  pending_purchase_requests: 0,
  purchase_orders_created: 0,
  pending_receipt_orders: 0,
  partially_received_orders: 0,
  received_purchase_value: "0.00",
  unpriced_received_lines: 0,
  received_value_by_supplier: [],
  received_value_by_item: [],
  daily: [],
};

const zeroRooms = {
  business_date: "2026-08-29",
  period: { from: "2026-07-30", to: "2026-08-29", days: 30 },
  contracted_room_value: "0.00",
  priced_occupied_room_nights: 0,
  unpriced_occupied_room_nights: 0,
  contracted_adr: null,
  contracted_revpar: "0.0000",
  physical_room_nights: 840,
  daily: [],
};

beforeEach(() => {
  operationsOverviewMock.mockReset();
  operationsBookingsMock.mockReset();
  operationsHousekeepingMock.mockReset();
  operationsMaintenanceMock.mockReset();
  operationsRoomMovesMock.mockReset();
  businessRoomsMock.mockReset();
  businessInventoryMock.mockReset();
  businessProcurementMock.mockReset();
  forecastMock.mockReset();
  operationsOverviewMock.mockResolvedValue(zeroOverview);
  businessInventoryMock.mockResolvedValue(zeroInventory);
  businessProcurementMock.mockResolvedValue(zeroProcurement);
  businessRoomsMock.mockResolvedValue(zeroRooms);
  forecastMock.mockResolvedValue({
    business_date: "2026-08-29",
    physical_room_count: 28,
    horizons: {
      "7d": { days: 7, physical_room_nights: 196, on_books_room_nights: 0, occupancy_rate: 0 },
      "14d": { days: 14, physical_room_nights: 392, on_books_room_nights: 0, occupancy_rate: 0 },
      "30d": { days: 30, physical_room_nights: 840, on_books_room_nights: 0, occupancy_rate: 0 },
    },
    daily: [],
  });
  operationsBookingsMock.mockResolvedValue({
    business_date: "2026-08-29",
    period: { from: "2026-07-30", to: "2026-08-29", days: 30 },
    scheduled_arrivals: 0,
    cancelled_arrivals: 0,
    cancellation_rate: null,
    no_show_count: 0,
    no_show_rate: null,
    average_booking_lead_days: null,
    booking_lead_distribution: [
      { bucket: "0-1", count: 0 },
      { bucket: "2-3", count: 0 },
      { bucket: "4-7", count: 0 },
      { bucket: "8-14", count: 0 },
      { bucket: "15-30", count: 0 },
      { bucket: "31+", count: 0 },
    ],
    completed_stays: 0,
    average_length_of_stay: null,
    room_move_count: 0,
    moved_stay_count: 0,
    room_move_rate: null,
    daily: [],
  });
  operationsHousekeepingMock.mockResolvedValue({
    business_date: "2026-08-29",
    period: { from: "2026-07-30", to: "2026-08-29", days: 30 },
    housekeeping_completed_tasks: 0,
    average_housekeeping_cycle_minutes: null,
    checkout_turnover_minutes: null,
    room_move_cleaning_tasks: 0,
    housekeeping_backlog: 0,
    daily: [],
  });
  operationsMaintenanceMock.mockResolvedValue({
    business_date: "2026-08-29",
    period: { from: "2026-07-30", to: "2026-08-29", days: 30 },
    maintenance_created: 0,
    maintenance_completed: 0,
    active_maintenance: 0,
    active_blocking_maintenance: 0,
    mean_time_to_resolution_minutes: null,
    mean_verification_minutes: null,
    maintenance_by_category: [],
    maintenance_by_room: [],
  });
  operationsRoomMovesMock.mockResolvedValue({
    business_date: "2026-08-29",
    period: { from: "2026-07-30", to: "2026-08-29", days: 30 },
    room_move_count: 0,
    moved_stay_count: 0,
    room_move_rate: null,
    room_moves_by_reason: [],
    room_moves_by_source_room: [],
  });
});

describe("permission-based fetching（§35/§59：无权限域不请求）", () => {
  it("无任何 analytics 权限 -> Forbidden，零请求", async () => {
    renderWithUser(["room:read"]);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    expect(screen.getByText(/无权限访问经营分析/)).toBeTruthy();
    expect(operationsOverviewMock).not.toHaveBeenCalled();
    expect(businessRoomsMock).not.toHaveBeenCalled();
  });

  it("仅 operations：只请求 operations API，不请求 business API", async () => {
    renderWithUser(["analytics:operations_read"]);
    await waitFor(() => {
      expect(operationsOverviewMock).toHaveBeenCalled();
    });
    expect(businessRoomsMock).not.toHaveBeenCalled();
    expect(businessInventoryMock).not.toHaveBeenCalled();
    expect(businessProcurementMock).not.toHaveBeenCalled();
    // operations 域指标可见
    await waitFor(() => {
      expect(screen.getByText("物理入住率")).toBeTruthy();
    });
    // 无 business 权限：经营区块不渲染、不请求
    expect(screen.queryByText("合同房费金额")).toBeNull();
    // 库存与采购 Tab 隐藏（business only）
    expect(screen.queryByRole("tab", { name: "库存与采购" })).toBeNull();
  });

  it("仅 business：只请求 business API，不请求 operations API", async () => {
    renderWithUser(["analytics:business_read"]);
    await waitFor(() => {
      expect(businessRoomsMock).toHaveBeenCalled();
      expect(businessInventoryMock).toHaveBeenCalled();
      expect(businessProcurementMock).toHaveBeenCalled();
    });
    expect(operationsOverviewMock).not.toHaveBeenCalled();
    // business 指标可见
    await waitFor(() => {
      expect(screen.getByText("合同房费金额")).toBeTruthy();
    });
    // 运营效率 Tab 隐藏（operations only）
    expect(screen.queryByRole("tab", { name: "运营效率" })).toBeNull();
    expect(screen.queryByText("物理入住率")).toBeNull();
  });

  it("operations + business：全部请求，全部 Tab 可见", async () => {
    renderWithUser(["analytics:operations_read", "analytics:business_read"]);
    await waitFor(() => {
      expect(operationsOverviewMock).toHaveBeenCalled();
      expect(businessRoomsMock).toHaveBeenCalled();
      expect(businessInventoryMock).toHaveBeenCalled();
      expect(businessProcurementMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.getByText("物理入住率")).toBeTruthy();
      expect(screen.getByText("合同房费金额")).toBeTruthy();
    });
    expect(screen.getByRole("tab", { name: "运营效率" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "库存与采购" })).toBeTruthy();
  });

  it("切到运营效率 Tab：只请求 operations 三个端点（business 不请求）", async () => {
    const user = userEvent.setup();
    renderWithUser(["analytics:operations_read", "analytics:business_read"]);
    await waitFor(() => {
      expect(operationsOverviewMock).toHaveBeenCalled();
    });
    // 记录总览加载后 business 调用次数（StrictMode 下 effect 可能双跑）
    const invCalls = businessInventoryMock.mock.calls.length;
    const prcCalls = businessProcurementMock.mock.calls.length;
    await user.click(screen.getByRole("tab", { name: "运营效率" }));
    await waitFor(() => {
      expect(operationsHousekeepingMock).toHaveBeenCalled();
      expect(operationsMaintenanceMock).toHaveBeenCalled();
      expect(operationsRoomMovesMock).toHaveBeenCalled();
    });
    // 运营 Tab 本身不触发 business API（调用次数不增加）
    expect(businessInventoryMock.mock.calls.length).toBe(invCalls);
    expect(businessProcurementMock.mock.calls.length).toBe(prcCalls);
  });
});

describe("零数据渲染（§57/§62：无 NaN / Infinity / fake data）", () => {
  it("全零 overview：0 / — / 暂无数据 正常展示", async () => {
    renderWithUser(["analytics:operations_read", "analytics:business_read"]);
    await waitFor(() => {
      expect(screen.getByText("物理入住率")).toBeTruthy();
    });
    const overview = within(screen.getByText("运营概览").closest("section")!);
    // 0 显示 0.0%（分母非 0）
    expect(overview.getAllByText("0.0%").length).toBeGreaterThan(0);
    // null 显示 —（平均住宿时长等）
    expect(overview.getAllByText("—").length).toBeGreaterThan(0);
    // 页面文本无 NaN / Infinity
    expect(document.body.textContent).not.toContain("NaN");
    expect(document.body.textContent).not.toContain("Infinity");
  });

  it("空库存/采购：暂无数据占位，不崩溃", async () => {
    const user = userEvent.setup();
    renderWithUser(["analytics:business_read"]);
    await waitFor(() => {
      expect(screen.getByText("库存与采购预警")).toBeTruthy();
    });
    await user.click(screen.getByRole("tab", { name: "库存与采购" }));
    await waitFor(() => {
      expect(screen.getByText("暂无库存物资")).toBeTruthy();
    });
    expect(document.body.textContent).not.toContain("NaN");
  });
});

describe("日期交互（§43/§62）", () => {
  it("默认过去 30 天；自定义非法区间显示错误且不请求", async () => {
    const user = userEvent.setup();
    renderWithUser(["analytics:operations_read"]);
    await waitFor(() => {
      expect(operationsOverviewMock).toHaveBeenCalled();
    });
    // 切到自定义
    await user.click(screen.getByRole("button", { name: "自定义" }));
    // 未填日期 -> 错误提示（选择器 + 主区域两处）
    await waitFor(() => {
      expect(screen.getAllByText("请选择开始与结束日期").length).toBeGreaterThan(0);
    });
    expect(operationsOverviewMock).toHaveBeenCalledTimes(1);
  });
});

describe("comparison_mode 按 preset 发送（D1）", () => {
  it("默认过去 30 天 -> equal_length", async () => {
    renderWithUser(["analytics:operations_read"]);
    await waitFor(() => {
      expect(operationsOverviewMock).toHaveBeenCalled();
    });
    const params = operationsOverviewMock.mock.calls[0][0] as {
      comparison_mode?: string;
    };
    expect(params.comparison_mode).toBe("equal_length");
  });

  it("本月 -> previous_month_elapsed；上月 -> previous_calendar_month", async () => {
    const user = userEvent.setup();
    renderWithUser(["analytics:operations_read"]);
    await waitFor(() => {
      expect(operationsOverviewMock).toHaveBeenCalled();
    });
    await user.click(screen.getByRole("button", { name: "本月" }));
    await waitFor(() => {
      expect(operationsOverviewMock).toHaveBeenCalled();
    });
    const monthParams = operationsOverviewMock.mock.calls.at(-1)?.[0] as {
      from?: string;
      to?: string;
      comparison_mode?: string;
    };
    expect(monthParams.comparison_mode).toBe("previous_month_elapsed");
    // 本月区间 = [月初, 业务日期)
    expect(monthParams.from).toBe(`${monthParams.to?.slice(0, 8)}01`);

    await user.click(screen.getByRole("button", { name: "上月" }));
    await waitFor(() => {
      expect(operationsOverviewMock).toHaveBeenCalled();
    });
    const lastMonthParams = operationsOverviewMock.mock.calls.at(-1)?.[0] as {
      comparison_mode?: string;
    };
    expect(lastMonthParams.comparison_mode).toBe("previous_calendar_month");
  });
});
