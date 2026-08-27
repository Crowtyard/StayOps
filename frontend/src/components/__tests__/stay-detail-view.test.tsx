/**
 * StayDetailView 测试：
 * - 展示 Stay 字段与关联预订/客人（按权限裁剪）
 * - Check-out 成功 → 重新获取真实数据（Stay=CHECKED_OUT + Reservation=COMPLETED + Room=available+dirty）
 * - Check-out 409（已退房）→ 展示后端原文
 * - 403 Forbidden / 401 跳登录
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "@/lib/api";
import type { MeOut, RoomOut, StayOut } from "@/lib/api/types";
import { addDays, businessDate } from "@/lib/booking";
import StayDetailView from "@/components/stay-detail-view";
import { UserContext } from "@/components/app-shell";

const { replaceMock, routerMock, getMock, roomGetMock, checkOutMock } =
  vi.hoisted(() => {
    const replaceMock = vi.fn();
    return {
      replaceMock,
      routerMock: { replace: replaceMock, push: vi.fn(), refresh: vi.fn() },
      getMock: vi.fn(),
      roomGetMock: vi.fn(),
      checkOutMock: vi.fn(),
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
      stays: { get: getMock, checkOut: checkOutMock },
      rooms: { get: roomGetMock },
    },
  };
});

const TODAY = businessDate();
const DAY_AFTER = addDays(TODAY, 1);

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
  reservation: {
    reservation_no: "RSV-TEST-0011",
    check_in_date: TODAY,
    check_out_date: DAY_AFTER,
    status: "CHECKED_IN",
    source: "WECHAT",
    agreed_total_amount: "428.00",
    currency: "CNY",
  },
};

const CHECKED_OUT_STAY: StayOut = {
  ...ACTIVE_STAY,
  status: "CHECKED_OUT",
  actual_check_out_at: "2026-08-26T12:00:00+08:00",
  reservation: {
    ...ACTIVE_STAY.reservation!,
    status: "COMPLETED",
  },
};

const ROOM_DIRTY: RoomOut = {
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

const FULL_PERMS = [
  "stay:read",
  "stay:check_out",
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
  replaceMock.mockClear();
  roomGetMock.mockResolvedValue(ROOM_DIRTY);
});

describe("StayDetailView", () => {
  it("ACTIVE：展示入住信息 + 退房按钮 + 关联预订与客人", async () => {
    getMock.mockResolvedValue(ACTIVE_STAY);
    renderDetail(makeUser(FULL_PERMS));
    expect(await screen.findByText("入住 STY-TEST-0021")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "办理退房" })).toBeInTheDocument();
    expect(screen.getByText("在住")).toBeInTheDocument();
    expect(screen.getByText("RSV-TEST-0011")).toBeInTheDocument();
    expect(screen.getByText("已入住")).toBeInTheDocument();
    expect(screen.getByText("张先生")).toBeInTheDocument();
  });

  it("Check-out 成功 → 重新获取：Stay=CHECKED_OUT + Reservation=COMPLETED + Room=available+dirty", async () => {
    getMock.mockResolvedValueOnce(ACTIVE_STAY);
    getMock.mockResolvedValueOnce(CHECKED_OUT_STAY);
    checkOutMock.mockResolvedValue(CHECKED_OUT_STAY);
    renderDetail(makeUser(FULL_PERMS));
    await screen.findByText("入住 STY-TEST-0021");
    await userEvent.click(screen.getByRole("button", { name: "办理退房" }));
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "确认退房" }),
    );
    expect(await screen.findByText("已退房")).toBeInTheDocument();
    expect(screen.getByText("已完成")).toBeInTheDocument();
    expect(
      await screen.findByText("退房完成：房间已置为可售 + 待清扫"),
    ).toBeInTheDocument();
    // 房间现场状态 available + dirty
    expect(await screen.findByText("可售")).toBeInTheDocument();
    expect(screen.getByText("待清扫")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "办理退房" }),
    ).not.toBeInTheDocument();
  });

  it("Check-out 409（已退房）→ 展示后端 detail 原文", async () => {
    getMock.mockResolvedValue(ACTIVE_STAY);
    checkOutMock.mockRejectedValue(
      new ApiError("conflict", 409, "该入住记录已退房"),
    );
    renderDetail(makeUser(FULL_PERMS));
    await screen.findByText("入住 STY-TEST-0021");
    await userEvent.click(screen.getByRole("button", { name: "办理退房" }));
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "确认退房" }),
    );
    expect(await screen.findByText("该入住记录已退房")).toBeInTheDocument();
  });

  it("无 reservation:read / guest:read → 不渲染预订摘要与客人姓名", async () => {
    getMock.mockResolvedValue({
      ...ACTIVE_STAY,
      reservation: undefined,
      guest_name: undefined,
    });
    renderDetail(makeUser(["stay:read"]));
    expect(await screen.findByText("入住 STY-TEST-0021")).toBeInTheDocument();
    expect(screen.queryByText("关联预订")).not.toBeInTheDocument();
    expect(screen.queryByText("张先生")).not.toBeInTheDocument();
  });

  it("403 → Forbidden（不跳登录）；401 → /login", async () => {
    getMock.mockRejectedValue(new ApiError("forbidden", 403, "权限不足"));
    renderDetail(makeUser(["room:read"]));
    expect(await screen.findByText("无权限查看在住详情")).toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalledWith("/login");
  });

  it("401 → 跳转 /login", async () => {
    getMock.mockRejectedValue(new ApiError("unauthorized", 401, "未认证"));
    renderDetail(makeUser(FULL_PERMS));
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/login"));
  });
});
