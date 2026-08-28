/**
 * FrontDeskTodayBoard（<768px 移动端）测试：
 * - 结构：Today Summary / Search / Attention / Today's Arrivals / Departures / Stays
 * - 不渲染完整 Room Diary（组件本身不含 Diary）
 * - PII / 权限门控与桌面端一致；Attention 三步（哪间房/什么问题/去哪处理）
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import FrontDeskTodayBoard from "@/components/front-desk/front-desk-today-board";
import { addDays, businessDate } from "@/lib/booking";
import {
  computeAttention,
  computeTodaySummary,
} from "@/lib/front-desk";
import type {
  ReservationOut,
  RoomOut,
  StayOut,
} from "@/lib/api/types";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/lib/api", () => ({
  api: {
    reservations: { list: vi.fn() },
  },
  ApiError: class {},
}));

const TODAY = businessDate();
const PERMISSIONS = new Set([
  "room:read",
  "reservation:read",
  "guest:read",
  "stay:read",
]);

function makeRoom(roomNumber: string, dirty = false): RoomOut {
  return {
    id: Number(roomNumber),
    room_number: roomNumber,
    room_type_id: 3,
    floor: 1,
    occupancy_status: "available",
    cleaning_status: dirty ? "dirty" : "clean",
    notes: null,
    created_at: "x",
    updated_at: "x",
    room_type: { id: 3, name: "豪华大床房" },
  };
}

function makeReservation(
  checkIn: string,
  overrides: Partial<ReservationOut> = {},
): ReservationOut {
  return {
    id: 1,
    reservation_no: "RSV-MB-0001",
    guest_id: 7,
    guest_name: "移动端客人",
    room_id: 201,
    room_number: "201",
    room_type_id: 3,
    check_in_date: checkIn,
    check_out_date: addDays(checkIn, 2),
    status: "CONFIRMED",
    source: "WECHAT",
    agreed_total_amount: "428.00",
    currency: "CNY",
    ...overrides,
  };
}

function makeStay(plannedOut: string): StayOut {
  return {
    id: 31,
    stay_no: "STY-MB-0031",
    reservation_id: 21,
    room_id: 202,
    room_number: "202",
    status: "ACTIVE",
    actual_check_in_at: "x",
    planned_check_out_date: plannedOut,
    guest_name: "在住客人",
  };
}

function renderBoard(opts: { canReadGuest?: boolean } = {}) {
  const rooms = [makeRoom("201", true), makeRoom("202"), makeRoom("203")];
  const reservations = [makeReservation(TODAY, { room_id: 201 })];
  const stays = [makeStay(addDays(TODAY, -1))]; // 超期（Rule B）
  const attention = computeAttention(reservations, stays, rooms, TODAY);
  const summary = computeTodaySummary(rooms, reservations, stays, TODAY);
  const onOpenReservation = vi.fn();
  const onOpenRoom = vi.fn();
  const onSelectSummary = vi.fn();
  render(
    <FrontDeskTodayBoard
      rooms={rooms}
      reservations={reservations}
      stays={stays}
      attention={attention}
      summary={summary}
      permissions={PERMISSIONS}
      today={TODAY}
      canReadGuest={opts.canReadGuest ?? true}
      onOpenReservation={onOpenReservation}
      onOpenRoom={onOpenRoom}
      onSelectSummary={onSelectSummary}
    />,
  );
  return { onOpenReservation, onOpenRoom, onSelectSummary };
}

describe("FrontDeskTodayBoard（移动端）", () => {
  it("结构完整：概况卡片 + 搜索 + 需关注 + 今日到店/离店 + 当前在住", () => {
    renderBoard();
    expect(
      document.querySelector('[data-summary-card="arrivals"]'),
    ).not.toBeNull();
    expect(
      screen.getByLabelText("搜索房号、客人、预订单号"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "需关注" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "今日到店" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "今日离店" }),
    ).toBeInTheDocument();
    expect(screen.getByText("当前在住（1）")).toBeInTheDocument();
    // 不渲染完整 Room Diary
    expect(document.querySelector("[data-room-cell]")).toBeNull();
    expect(document.querySelector("[data-room-track]")).toBeNull();
  });

  it("今日到店列表点击 → onOpenReservation", () => {
    const { onOpenReservation } = renderBoard();
    fireEvent.click(screen.getByText("移动端客人"));
    expect(onOpenReservation).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1 }),
    );
  });

  it("需关注（Rule A 脏房到店 + Rule B 超期）展示问题与下一步", () => {
    renderBoard();
    expect(screen.getByText(/尚未准备完成/)).toBeInTheDocument();
    expect(screen.getByText(/已超过计划退房日/)).toBeInTheDocument();
    expect(screen.getByText("查看预订")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看在住" })).toHaveAttribute(
      "href",
      "/stays/31",
    );
  });

  it("今日离店 / 在住条目链接到 Stay 详情（Check-out 落点）", () => {
    renderBoard();
    const links = screen.getAllByRole("link", {
      name: /STY-MB-0031/,
    });
    expect(links.length).toBeGreaterThanOrEqual(1);
    expect(links[0]).toHaveAttribute("href", "/stays/31");
  });

  it("PII：无 guest:read 时到店列表显示预订号而非姓名", () => {
    renderBoard({ canReadGuest: false });
    expect(screen.getByText("RSV-MB-0001")).toBeInTheDocument();
    expect(screen.queryByText("移动端客人")).toBeNull();
  });

  it("Attention 查看预订 → 回调携带对应预订", () => {
    const { onOpenReservation } = renderBoard();
    fireEvent.click(screen.getByText("查看预订"));
    expect(onOpenReservation).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1 }),
    );
  });

  it("概况卡片点击 → onSelectSummary", () => {
    const { onSelectSummary } = renderBoard();
    fireEvent.click(
      document.querySelector('[data-summary-card="attention"]') as HTMLElement,
    );
    expect(onSelectSummary).toHaveBeenCalledWith("attention");
  });
});
