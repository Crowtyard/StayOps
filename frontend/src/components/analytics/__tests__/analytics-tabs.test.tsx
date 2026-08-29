/**
 * Analytics 各 Tab 渲染测试（Sprint 8 §62/§51）：
 * - Overview：KPI 值与变化、快照、On-books、经营区块
 * - Rooms & Bookings：趋势图 / 分布 / 在册预测 / 合同房费趋势
 * - Operations：保洁 / 维修 / 换房事实表（无 AI 建议）
 * - Inventory & Procurement：每物资每单位独立行（不跨单位汇总）
 */

import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import OverviewTab from "@/components/analytics/overview-tab";
import RoomsBookingsTab from "@/components/analytics/rooms-bookings-tab";
import OperationsTab from "@/components/analytics/operations-tab";
import InventoryProcurementTab from "@/components/analytics/inventory-procurement-tab";
import type {
  BookingsOut,
  BusinessInventoryOut,
  BusinessProcurementOut,
  BusinessRoomsOut,
  ForecastOut,
  HousekeepingOut,
  MaintenanceOut,
  OperationsOverviewOut,
  RoomMovesOut,
} from "@/lib/api/types";

const overviewMetrics: OperationsOverviewOut["metrics"] = {
  actual_occupied_room_nights: 13,
  physical_room_nights: 840,
  physical_occupancy_rate: 0.0155,
  completed_stays: 3,
  average_length_of_stay: 2.3,
  scheduled_arrivals: 7,
  cancelled_arrivals: 1,
  cancellation_rate: 0.1429,
  no_show_count: 1,
  no_show_rate: 0.1667,
  average_booking_lead_days: 2.8,
  room_move_count: 1,
  moved_stay_count: 1,
  room_move_rate: 0.2,
  housekeeping_completed_tasks: 3,
};

const overview: OperationsOverviewOut = {
  business_date: "2026-08-29",
  period: { from: "2026-07-30", to: "2026-08-29", days: 30 },
  metrics: overviewMetrics,
  snapshot: {
    active_stays: 2,
    overdue_active_stays: 1,
    housekeeping_backlog: 1,
    active_maintenance: 2,
    active_blocking_maintenance: 1,
  },
  on_books: {
    "7d": { days: 7, physical_room_nights: 196, on_books_room_nights: 6, occupancy_rate: 0.0306 },
    "14d": { days: 14, physical_room_nights: 392, on_books_room_nights: 7, occupancy_rate: 0.0179 },
    "30d": { days: 30, physical_room_nights: 840, on_books_room_nights: 7, occupancy_rate: 0.0083 },
  },
  comparison: {
    period: { from: "2026-06-30", to: "2026-07-30", days: 30 },
    metrics: overviewMetrics,
    changes: {
      physical_occupancy_rate: { pp_delta: 0.005 },
      actual_occupied_room_nights: { percent_change: 0.5 },
      cancellation_rate: { pp_delta: 0.05 },
    },
  },
};

const rooms: BusinessRoomsOut = {
  business_date: "2026-08-29",
  period: { from: "2026-07-30", to: "2026-08-29", days: 30 },
  contracted_room_value: "3550.00",
  priced_occupied_room_nights: 12,
  unpriced_occupied_room_nights: 1,
  contracted_adr: "295.8333",
  contracted_revpar: "21.1310",
  physical_room_nights: 840,
  daily: [
    { business_date: "2026-08-28", contracted_room_value: "3550.00", priced_occupied_room_nights: 12 },
  ],
};

const inventory: BusinessInventoryOut = {
  business_date: "2026-08-29",
  period: { from: "2026-07-30", to: "2026-08-29", days: 30 },
  current_low_stock_items: 1,
  current_out_of_stock_items: 1,
  occupied_room_nights: 13,
  items: [
    {
      item_id: 1,
      item_code: "GOLD-WATER",
      name: "矿泉水",
      category: "GUEST_AMENITY",
      base_unit: "瓶",
      stock_status: "NORMAL",
      total_stock: "137",
      is_active: true,
      issue_quantity: "15",
      issue_quantity_per_occupied_room_night: 1.1538,
    },
    {
      item_id: 2,
      item_code: "GOLD-SLIPPER",
      name: "拖鞋",
      category: "GUEST_AMENITY",
      base_unit: "双",
      stock_status: "LOW_STOCK",
      total_stock: "2",
      is_active: true,
      issue_quantity: "3",
      issue_quantity_per_occupied_room_night: 0.2308,
    },
  ],
};

