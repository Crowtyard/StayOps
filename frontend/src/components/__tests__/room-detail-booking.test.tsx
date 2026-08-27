/**
 * RoomDetailView Booking 扩展（S2-T2）测试：
 * - stay:read → 当前 Stay 摘要（实际入住时间 / 计划退房）
 * - reservation:read → 下一笔 Reservation 摘要
 * - HOUSEKEEPING（无 stay:read/reservation:read）→ 仅「当前有客」非身份摘要，
 *   无 Guest 身份 / 预订号 / 金额
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { MeOut, ReservationOut, RoomOut, StayOut } from "@/lib/api/types";
import { addDays, businessDate } from "@/lib/booking";
import RoomDetailView from "@/components/room-detail-view";
import { UserContext } from "@/components/app-shell";

const { getMock, changeStatusMock, staysListMock, reservationsListMock } =
  vi.hoisted(() => ({
    getMock: vi.fn(),
    changeStatusMock: vi.fn(),
    staysListMock: vi.fn(),
    reservationsListMock: vi.fn(),
  }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
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
      rooms: { get: getMock, changeStatus: changeStatusMock },
      stays: { list: staysListMock },
      reservations: { list: reservationsListMock },
    },
  };
});

const TODAY = businessDate();
const DAY_AFTER = addDays(TODAY, 1);

const ROOM_OCCUPIED: RoomOut = {
  id: 1,
  room_number: "203",
  room_type_id: 3,
  floor: 2,
  occupancy_status: "occupied",
  cleaning_status: "dirty",
  notes: null,
  created_at: "x",
  updated_at: "x",
  room_type: { id: 3, name: "豪华大床房" },
};

const ACTIVE_STAY: StayOut = {
  id: 21,
  stay_no: "STY-TEST-0021",
  reservation_id: 11,
  room_id: 1,
  room_number: "203",
  status: "ACTIVE",
  actual_check_in_at: "2026-08-26T10:00:00+08:00",
  planned_check_out_date: DAY_AFTER,
  guest_id: 7,
  guest_name: "张先生",
};

const NEXT_RESERVATION: ReservationOut = {
  id: 12,
  reservation_no: "RSV-NEXT-0012",
  guest_id: 8,
  guest_name: "李女士",
  room_id: 1,
  room_number: "203",
  room_type_id: 3,
  room_type_name: "豪华大床房",
  check_in_date: addDays(TODAY, 3),
  check_out_date: addDays(TODAY, 5),
  status: "CONFIRMED",
  source: "OTA",
  agreed_total_amount: "500.00",
  currency: "CNY",
};

function makeUser(permissions: string[]): MeOut {
  return {
    id: 1,
    username: "hk",
    display_name: null,
    email: null,
    phone: null,
    is_active: true,
    created_at: "x",
    updated_at: "x",
    roles: [{ id: 4, name: "HOUSEKEEPING" }],
    permissions,
  };
}

function renderDetail(user: MeOut) {
  return render(
    <UserContext.Provider value={user}>
      <RoomDetailView id="1" />
    </UserContext.Provider>,
  );
}

beforeEach(() => {
  getMock.mockReset().mockResolvedValue(ROOM_OCCUPIED);
  changeStatusMock.mockReset();
  staysListMock.mockReset().mockResolvedValue({ items: [], total: 0, page: 1, page_size: 10 });
  reservationsListMock.mockReset().mockResolvedValue({ items: [], total: 0, page: 1, page_size: 100 });
});

describe("RoomDetailView Booking 扩展", () => {
  it("stay:read + reservation:read → 展示当前 Stay 与下一笔预订摘要", async () => {
    staysListMock.mockResolvedValue({
      items: [ACTIVE_STAY],
      total: 1,
      page: 1,
      page_size: 10,
    });
    reservationsListMock.mockResolvedValue({
      items: [NEXT_RESERVATION],
      total: 1,
      page: 1,
      page_size: 100,
    });
    renderDetail(
      makeUser([
        "room:read",
        "room:status_cleaning",
        "stay:read",
        "reservation:read",
        "guest:read",
      ]),
    );
    expect(await screen.findByText("房间 203")).toBeInTheDocument();
    expect(await screen.findByText("当前在住")).toBeInTheDocument();
    expect(screen.getByText("STY-TEST-0021")).toBeInTheDocument();
    expect(screen.getByText(DAY_AFTER)).toBeInTheDocument();
    expect(await screen.findByText("下一笔预订")).toBeInTheDocument();
    expect(screen.getByText("RSV-NEXT-0012")).toBeInTheDocument();
    expect(screen.getByText("OTA")).toBeInTheDocument();
    // guest:read → 客人姓名可见
    expect(screen.getByText("李女士")).toBeInTheDocument();
  });

  it("HOUSEKEEPING：无 stay:read/reservation:read → 仅「当前有客」非身份摘要，无预订号/金额/姓名", async () => {
    renderDetail(makeUser(["room:read", "room:status_cleaning"]));
    expect(await screen.findByText("房间 203")).toBeInTheDocument();
    expect(await screen.findByText("当前有客")).toBeInTheDocument();
    expect(screen.getByText("房间正在被客人使用")).toBeInTheDocument();
    expect(screen.queryByText("当前在住")).not.toBeInTheDocument();
    expect(screen.queryByText("下一笔预订")).not.toBeInTheDocument();
    expect(screen.queryByText("STY-TEST-0021")).not.toBeInTheDocument();
    expect(screen.queryByText("RSV-NEXT-0012")).not.toBeInTheDocument();
    expect(screen.queryByText("张先生")).not.toBeInTheDocument();
    expect(screen.queryByText("500.00")).not.toBeInTheDocument();
    // 不发 Booking 查询
    expect(staysListMock).not.toHaveBeenCalled();
    expect(reservationsListMock).not.toHaveBeenCalled();
  });

  it("无 guest:read → 下一笔预订不渲染客人姓名（后端已裁剪，前端双保险）", async () => {
    reservationsListMock.mockResolvedValue({
      items: [{ ...NEXT_RESERVATION, guest_name: undefined }],
      total: 1,
      page: 1,
      page_size: 100,
    });
    renderDetail(makeUser(["room:read", "reservation:read"]));
    expect(await screen.findByText("下一笔预订")).toBeInTheDocument();
    expect(screen.queryByText("李女士")).not.toBeInTheDocument();
  });
});
