/**
 * ReservationDetailView 测试：
 * - 状态徽标与字段展示；403 Forbidden（不跳登录）
 * - 操作按钮按 status × 权限显隐（不复制状态机：仅按 status 值显隐）
 * - Check-in 409（dirty 房间等）展示后端 detail 原文
 * - CONFIRMED 编辑入口；CHECKED_IN 无编辑入口
 * - Cancel / No-show 成功刷新为真实后端状态
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "@/lib/api";
import type { MeOut, ReservationOut, RoomOut } from "@/lib/api/types";
import { addDays, businessDate } from "@/lib/booking";
import ReservationDetailView from "@/components/reservation-detail-view";
import { UserContext } from "@/components/app-shell";

const { replaceMock, routerMock, getMock, roomGetMock, cancelMock, noShowMock, checkInMock, updateMock } =
  vi.hoisted(() => {
    const replaceMock = vi.fn();
    return {
      replaceMock,
      routerMock: { replace: replaceMock, push: vi.fn(), refresh: vi.fn() },
      getMock: vi.fn(),
      roomGetMock: vi.fn(),
      cancelMock: vi.fn(),
      noShowMock: vi.fn(),
      checkInMock: vi.fn(),
      updateMock: vi.fn(),
    };
  });

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

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

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      reservations: {
        get: getMock,
        cancel: cancelMock,
        noShow: noShowMock,
        checkIn: checkInMock,
        update: updateMock,
      },
      rooms: { get: roomGetMock },
      roomTypes: { list: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, page_size: 100 }) },
      availability: { query: vi.fn().mockResolvedValue({ items: [], total: 0, available_count: 0, business_date: "", check_in_date: "", check_out_date: "" }) },
      guests: { get: vi.fn(), list: vi.fn(), create: vi.fn() },
    },
  };
});

const TODAY = businessDate();
const DAY_AFTER = addDays(TODAY, 1);

const ROOM: RoomOut = {
  id: 1,
  room_number: "203",
  room_type_id: 3,
  floor: 2,
  occupancy_status: "available",
  cleaning_status: "dirty",
  notes: null,
  created_at: "x",
  updated_at: "x",
  room_type: { id: 3, name: "豪华大床房" },
};

function makeReservation(status: ReservationOut["status"]): ReservationOut {
  return {
    id: 11,
    reservation_no: "RSV-TEST-0011",
    guest_id: 7,
    guest_name: "张先生",
    room_id: 1,
    room_number: "203",
    room_type_id: 3,
    room_type_name: "豪华大床房",
    check_in_date: TODAY,
    check_out_date: DAY_AFTER,
    status,
    source: "WECHAT",
    external_reference: "WX-1",
    agreed_total_amount: "428.00",
    currency: "CNY",
    notes: null,
    stay_id: status === "CHECKED_IN" || status === "COMPLETED" ? 21 : null,
  };
}

const ALL_BOOKING_PERMS = [
  "guest:read",
  "reservation:read",
  "reservation:write",
  "reservation:cancel",
  "reservation:no_show",
  "stay:check_in",
  "stay:read",
  "room:read",
];

function makeUser(permissions: string[]): MeOut {
  return {
    id: 1,
    username: "fd",
    display_name: null,
    email: null,
    phone: null,
    is_active: true,
    created_at: "x",
    updated_at: "x",
    roles: [{ id: 2, name: "FRONT_DESK" }],
    permissions,
  };
}

function renderDetail(user: MeOut, reservation: ReservationOut) {
  return render(
    <UserContext.Provider value={user}>
      <ReservationDetailView id={String(reservation.id)} />
    </UserContext.Provider>,
  );
}

beforeEach(() => {
  getMock.mockReset();
  roomGetMock.mockReset();
  cancelMock.mockReset();
  noShowMock.mockReset();
  checkInMock.mockReset();
  updateMock.mockReset();
  replaceMock.mockClear();
  roomGetMock.mockResolvedValue(ROOM);
});

describe("ReservationDetailView", () => {
  it("CONFIRMED：显示编辑 / 入住 / 取消 / 未到店 按钮（按权限）", async () => {
    getMock.mockResolvedValue(makeReservation("CONFIRMED"));
    renderDetail(makeUser(ALL_BOOKING_PERMS), makeReservation("CONFIRMED"));
    expect(await screen.findByText("预订 RSV-TEST-0011")).toBeInTheDocument();
    for (const label of ["编辑预订", "办理入住", "取消预订", "标记未到店"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(screen.getByText("已确认")).toBeInTheDocument();
    // Check-in 前置信息：房间现场状态（dirty 提示）
    expect(await screen.findByText(/房间未清洁/)).toBeInTheDocument();
  });

  it("CHECKED_IN：无编辑 / 取消 / 未到店入口，有入住记录链接", async () => {
    getMock.mockResolvedValue(makeReservation("CHECKED_IN"));
    renderDetail(makeUser(ALL_BOOKING_PERMS), makeReservation("CHECKED_IN"));
    expect(await screen.findByText("已入住")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "编辑预订" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "取消预订" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /查看入住记录/ })).toBeInTheDocument();
  });

  it("无 cancel/no_show/check_in 权限 → 对应按钮不显示", async () => {
    getMock.mockResolvedValue(makeReservation("CONFIRMED"));
    renderDetail(
      makeUser(["reservation:read", "reservation:write", "guest:read"]),
      makeReservation("CONFIRMED"),
    );
    expect(await screen.findByText("预订 RSV-TEST-0011")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "编辑预订" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "办理入住" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "取消预订" }),
    ).not.toBeInTheDocument();
  });

  it("Check-in 409（dirty 房间）→ 展示后端 detail 原文", async () => {
    getMock.mockResolvedValue(makeReservation("CONFIRMED"));
    checkInMock.mockRejectedValue(
      new ApiError("conflict", 409, "房间未清洁，请先安排保洁"),
    );
    renderDetail(makeUser(ALL_BOOKING_PERMS), makeReservation("CONFIRMED"));
    await screen.findByText("预订 RSV-TEST-0011");
    await userEvent.click(screen.getByRole("button", { name: "办理入住" }));
    // 确认对话框
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "办理入住" }),
    );
    expect(
      await screen.findByText("房间未清洁，请先安排保洁"),
    ).toBeInTheDocument();
  });

  it("Check-in 成功 → 跳转在住详情", async () => {
    getMock.mockResolvedValue(makeReservation("CONFIRMED"));
    const checkedIn = makeReservation("CHECKED_IN");
    checkInMock.mockResolvedValue({
      reservation: checkedIn,
      stay: {
        id: 21,
        stay_no: "STY-TEST-0021",
        reservation_id: 11,
        room_id: 1,
        status: "ACTIVE",
        actual_check_in_at: "2026-08-26T10:00:00+08:00",
        planned_check_out_date: DAY_AFTER,
      },
    });
    renderDetail(makeUser(ALL_BOOKING_PERMS), makeReservation("CONFIRMED"));
    await screen.findByText("预订 RSV-TEST-0011");
    await userEvent.click(screen.getByRole("button", { name: "办理入住" }));
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "办理入住" }),
    );
    await waitFor(() => expect(routerMock.push).toHaveBeenCalledWith("/stays/21"));
  });

  it("Cancel 成功 → 状态刷新为 CANCELLED（真实后端结果）", async () => {
    // 模拟真实后端：取消后重新拉取详情返回 CANCELLED
    getMock
      .mockResolvedValueOnce(makeReservation("CONFIRMED"))
      .mockResolvedValueOnce({ ...makeReservation("CONFIRMED"), status: "CANCELLED" });
    cancelMock.mockResolvedValue({ ...makeReservation("CONFIRMED"), status: "CANCELLED" });
    renderDetail(makeUser(ALL_BOOKING_PERMS), makeReservation("CONFIRMED"));
    await screen.findByText("预订 RSV-TEST-0011");
    await userEvent.click(screen.getByRole("button", { name: "取消预订" }));
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "取消预订" }),
    );
    expect(await screen.findByText("已取消")).toBeInTheDocument();
    // 重载后仍为 CANCELLED（无操作按钮）
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "取消预订" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("No-show 成功 → 状态刷新为 NO_SHOW", async () => {
    getMock
      .mockResolvedValueOnce(makeReservation("CONFIRMED"))
      .mockResolvedValueOnce({ ...makeReservation("CONFIRMED"), status: "NO_SHOW" });
    noShowMock.mockResolvedValue({ ...makeReservation("CONFIRMED"), status: "NO_SHOW" });
    renderDetail(makeUser(ALL_BOOKING_PERMS), makeReservation("CONFIRMED"));
    await screen.findByText("预订 RSV-TEST-0011");
    await userEvent.click(screen.getByRole("button", { name: "标记未到店" }));
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "标记未到店" }),
    );
    expect(await screen.findByText("未到店")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "标记未到店" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("403 → Forbidden 视图（不跳登录）", async () => {
    getMock.mockRejectedValue(new ApiError("forbidden", 403, "权限不足"));
    renderDetail(makeUser(["room:read"]), makeReservation("CONFIRMED"));
    expect(
      await screen.findByText("无权限查看预订详情"),
    ).toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalledWith("/login");
  });

  it("401 → 跳转 /login", async () => {
    getMock.mockRejectedValue(new ApiError("unauthorized", 401, "未认证"));
    renderDetail(makeUser(ALL_BOOKING_PERMS), makeReservation("CONFIRMED"));
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/login"));
  });

  it("无 guest:read → 不渲染客人姓名（PII 双保险，仅 ID）", async () => {
    getMock.mockResolvedValue({
      ...makeReservation("CONFIRMED"),
      guest_name: undefined,
    });
    renderDetail(
      makeUser(["reservation:read", "room:read"]),
      makeReservation("CONFIRMED"),
    );
    expect(await screen.findByText("预订 RSV-TEST-0011")).toBeInTheDocument();
    expect(screen.getByText("ID 7")).toBeInTheDocument();
    expect(screen.queryByText("张先生")).not.toBeInTheDocument();
  });
});
