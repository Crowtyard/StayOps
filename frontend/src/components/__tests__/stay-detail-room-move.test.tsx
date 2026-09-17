/**
 * StayDetailView Room Move 集成测试（Sprint 6 §25/§26/§27/§28）：
 * - stay:room_move 权限门控（有权限显示 [换房]，无权限 hidden）
 * - Room Move Dialog：目标房由 room-move-options 后端权威驱动、
 *   原因枚举、确认前摘要、显式「确认换房」
 * - 成功 → 调用 roomMove API + 重新获取真实数据
 * - 409 → 展示后端原文（error state）
 * - 房间记录（assignment history）展示
 * - 原分配房 vs 当前在住房（仅换房后展示）
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "@/lib/api";
import type { MeOut, RoomOut, StayOut } from "@/lib/api/types";
import { addDays, businessDate } from "@/lib/booking";
import StayDetailView from "@/components/stay-detail-view";
import { UserContext } from "@/components/app-shell";

const {
  replaceMock,
  routerMock,
  getMock,
  roomGetMock,
  checkOutMock,
  roomMoveOptionsMock,
  roomMoveMock,
} = vi.hoisted(() => {
  const replaceMock = vi.fn();
  return {
    replaceMock,
    routerMock: { replace: replaceMock, push: vi.fn(), refresh: vi.fn() },
    getMock: vi.fn(),
    roomGetMock: vi.fn(),
    checkOutMock: vi.fn(),
    roomMoveOptionsMock: vi.fn(),
    roomMoveMock: vi.fn(),
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
      stays: {
        get: getMock,
        checkOut: checkOutMock,
        roomMoveOptions: roomMoveOptionsMock,
        roomMove: roomMoveMock,
      },
      rooms: { get: roomGetMock },
    },
  };
});

const TODAY = businessDate();

function makeStay(overrides: Partial<StayOut> = {}): StayOut {
  return {
    id: 21,
    stay_no: "STY-TEST-0021",
    reservation_id: 11,
    room_id: 205,
    room_number: "205",
    status: "ACTIVE",
    actual_check_in_at: `${TODAY}T10:00:00+08:00`,
    planned_check_out_date: addDays(TODAY, 2),
    guest_id: 7,
    guest_name: "张先生",
    reservation: {
      reservation_no: "RSV-TEST-0011",
      room_id: 203,
      room_number: "203",
      check_in_date: TODAY,
      check_out_date: addDays(TODAY, 2),
      status: "CHECKED_IN",
      source: "DIRECT",
      agreed_total_amount: "428.00",
      currency: "CNY",
    },
    assignments: [
      {
        id: 1,
        stay_id: 21,
        room_id: 203,
        room_number: "203",
        started_at: `${TODAY}T10:00:00+08:00`,
        ended_at: `${TODAY}T12:00:00+08:00`,
      },
      {
        id: 2,
        stay_id: 21,
        room_id: 205,
        room_number: "205",
        started_at: `${TODAY}T12:00:00+08:00`,
        ended_at: undefined,
        reason: "MAINTENANCE",
      },
    ],
    ...overrides,
  };
}

const ROOM_205: RoomOut = {
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

const OPTIONS = {
  business_date: TODAY,
  stay_id: 21,
  stay_no: "STY-TEST-0021",
  current_room_id: 205,
  planned_check_out_date: addDays(TODAY, 2),
  items: [
    {
      room_id: 203,
      room_number: "203",
      room_type_id: 4,
      room_type_name: "豪华双床房",
      floor: 2,
      eligible: false,
      reason: "当前入住房间",
    },
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
    {
      room_id: 207,
      room_number: "207",
      room_type_id: 4,
      room_type_name: "豪华双床房",
      floor: 2,
      eligible: false,
      reason: "房间未清洁，不可换入",
    },
  ],
};

const FULL_PERMS = [
  "stay:read",
  "stay:check_out",
  "stay:room_move",
  "reservation:read",
  "guest:read",
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

function renderDetail(user: MeOut) {
  return render(
    <UserContext.Provider value={user}>
      <StayDetailView id="21" />
    </UserContext.Provider>,
  );
}

beforeEach(() => {
  getMock.mockReset();
  roomGetMock.mockReset();
  checkOutMock.mockReset();
  roomMoveOptionsMock.mockReset();
  roomMoveMock.mockReset();
  replaceMock.mockClear();
  roomGetMock.mockResolvedValue(ROOM_205);
});

describe("StayDetail Room Move", () => {
  it("stay:room_move 权限门控：有权限显示 [换房]，无权限 hidden", async () => {
    getMock.mockResolvedValue(makeStay());
    const { unmount } = renderDetail(makeUser(FULL_PERMS));
    await screen.findByText("入住 STY-TEST-0021");
    expect(
      screen.getByRole("button", { name: "换房" }),
    ).toBeInTheDocument();
    unmount();

    getMock.mockResolvedValue(makeStay());
    renderDetail(makeUser(FULL_PERMS.filter((p) => p !== "stay:room_move")));
    await screen.findByText("入住 STY-TEST-0021");
    expect(screen.queryByRole("button", { name: "换房" })).toBeNull();
  });

  it("Room Move Dialog：后端权威候选 + 确认换房 → roomMove API + 重新获取", async () => {
    getMock.mockResolvedValue(makeStay());
    roomMoveOptionsMock.mockResolvedValue(OPTIONS);
    roomMoveMock.mockResolvedValue(makeStay({ room_id: 206, room_number: "206" }));
    renderDetail(makeUser(FULL_PERMS));
    await screen.findByText("入住 STY-TEST-0021");

    await userEvent.click(screen.getByRole("button", { name: "换房" }));
    const dialog = await screen.findByRole("dialog", { name: "换房" });
    // Guest/Stay identification + 当前房间 + 计划退房
    expect(within(dialog).getByText("STY-TEST-0021")).toBeInTheDocument();
    expect(within(dialog).getByText(/当前房间 205/)).toBeInTheDocument();

    // 目标房选择器：由 room-move-options 驱动；不可用房 disabled + 原因
    const targetSelect = within(dialog).getByLabelText("目标房间") as HTMLSelectElement;
    const targetOptions = within(targetSelect).getAllByRole("option");
    expect(targetOptions).toHaveLength(5); // 占位 + 4 候选
    expect(
      within(targetSelect).getByRole("option", { name: /207（不可换入：房间未清洁/ }),
    ).toHaveProperty("disabled", true);

    await userEvent.selectOptions(targetSelect, "206");
    // 确认前摘要：当前房间 → 目标房间 + 剩余住宿日期 + 原房换房后状态
    expect(within(dialog).getByText(/确认换房：205 → 206/)).toBeInTheDocument();
    expect(within(dialog).getByText(/剩余住宿 2 晚/)).toBeInTheDocument();
    expect(within(dialog).getByText(/可售 \+ 待清扫/)).toBeInTheDocument();

    // 原因 + 备注
    await userEvent.selectOptions(
      within(dialog).getByLabelText("换房原因"),
      "MAINTENANCE",
    );
    await userEvent.type(within(dialog).getByLabelText("备注（可选）"), "空调故障");

    // 显式确认换房（两段确认：按钮 + 确认对话框）
    await userEvent.click(
      within(dialog).getByRole("button", { name: "确认换房" }),
    );
    const confirm = screen.getByRole("dialog", { name: "确认换房" });
    await userEvent.click(
      within(confirm).getByRole("button", { name: "确认换房" }),
    );

    await waitFor(() =>
      expect(roomMoveMock).toHaveBeenCalledWith(21, {
        target_room_id: 206,
        reason: "MAINTENANCE",
        notes: "空调故障",
      }),
    );
    // 成功 → 重新获取真实数据（getMock 第二次调用）
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(2));
  });

  it("换房 409 → 展示后端原文（error state，不关闭对话框）", async () => {
    getMock.mockResolvedValue(makeStay());
    roomMoveOptionsMock.mockResolvedValue(OPTIONS);
    roomMoveMock.mockRejectedValue(
      new ApiError("conflict", 409, "目标房间不可换入：房间在剩余入住日期区间已有预订"),
    );
    renderDetail(makeUser(FULL_PERMS));
    await screen.findByText("入住 STY-TEST-0021");
    await userEvent.click(screen.getByRole("button", { name: "换房" }));
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
    expect(
      await screen.findByText(/剩余入住日期区间已有预订/),
    ).toBeInTheDocument();
    expect(getMock).toHaveBeenCalledTimes(1); // 未成功不 refetch
  });

  it("房间记录：assignment history（房间 + 时间 + 原因 + 当前）", async () => {
    getMock.mockResolvedValue(makeStay());
    renderDetail(makeUser(FULL_PERMS));
    await screen.findByText("入住 STY-TEST-0021");
    expect(screen.getByText("房间记录")).toBeInTheDocument();
    expect(screen.getByText("房间 203")).toBeInTheDocument();
    expect(screen.getByText("房间 205")).toBeInTheDocument();
    expect(screen.getByText("入住")).toBeInTheDocument();
    expect(screen.getByText("维修故障 · 当前")).toBeInTheDocument();
  });

  it("原分配房 vs 当前在住房：换房后展示，未换房不展示", async () => {
    getMock.mockResolvedValue(makeStay());
    const { unmount } = renderDetail(makeUser(FULL_PERMS));
    await screen.findByText("入住 STY-TEST-0021");
    expect(screen.getByText("换房信息")).toBeInTheDocument();
    expect(screen.getByText("原分配房")).toBeInTheDocument();
    expect(screen.getByText("当前在住房")).toBeInTheDocument();
    unmount();

    const unmoved = makeStay({
      room_id: 203,
      room_number: "203",
      assignments: [
        {
          id: 1,
          stay_id: 21,
          room_id: 203,
          room_number: "203",
          started_at: `${TODAY}T10:00:00+08:00`,
          ended_at: undefined,
        },
      ],
    });
    getMock.mockResolvedValue(unmoved);
    renderDetail(makeUser(FULL_PERMS));
    await screen.findByText("入住 STY-TEST-0021");
    expect(screen.queryByText("换房信息")).not.toBeInTheDocument();
  });
});