const procurement: BusinessProcurementOut = {
  business_date: "2026-08-29",
  period: { from: "2026-07-30", to: "2026-08-29", days: 30 },
  purchase_requests_created: 2,
  pending_purchase_requests: 1,
  purchase_orders_created: 2,
  pending_receipt_orders: 1,
  partially_received_orders: 1,
  received_purchase_value: "210.00",
  unpriced_received_lines: 1,
  received_value_by_supplier: [
    { supplier_id: 1, supplier_code: "SUP-GOLD", supplier_name: "泉城黄金供应商", received_value: "210.00" },
  ],
  received_value_by_item: [
    { item_id: 1, item_code: "GOLD-WATER", item_name: "矿泉水", base_unit: "瓶", received_value: "150.00" },
    { item_id: 4, item_code: "GOLD-PAPER", item_name: "卷纸", base_unit: "包", received_value: "60.00" },
  ],
  daily: [
    { business_date: "2026-08-28", received_purchase_value: "120.00" },
    { business_date: "2026-08-29", received_purchase_value: "90.00" },
  ],
};

const bookings: BookingsOut = {
  business_date: "2026-08-29",
  period: { from: "2026-07-30", to: "2026-08-29", days: 30 },
  scheduled_arrivals: 7,
  cancelled_arrivals: 1,
  cancellation_rate: 0.1429,
  no_show_count: 1,
  no_show_rate: 0.1667,
  average_booking_lead_days: 2.8,
  booking_lead_distribution: [
    { bucket: "0-1", count: 1 },
    { bucket: "2-3", count: 3 },
    { bucket: "4-7", count: 2 },
    { bucket: "8-14", count: 0 },
    { bucket: "15-30", count: 0 },
    { bucket: "31+", count: 0 },
  ],
  completed_stays: 3,
  average_length_of_stay: 2.3,
  room_move_count: 1,
  moved_stay_count: 1,
  room_move_rate: 0.2,
  daily: [
    { business_date: "2026-08-28", occupied_room_nights: 13, physical_room_nights: 28, occupancy_rate: 0.4643 },
  ],
};

const forecast: ForecastOut = {
  business_date: "2026-08-29",
  physical_room_count: 28,
  horizons: {
    "7d": { days: 7, physical_room_nights: 196, on_books_room_nights: 6, occupancy_rate: 0.0306 },
    "14d": { days: 14, physical_room_nights: 392, on_books_room_nights: 7, occupancy_rate: 0.0179 },
    "30d": { days: 30, physical_room_nights: 840, on_books_room_nights: 7, occupancy_rate: 0.0083 },
  },
  daily: [
    { business_date: "2026-08-29", on_books_room_nights: 1, physical_room_nights: 28, occupancy_rate: 0.0357 },
    { business_date: "2026-08-30", on_books_room_nights: 2, physical_room_nights: 28, occupancy_rate: 0.0714 },
  ],
};

const housekeeping: HousekeepingOut = {
  business_date: "2026-08-29",
  period: { from: "2026-07-30", to: "2026-08-29", days: 30 },
  housekeeping_completed_tasks: 3,
  average_housekeeping_cycle_minutes: 110,
  checkout_turnover_minutes: 120,
  room_move_cleaning_tasks: 1,
  housekeeping_backlog: 1,
  daily: [
    { business_date: "2026-08-28", completed_tasks: 3 },
  ],
};

const maintenance: MaintenanceOut = {
  business_date: "2026-08-29",
  period: { from: "2026-07-30", to: "2026-08-29", days: 30 },
  maintenance_created: 4,
  maintenance_completed: 2,
  active_maintenance: 2,
  active_blocking_maintenance: 1,
  mean_time_to_resolution_minutes: 750,
  mean_verification_minutes: 60,
  maintenance_by_category: [
    { category: "HVAC", count: 1 },
    { category: "PLUMBING", count: 1 },
  ],
  maintenance_by_room: [{ room_id: 3, room_number: "101", count: 1 }],
};

const roomMoves: RoomMovesOut = {
  business_date: "2026-08-29",
  period: { from: "2026-07-30", to: "2026-08-29", days: 30 },
  room_move_count: 1,
  moved_stay_count: 1,
  room_move_rate: 0.2,
  room_moves_by_reason: [{ reason: "GUEST_REQUEST", count: 1 }],
  room_moves_by_source_room: [{ room_id: 13, room_number: "102", count: 1 }],
};

