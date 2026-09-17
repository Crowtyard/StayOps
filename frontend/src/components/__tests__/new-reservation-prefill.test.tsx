/**
 * Sprint 4 快速新建预填测试（/reservations/new?room_id=...&dates）：
 * - /front-desk 空白日期格 → 复用现有 Reservation Form 并正确预填
 *   room_id / room_type_id / check_in_date / check_out_date(=check_in+1)
 * - 只给 room_id 时定向补全 room_type_id（Room/RoomType 联动）
 * - Backend Availability 仍重新验证（表单继续查询真实可售性）
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import NewReservationView from "@/components/new-reservation-view";
import { UserContext } from "@/components/app-shell";
import { addDays, businessDate } from "@/lib/booking";
import type { MeOut } from "@/lib/api/types";

const TODAY = businessDate();
const CHECK_OUT = addDays(TODAY, 1);

const {
  roomsGetMock,
  roomTypesListMock,
  availabilityQueryMock,
  reservationsCreateMock,
} = vi.hoisted(() => ({
  roomsGetMock: vi.fn(),
  roomTypesListMock: vi.fn(),
  availabilityQueryMock: vi.fn(),
  reservationsCreateMock: vi.fn(),
}));

const searchParamsMock = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => searchParamsMock,
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
      rooms: { get: roomsGetMock, list: vi.fn() },
      roomTypes: { list: roomTypesListMock },
      availability: { query: availabilityQueryMock },
      reservations: { create: reservationsCreateMock, get: vi.fn(), list: vi.fn() },
      guests: { search: vi.fn(), get: vi.fn() },
    },
  };
});

function makeUser(): MeOut {
  return {
    id: 1,
    username: "fd",
    display_name: "前台",
    email: null,
    phone: null,
    is_active: true,
    created_at: "x",
    updated_at: "x",
    roles: [{ id: 2, name: "FRONT_DESK" }],
    permissions: [
      "room:read",
      "room_type:read",
      "reservation:read",
      "reservation:write",
      "guest:read",
      "guest:write",
    ],
  };
}

function renderView() {
  return render(
    <UserContext.Provider value={makeUser()}>
      <NewReservationView />
    </UserContext.Provider>,
  );
}

beforeEach(() => {
  searchParamsMock.get.mockReset();
  roomsGetMock.mockReset();
  roomTypesListMock.mockReset().mockResolvedValue({
    items: [
      { id: 3, name: "豪华大床房", base_price: "428.00", capacity: 2 },
    ],
    total: 1,
    page: 1,
    page_size: 100,
  });
  availabilityQueryMock.mockReset().mockResolvedValue({
    business_date: TODAY,
    check_in_date: TODAY,
    check_out_date: CHECK_OUT,
    total: 1,
    available_count: 1,
    items: [
      {
        room_id: 203,
        room_number: "203",
        room_type_id: 3,
        room_type_name: "豪华大床房",
        floor: 2,
        available: true,
        reason: null,
      },
    ],
  });
  reservationsCreateMock.mockReset();
});

describe("快速新建预填（front-desk 空白日期格）", () => {
  it("room_id + room_type_id + 日期 → 表单预填房间与日期，仍查询真实 Availability", async () => {
    searchParamsMock.get.mockImplementation((key: string) => {
      const map: Record<string, string> = {
        room_id: "203",
        room_type_id: "3",
        check_in_date: TODAY,
        check_out_date: CHECK_OUT,
      };
      return map[key] ?? null;
    });
    renderView();

    // 日期输入预填（check_out = check_in + 1）
    expect(await screen.findByDisplayValue(TODAY)).toBeInTheDocument();
    expect(screen.getByDisplayValue(CHECK_OUT)).toBeInTheDocument();
    // 可用房间已被选中（真实 GET /availability 重新验证后展示）
    expect(await screen.findByText(/已选择房间 203/)).toBeInTheDocument();
    expect(availabilityQueryMock).toHaveBeenCalledWith({
      check_in_date: TODAY,
      check_out_date: CHECK_OUT,
      room_type_id: 3,
    });
  });

  it("只给 room_id → 定向补全 room_type_id 后预填（Room/RoomType 联动）", async () => {
    searchParamsMock.get.mockImplementation((key: string) => {
      const map: Record<string, string> = {
        room_id: "203",
        check_in_date: TODAY,
        check_out_date: CHECK_OUT,
      };
      return map[key] ?? null;
    });
    roomsGetMock.mockResolvedValue({
      id: 203,
      room_number: "203",
      name: null,
      is_active: true,
      room_type_id: 3,
      floor: 2,
      occupancy_status: "available",
      cleaning_status: "clean",
      notes: null,
      created_at: "x",
      updated_at: "x",
      room_type: { id: 3, name: "豪华大床房" },
    });
    renderView();

    await waitFor(() => expect(roomsGetMock).toHaveBeenCalledWith(203));
    expect(await screen.findByText(/已选择房间 203/)).toBeInTheDocument();
    expect(availabilityQueryMock).toHaveBeenCalledWith({
      check_in_date: TODAY,
      check_out_date: CHECK_OUT,
      room_type_id: 3,
    });
  });

  it("无查询参数 → 普通新建流程（不预填房间）", async () => {
    searchParamsMock.get.mockReturnValue(null);
    renderView();
    expect(await screen.findByRole("heading", { name: "新建预订" })).toBeInTheDocument();
    expect(roomsGetMock).not.toHaveBeenCalled();
    expect(screen.queryByText(/已选择房间 203/)).toBeNull();
  });
});
