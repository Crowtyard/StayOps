/**
 * Dashboard BookingOverview（S2-T2 扩展）测试：
 * - 今日到店 / 今日离店 / 当前在住 / 未来 7 天预订（组合既有 List API，动态业务日期）
 * - 无权限 → 不渲染区块；PII：无 guest:read 不渲染客人姓名
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { MeOut, ReservationOut, StayOut } from "@/lib/api/types";
import { addDays, businessDate } from "@/lib/booking";
import DashboardView from "@/components/dashboard-view";
import { UserContext } from "@/components/app-shell";

const { roomsListMock, reservationsListMock, staysListMock } = vi.hoisted(() => ({
  roomsListMock: vi.fn(),
  reservationsListMock: vi.fn(),
  staysListMock: vi.fn(),
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
      rooms: { list: roomsListMock },
      reservations: { list: reservationsListMock },
      stays: { list: staysListMock },
    },
  };
});

const TODAY = businessDate();

function makeReservation(
  checkIn: string,
  overrides: Partial<ReservationOut> = {},
): ReservationOut {
  return {
    id: 1,
    reservation_no: "RSV-DASH-0001",
    guest_id: 7,
    guest_name: "张先生",
    room_id: 1,
    room_number: "203",
    room_type_id: 3,
    room_type_name: "豪华大床房",
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
    id: 21,
    stay_no: "STY-DASH-0021",
    reservation_id: 11,
    room_id: 1,
    room_number: "203",
    status: "ACTIVE",
    actual_check_in_at: "2026-08-26T10:00:00+08:00",
    planned_check_out_date: plannedOut,
  };
}

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

const EMPTY_ROOMS_PAGE = { items: [], total: 0, page: 1, page_size: 100 };

beforeEach(() => {
  roomsListMock.mockReset().mockResolvedValue(EMPTY_ROOMS_PAGE);
  reservationsListMock.mockReset().mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    page_size: 100,
  });
  staysListMock.mockReset().mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    page_size: 100,
  });
});

describe("Dashboard BookingOverview", () => {
  it("今日到店/今日离店/当前在住/未来 7 天（动态业务日期，组合 List API）", async () => {
    reservationsListMock.mockResolvedValue({
      items: [
        makeReservation(TODAY),
        makeReservation(addDays(TODAY, 3), { id: 2, reservation_no: "RSV-DASH-0002" }),
        makeReservation(addDays(TODAY, 9), { id: 3, reservation_no: "RSV-DASH-0003" }),
      ],
      total: 3,
      page: 1,
      page_size: 100,
    });
    staysListMock.mockResolvedValue({
      items: [makeStay(TODAY), makeStay(addDays(TODAY, 2))],
      total: 2,
      page: 1,
      page_size: 100,
    });
    render(
      <UserContext.Provider
        value={makeUser([
          "room:read",
          "reservation:read",
          "stay:read",
          "guest:read",
        ])}
      >
        <DashboardView />
      </UserContext.Provider>,
    );
    // 等待真实的数据驱动信号（而非标题）：
    // - RSV-DASH-0001 链接 = GET /reservations 已完成且「今日到店」列表已渲染
    // - STY-DASH-0021 链接 = GET /stays 已完成且「今日离店」列表已渲染
    // 两个信号齐备后 loading=false，四张卡片必然已渲染（消除标题先于数据的竞态）
    expect(
      await screen.findByRole("link", { name: /RSV-DASH-0001/ }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("link", { name: /STY-DASH-0021/ }),
    ).toBeInTheDocument();
    // 今日到店 1；今日离店 1；当前在住 2；未来 7 天 2（第 9 天的不计）
    // 卡片断言作用域化：找到对应卡片容器后在其内部断言数值
    const cardValue = (label: string): string | null => {
      const labelEl = screen
        .getAllByText(label)
        .find((el) => el.tagName === "P");
      const card = labelEl?.closest("div");
      if (!card) return null;
      const number = within(card as HTMLElement).queryAllByText(/^\d+$/);
      return number[0]?.textContent ?? null;
    };
    expect(cardValue("今日到店")).toBe("1");
    expect(cardValue("今日离店")).toBe("1");
    expect(cardValue("当前在住")).toBe("2");
    expect(cardValue("未来 7 天预订")).toBe("2");
    // 第 9 天预订不在未来 7 天内
    expect(screen.queryByText(/RSV-DASH-0003/)).not.toBeInTheDocument();
    expect(screen.getByText(/张先生/)).toBeInTheDocument();
  });

  it("无 reservation:read / stay:read → 不渲染区块", async () => {
    render(
      <UserContext.Provider value={makeUser(["room:read"])}>
        <DashboardView />
      </UserContext.Provider>,
    );
    await screen.findByText("当前房态概览");
    expect(screen.queryByText("预订运营概览")).not.toBeInTheDocument();
    expect(reservationsListMock).not.toHaveBeenCalled();
    expect(staysListMock).not.toHaveBeenCalled();
  });

  it("无 guest:read → 今日到店列表不渲染客人姓名（PII）", async () => {
    reservationsListMock.mockResolvedValue({
      items: [makeReservation(TODAY)],
      total: 1,
      page: 1,
      page_size: 100,
    });
    render(
      <UserContext.Provider
        value={makeUser(["room:read", "reservation:read"])}
      >
        <DashboardView />
      </UserContext.Provider>,
    );
    expect(
      await screen.findByRole("link", { name: /RSV-DASH-0001/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/张先生/)).not.toBeInTheDocument();
  });

  it("组合数据加载失败 → 区块内错误提示（不阻塞房态区）", async () => {
    reservationsListMock.mockRejectedValue(new Error("boom"));
    render(
      <UserContext.Provider
        value={makeUser(["room:read", "reservation:read"])}
      >
        <DashboardView />
      </UserContext.Provider>,
    );
    expect(await screen.findByText("当前房态概览")).toBeInTheDocument();
    expect(
      await screen.findByText("预订/在住概览加载失败"),
    ).toBeInTheDocument();
  });
});