describe("OverviewTab", () => {
  it("运营 KPI + 对比变化（pp / percent）+ 快照 + On-books", () => {
    render(
      <OverviewTab overview={overview} rooms={rooms} inventory={inventory} procurement={procurement} />,
    );
    // 比率 0.0155 -> 1.6%；实际房晚 13
    expect(screen.getByText("1.6%")).toBeTruthy();
    expect(screen.getByText("13")).toBeTruthy();
    // pp 变化：+0.5 pp（物理入住率）
    expect(screen.getByText("+0.5 pp")).toBeTruthy();
    // percent 变化：+50.0%（实际房晚）
    expect(screen.getByText("+50.0%")).toBeTruthy();
    // 快照
    expect(screen.getByText("超期在住")).toBeTruthy();
    expect(screen.getByText("阻断性维修")).toBeTruthy();
    // On-books 30 天
    expect(screen.getByText("未来 30 天")).toBeTruthy();
    expect(screen.getByText("6 / 196 房晚")).toBeTruthy();
    // business 区块：合同房费金额 / 无价房晚（警示文案在 hint，值 1）
    expect(screen.getByText("合同房费金额")).toBeTruthy();
    expect(screen.getByText("¥3,550.00")).toBeTruthy();
    expect(screen.getByText("合同 ADR")).toBeTruthy();
    expect(screen.getByText("¥295.83")).toBeTruthy();
  });

  it("无 business 权限（null）→ 不渲染经营区块", () => {
    render(<OverviewTab overview={overview} rooms={null} inventory={null} procurement={null} />);
    expect(screen.queryByText("合同房费金额")).toBeNull();
    expect(screen.queryByText("库存与采购预警")).toBeNull();
    expect(screen.getByText("物理入住率")).toBeTruthy();
  });
});

describe("RoomsBookingsTab", () => {
  it("趋势 / 分布 / 在册预测 / 合同房费趋势", () => {
    render(<RoomsBookingsTab bookings={bookings} forecast={forecast} rooms={rooms} />);
    expect(screen.getByText("物理入住率趋势")).toBeTruthy();
    expect(screen.getByText("实际占用房晚趋势")).toBeTruthy();
    expect(screen.getByText("在册预测（未来 30 天）")).toBeTruthy();
    expect(screen.getByText("预订提前天数分布")).toBeTruthy();
    expect(screen.getByText("合同房费趋势")).toBeTruthy();
    expect(screen.getByText("取消率")).toBeTruthy();
    expect(screen.getByText("14.3%")).toBeTruthy();
  });

  it("无 business 权限（rooms=null）→ 不渲染合同房费趋势", () => {
    render(<RoomsBookingsTab bookings={bookings} forecast={forecast} rooms={null} />);
    expect(screen.queryByText("合同房费趋势")).toBeNull();
    expect(screen.getByText("物理入住率趋势")).toBeTruthy();
  });
});

describe("OperationsTab", () => {
  it("保洁 / 维修 / 换房事实（无 AI 建议、无“问题房”定性）", () => {
    render(
      <OperationsTab housekeeping={housekeeping} maintenance={maintenance} roomMoves={roomMoves} />,
    );
    expect(screen.getByText("完成保洁任务")).toBeTruthy();
    expect(screen.getByText("110.0 分钟")).toBeTruthy();
    expect(screen.getByText("退房翻房时长")).toBeTruthy();
    expect(screen.getByText("平均解决时长")).toBeTruthy();
    expect(screen.getByText("750.0 分钟")).toBeTruthy();
    expect(screen.getByText("高频报修房间（新建）")).toBeTruthy();
    // 只展示事实：无“问题房”“应停售”“AI”
    expect(screen.queryByText(/问题房|应停售|AI 推荐/)).toBeNull();
    expect(screen.getByText("换房原因分布")).toBeTruthy();
    // 来源房表
    expect(screen.getByText("换出房分布（来源房）")).toBeTruthy();
    expect(screen.getByText("102")).toBeTruthy();
  });
});

describe("InventoryProcurementTab", () => {
  it("每物资每单位独立展示（不跨单位汇总，§26/§62）", () => {
    render(<InventoryProcurementTab inventory={inventory} procurement={procurement} />);
    // 两种计量单位各自成行
    const rows = screen.getAllByRole("row");
    const waterRow = rows.find((r) => within(r).queryByText("GOLD-WATER"));
    expect(waterRow).toBeTruthy();
    expect(within(waterRow!).getByText("瓶")).toBeTruthy();
    expect(within(waterRow!).getByText("15")).toBeTruthy();
    const slipperRow = rows.find((r) => within(r).queryByText("GOLD-SLIPPER"));
    expect(within(slipperRow!).getByText("双")).toBeTruthy();
    expect(within(slipperRow!).getByText("3")).toBeTruthy();
    // 页面不存在跨单位汇总（无“总领用量”之类的合计行）
    expect(screen.queryByText(/总领用|合计领用/)).toBeNull();
    // 采购：到货金额（KPI + 供应商表两处）+ 无价行提示
    expect(screen.getByText("到货采购金额")).toBeTruthy();
    expect(screen.getAllByText("¥210.00").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole("alert")).toBeTruthy(); // 无价收货提示
    // 供应商/物资表
    expect(screen.getByText("泉城黄金供应商")).toBeTruthy();
    expect(screen.getByText("¥150.00")).toBeTruthy();
  });
});
