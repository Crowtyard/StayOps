/**
 * ReservationsView（预订列表）测试：
 * - 列表渲染（PII：无 guest:read 仅 ID；金额仅 reservation:read 响应存在）
 * - 403 Forbidden；分页（真实后端分页）
 * - 新建按钮按 reservation:write 显隐
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "@/lib/api";
import type { MeOut, Page, ReservationOut } from "@/lib/api/types";
import { addDays, businessDate } from "@/lib/booking";
import ReservationsView from "@/components/reservations-view";
import { UserContext } from "@/components/app-shell";

const { replaceMock, routerMock, listMock } = vi.hoisted(() => {
  const replaceMock = vi.fn();
  return {
    replaceMock,
    routerMock: { replace: replaceMock, push: vi.fn(), refresh: vi.fn() },
    listMock: vi.fn(),
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
      reservations: { list: listMock },
      rooms: { list: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, page_size: 100 }) },
      roomTypes: { list: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, page_size: 100 }) },
      guests: { list: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, page_size: 10 }) },
    },
  };
});

const TODAY = businessDate();
const DAY_AFTER = addDays(TODAY, 1);

function makeReservation(id: number, overrides: Partial<ReservationOut> = {}): ReservationOut {
  return {
    id,
    reservation_no: `RSV-TEST-00${id}`,
    guest_id: 7,
    guest_name: "张先生",
    room_id: 1,
    room_number: "203",
    room_type_id: 3,
    room_type_name: "豪华大床房",
    check_in_date: TODAY,
    check_out_date: DAY_AFTER,
    status: "CONFIRMED",
    source: "WECHAT",
    agreed_total_amount: "428.00",
    currency: "CNY",
    ...overrides,
  };
}

function makePage(items: ReservationOut[], page = 1, total = items.length): Page<ReservationOut> {
  return { items, total, page, page_size: 20 };
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

function renderView(user: MeOut) {
  return render(
    <UserContext.Provider value={user}>
      <ReservationsView />
    </UserContext.Provider>,
  );
}

beforeEach(() => {
  listMock.mockReset();
  replaceMock.mockClear();
});

describe("ReservationsView", () => {
  it("渲染预订列表（预订号/房间/房型/日期/来源/状态/金额）", async () => {
    listMock.mockResolvedValue(makePage([makeReservation(1)]));
    renderView(makeUser(["reservation:read", "guest:read", "reservation:write"]));
    expect(await screen.findByText("预订管理")).toBeInTheDocument();
    expect(screen.getByText("RSV-TEST-001")).toBeInTheDocument();
    expect(screen.getByText("203")).toBeInTheDocument();
    expect(screen.getByText("豪华大床房")).toBeInTheDocument();
    expect(screen.getByText(TODAY)).toBeInTheDocument();
    expect(screen.getByText("已确认")).toBeInTheDocument();
    expect(screen.getByText("CNY 428.00")).toBeInTheDocument();
    expect(screen.getByText("张先生")).toBeInTheDocument();
  });

  it("无 guest:read → Guest 列仅显示 ID（PII 双保险）", async () => {
    listMock.mockResolvedValue(
      makePage([makeReservation(1, { guest_name: undefined })]),
    );
    renderView(makeUser(["reservation:read"]));
    expect(await screen.findByText("RSV-TEST-001")).toBeInTheDocument();
    expect(screen.getByText("ID 7")).toBeInTheDocument();
    expect(screen.queryByText("张先生")).not.toBeInTheDocument();
  });

  it("无 reservation:write → 不显示新建按钮", async () => {
    listMock.mockResolvedValue(makePage([]));
    renderView(makeUser(["reservation:read", "guest:read"]));
    expect(await screen.findByText("预订管理")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "新建预订" }),
    ).not.toBeInTheDocument();
  });

  it("403 → Forbidden 视图（不跳登录）", async () => {
    listMock.mockRejectedValue(new ApiError("forbidden", 403, "权限不足"));
    renderView(makeUser(["room:read"]));
    expect(await screen.findByText("无权限查看预订列表")).toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalledWith("/login");
  });

  it("分页：真实后端分页参数 + 翻页", async () => {
    listMock.mockImplementation((params?: { page?: number }) =>
      Promise.resolve(
        makePage(
          [makeReservation(params?.page ?? 1)],
          params?.page ?? 1,
          45,
        ),
      ),
    );
    renderView(makeUser(["reservation:read", "guest:read"]));
    expect(await screen.findByText("第 1 / 3 页 · 每页 20 条")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 2, page_size: 20 }),
      ),
    );
    expect(await screen.findByText("第 2 / 3 页 · 每页 20 条")).toBeInTheDocument();
  });

  it("筛选变化 → 传递后端查询参数并重置页码", async () => {
    listMock.mockResolvedValue(makePage([]));
    renderView(makeUser(["reservation:read", "guest:read"]));
    await screen.findByText("预订管理");
    const statusSelect = screen.getByLabelText("按状态筛选");
    await userEvent.selectOptions(statusSelect, "CANCELLED");
    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: "CANCELLED", page: 1 }),
      ),
    );
  });
});
