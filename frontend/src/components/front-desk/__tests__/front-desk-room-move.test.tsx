/**
 * Front Desk Room Move 集成测试（Sprint 6 §25/§26/§28）：
 * - In-house 抽屉：stay:room_move 显示 [换房]，无权限 hidden
 * - 点击换房 → 换房抽屉（复用 RoomMoveDialog，后端权威候选）→ 成功 → refetch + 关闭抽屉
 * - Reservation 抽屉：已入住且换房 → 展示「原分配房 vs 当前在住房」
 * - Mobile Today Board：换房入口权限门控
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "@/lib/api";
import type {
  ReservationOut,
  RoomOut,
  StayOut,
} from "@/lib/api/types";
import { addDays, businessDate } from "@/lib/booking";
import FrontDeskDrawerView from "@/components/front-desk/drawer-views";
import FrontDeskTodayBoard from "@/components/front-desk/front-desk-today-board";
import { computeAttention, computeTodaySummary } from "@/lib/front-desk";
import type { FrontDeskBundle } from "@/components/front-desk/use-front-desk-data";

const { staysGetMock, roomMoveOptionsMock, roomMoveMock } = vi.hoisted(() => ({
  staysGetMock: vi.fn(),
  roomMoveOptionsMock: vi.fn(),
  roomMoveMock: vi.fn(),
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
      stays: {
        get: staysGetMock,
        roomMoveOptions: roomMoveOptionsMock,
        roomMove: roomMoveMock,
      },
      reservations: { list: vi.fn(), get: vi.fn() },
    },
  };
});

const TODAY = businessDate();

const PERMISSIONS = new Set([
  "room:read",
  "reservation:read",
  "guest:read",
  "stay:read",
  "stay:room_move",
]);

function makeStay(overrides: Partial<StayOut> = {}): StayOut {
  return {
    id: 21,
    stay_no: "STY-FDM-0021",
    reservation_id: 11,
    room_id: 205,
    room_number: "205",
    status: "ACTIVE",
    actual_check_in_at: `${TODAY}T10:00:00+08:00`,
    planned_check_out_date: addDays(TODAY, 2),
    guest_name: "张先生",
    ...overrides,
  };
}

const OPTIONS = {
  business_date: TODAY,
  stay_id: 21,
  stay_no: "STY-FDM-0021",
  current_room_id: 205,
  planned_check_out_date: addDays(TODAY, 2),
  items: [
    {
      room_id: 205,
      room_number: "205",
      room_type_id: 3,
      room_type_name: "豪华大床房",
      floor: 2,
      eligible: false,
      reason: "当前入住房间",
    },
    {
      room_id: 206,
      room_number: "206",
      room_type_id: 4,
      room_type_name: "豪华双床房",
      floor: 2,
      eligible: true,
      reason: null,
    },
  ],
};

function makeBundle(stays: StayOut[] = [], reservations: ReservationOut[] = []): FrontDeskBundle {
  return {
    rooms: null,
    reservations,
    stays,
    tasks: null,
    workOrders: null,
    ready: true,
    error: null,
    forbidden: false,
  };
}

beforeEach(() => {
  staysGetMock.mockReset();
  roomMoveOptionsMock.mockReset();
  roomMoveMock.mockReset();
});

describe("In-house 抽屉换房入口（§25）", () => {
  it("stay:room_move 显示 [换房]；无权限 hidden（后端仍 403 防护）", () => {
    const stay = makeStay();
    const { unmount } = render(
      <FrontDeskDrawerView
        selection={{ kind: "inhouse" }}
        bundle={makeBundle([stay])}
        permissions={PERMISSIONS}
        today={TODAY}
        onChanged={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "换房" }),
    ).toBeInTheDocument();
    unmount();

    const without = new Set(PERMISSIONS);
    without.delete("stay:room_move");
    render(
      <FrontDeskDrawerView
        selection={{ kind: "inhouse" }}
        bundle={makeBundle([stay])}
        permissions={without}
        today={TODAY}
        onChanged={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "换房" })).toBeNull();
  });

  it("点击 [换房] → 换房抽屉（onSelect stay-move）", () => {
    const onSelect = vi.fn();
    render(
      <FrontDeskDrawerView
        selection={{ kind: "inhouse" }}
        bundle={makeBundle([makeStay()])}
        permissions={PERMISSIONS}
        today={TODAY}
        onChanged={vi.fn()}
        onSelect={onSelect}
      />,
    );
    // 直接触发（避免依赖上一 case 的 userEvent 复杂度）
    screen.getByRole("button", { name: "换房" }).click();
    expect(onSelect).toHaveBeenCalledWith({ kind: "stay-move", stayId: 21 });
  });
});

describe("换房抽屉（stay-move）", () => {
  it("目标房由 room-move-options 驱动；确认换房成功 → onChanged + 关闭抽屉", async () => {
    roomMoveOptionsMock.mockResolvedValue(OPTIONS);
    roomMoveMock.mockResolvedValue(makeStay({ room_id: 206, room_number: "206" }));
    const onChanged = vi.fn();
    const onSelect = vi.fn();
    render(
      <FrontDeskDrawerView
        selection={{ kind: "stay-move", stayId: 21 }}
        bundle={makeBundle([makeStay()])}
        permissions={PERMISSIONS}
        today={TODAY}
        onChanged={onChanged}
        onSelect={onSelect}
      />,
    );

    const dialog = await screen.findByRole("dialog", { name: "换房" });
    await userEvent.selectOptions(
      within(dialog).getByLabelText("目标房间"),
      "206",
    );
    expect(within(dialog).getByText(/确认换房：205 → 206/)).toBeInTheDocument();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "确认换房" }),
    );
    await userEvent.click(
      within(screen.getByRole("dialog", { name: "确认换房" })).getByRole(
        "button",
        { name: "确认换房" },
      ),
    );

    await waitFor(() =>
      expect(roomMoveMock).toHaveBeenCalledWith(21, {
        target_room_id: 206,
        reason: "GUEST_REQUEST",
        notes: null,
      }),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(null));
  });

  it("bundle 无该 Stay → 定向 GET /stays/{id} 兜底加载", async () => {
    staysGetMock.mockResolvedValue(makeStay());
    roomMoveOptionsMock.mockResolvedValue(OPTIONS);
    render(
      <FrontDeskDrawerView
        selection={{ kind: "stay-move", stayId: 21 }}
        bundle={makeBundle([])}
        permissions={PERMISSIONS}
        today={TODAY}
        onChanged={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    expect(await screen.findByRole("dialog", { name: "换房" })).toBeInTheDocument();
    expect(staysGetMock).toHaveBeenCalledWith(21);
  });

  it("409 → 展示后端原文", async () => {
    roomMoveOptionsMock.mockResolvedValue(OPTIONS);
    roomMoveMock.mockRejectedValue(
      new ApiError("conflict", 409, "目标房间不可换入：房间已有在住记录"),
    );
    render(
      <FrontDeskDrawerView
        selection={{ kind: "stay-move", stayId: 21 }}
        bundle={makeBundle([makeStay()])}
        permissions={PERMISSIONS}
        today={TODAY}
        onChanged={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    const dialog = await screen.findByRole("dialog", { name: "换房" });
    await userEvent.selectOptions(
      within(dialog).getByLabelText("目标房间"),
      "206",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "确认换房" }),
    );
    await userEvent.click(
      within(screen.getByRole("dialog", { name: "确认换房" })).getByRole(
        "button",
        { name: "确认换房" },
      ),
    );
    expect(await screen.findByText(/房间已有在住记录/)).toBeInTheDocument();
  });
});

describe("Reservation 抽屉：原分配房 vs 当前在住房（§28）", () => {
  function makeReservation(): ReservationOut {
    return {
      id: 11,
      reservation_no: "RSV-FDM-0011",
      guest_id: 7,
      guest_name: "张先生",
      room_id: 203,
      room_number: "203",
      room_type_id: 4,
      room_type_name: "豪华双床房",
      check_in_date: TODAY,
      check_out_date: addDays(TODAY, 2),
      status: "CHECKED_IN",
      source: "DIRECT",
      agreed_total_amount: "428.00",
      currency: "CNY",
      stay_id: 21,
    };
  }

  it("已入住且换过房 → 展示当前在住房", async () => {
    render(
      <FrontDeskDrawerView
        selection={{ kind: "reservation", reservationId: 11 }}
        bundle={makeBundle(
          [makeStay({ room_id: 205, room_number: "205" })],
          [makeReservation()],
        )}
        permissions={PERMISSIONS}
        today={TODAY}
        onChanged={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    await screen.findByText("RSV-FDM-0011");
    expect(screen.getByText("当前在住房")).toBeInTheDocument();
    expect(screen.getByText("205")).toBeInTheDocument();
  });

  it("未换房（stay.room_id == reservation.room_id）→ 不重复展示", async () => {
    render(
      <FrontDeskDrawerView
        selection={{ kind: "reservation", reservationId: 11 }}
        bundle={makeBundle(
          [makeStay({ room_id: 203, room_number: "203" })],
          [makeReservation()],
        )}
        permissions={PERMISSIONS}
        today={TODAY}
        onChanged={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    await screen.findByText("RSV-FDM-0011");
    expect(screen.queryByText("当前在住房")).not.toBeInTheDocument();
  });
});

describe("Mobile Today Board 换房入口（§25 移动端）", () => {
  function renderBoard(permissions: Set<string>) {
    const rooms = [makeMobileRoom()];
    const stays = [makeStay()];
    const attention = computeAttention([], stays, rooms, TODAY);
    const summary = computeTodaySummary(rooms, [], stays, TODAY);
    const onOpenStayMove = vi.fn();
    render(
      <FrontDeskTodayBoard
        rooms={rooms}
        reservations={[]}
        stays={stays}
        attention={attention}
        summary={summary}
        permissions={permissions}
        today={TODAY}
        canReadGuest={true}
        onOpenReservation={vi.fn()}
        onOpenRoom={vi.fn()}
        onSelectSummary={vi.fn()}
        onOpenStayMove={onOpenStayMove}
      />,
    );
    return { onOpenStayMove };
  }

  function makeMobileRoom(): RoomOut {
    return {
      id: 205,
      room_number: "205",
      name: null,
      is_active: true,
      room_type_id: 3,
      floor: 2,
      occupancy_status: "occupied",
      cleaning_status: "clean",
      notes: null,
      created_at: "x",
      updated_at: "x",
      room_type: { id: 3, name: "豪华大床房" },
    };
  }

  it("stay:room_move 显示 [换房]；无权限 hidden", () => {
    const { onOpenStayMove } = renderBoard(PERMISSIONS);
    const button = screen.getByRole("button", { name: "换房" });
    button.click();
    expect(onOpenStayMove).toHaveBeenCalledWith(21);
  });

  it("无 stay:room_move 不渲染 [换房]", () => {
    const without = new Set(PERMISSIONS);
    without.delete("stay:room_move");
    renderBoard(without);
    expect(screen.queryByRole("button", { name: "换房" })).toBeNull();
  });
});
