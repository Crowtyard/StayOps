/**
 * Dashboard InventoryAlertsOverview（Sprint 7 §45）测试：
 * - 低库存数 / 缺货数（inventory:read）+ 待审批申请数 / 待收货订单数（procurement:read）
 * - 权限门控：无对应权限不请求对应 API、不显示对应卡（不产生无权限错误）
 * - 加载失败 → 区块内错误提示（不阻塞房态区）
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import type { MeOut } from "@/lib/api/types";
import { businessDate } from "@/lib/booking";
import DashboardView from "@/components/dashboard-view";
import { UserContext } from "@/components/app-shell";

const {
  roomsListMock,
  reservationsListMock,
  staysListMock,
  hkListMock,
  invListItemsMock,
  prListRequestsMock,
  prListOrdersMock,
  dashboardRoomStatusMock,
} = vi.hoisted(() => ({
  roomsListMock: vi.fn(),
  reservationsListMock: vi.fn(),
  staysListMock: vi.fn(),
  hkListMock: vi.fn(),
  invListItemsMock: vi.fn(),
  prListRequestsMock: vi.fn(),
  prListOrdersMock: vi.fn(),
  dashboardRoomStatusMock: vi.fn(),
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
      dashboard: { roomStatus: dashboardRoomStatusMock },
      reservations: { list: reservationsListMock },
      stays: { list: staysListMock },
      housekeeping: { list: hkListMock },
      inventory: { listItems: invListItemsMock },
      procurement: {
        listRequests: prListRequestsMock,
        listOrders: prListOrdersMock,
      },
    },
  };
});

function makeUser(permissions: string[]): MeOut {
  return {
    id: 1,
    username: "manager",
    display_name: null,
    email: null,
    phone: null,
    is_active: true,
    created_at: "x",
    updated_at: "x",
    roles: [{ id: 2, name: "MANAGER" }],
    permissions,
  };
}

/** alpha.9.6 F2：房态概览改为按日期从后端取（前端不再自行计算房态）。 */
function emptyRoomStatus() {
  const today = businessDate();
  return {
    date: today,
    business_date: today,
    is_today: true,
    is_past: false,
    physical_status_authoritative: true,
    enabled_room_count: 0,
    disabled_room_count: 0,
    total_room_count: 0,
    counts: {
      available: 0,
      reserved: 0,
      occupied: 0,
      out_of_service: 0,
      total_enabled_rooms: 0,
      sellable_total: 0,
    },
    rooms: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  roomsListMock.mockResolvedValue({ items: [], total: 0, page: 1, page_size: 100 });
  dashboardRoomStatusMock.mockResolvedValue(emptyRoomStatus());
  reservationsListMock.mockResolvedValue({ items: [], total: 0, page: 1, page_size: 100 });
  staysListMock.mockResolvedValue({ items: [], total: 0, page: 1, page_size: 100 });
  hkListMock.mockResolvedValue({ items: [], total: 0, page: 1, page_size: 100 });
  invListItemsMock.mockResolvedValue({ items: [], total: 0, page: 1, page_size: 100 });
  prListRequestsMock.mockResolvedValue({ items: [], total: 0, page: 1, page_size: 100 });
  prListOrdersMock.mockResolvedValue({ items: [], total: 0, page: 1, page_size: 100 });
});

function renderDashboard(permissions: string[]) {
  return render(
    <UserContext.Provider value={makeUser(permissions)}>
      <DashboardView />
    </UserContext.Provider>,
  );
}

describe("Dashboard 库存与采购预警（Sprint 7 §45）", () => {
  it("MANAGER：低库存/缺货/待审批/待收货四卡计数", async () => {
    invListItemsMock.mockResolvedValue({
      items: [
        {
          id: 1,
          item_code: "A",
          name: "矿泉水",
          category: "GUEST_AMENITY",
          base_unit: "瓶",
          minimum_stock: "20",
          target_stock: "100",
          is_consumable: true,
          is_active: true,
          total_stock: "15",
          stock_status: "LOW_STOCK",
          recommended_replenishment: "85",
        },
        {
          id: 2,
          item_code: "B",
          name: "拖鞋",
          category: "GUEST_AMENITY",
          base_unit: "双",
          minimum_stock: "10",
          target_stock: "50",
          is_consumable: true,
          is_active: true,
          total_stock: "0",
          stock_status: "OUT_OF_STOCK",
          recommended_replenishment: "50",
        },
      ],
      total: 2,
      page: 1,
      page_size: 100,
    });
    prListRequestsMock.mockResolvedValue({
      items: [],
      total: 3,
      page: 1,
      page_size: 100,
    });
    prListOrdersMock.mockImplementation((params?: { status?: string }) =>
      Promise.resolve({
        items: [],
        total: params?.status === "ORDERED" ? 2 : 1,
        page: 1,
        page_size: 100,
      }),
    );

    renderDashboard([
      "room:read",
      "inventory:read",
      "procurement:read",
    ]);
    expect(await screen.findByText("库存与采购预警")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText("正在加载库存与采购数据…")).not.toBeInTheDocument(),
    );

    const heading = screen.getByText("库存与采购预警");
    const section = heading.closest("div.mt-6") as HTMLElement;
    const cardValue = (label: string): string | null => {
      const labelEl = within(section)
        .getAllByText(label)
        .find((el) => el.tagName === "P");
      const card = labelEl?.closest("div");
      if (!card) return null;
      const numbers = within(card as HTMLElement).queryAllByText(/^\d+$/);
      return numbers[0]?.textContent ?? null;
    };
    expect(cardValue("低库存")).toBe("1");
    expect(cardValue("缺货")).toBe("1");
    expect(cardValue("待审批申请")).toBe("3");
    expect(cardValue("待收货订单")).toBe("3"); // ORDERED 2 + PARTIALLY 1
  });

  it("只有 inventory:read：仅请求库存 API，仅显示低库存/缺货卡", async () => {
    renderDashboard(["room:read", "inventory:read"]);
    expect(await screen.findByText("库存与采购预警")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText("正在加载库存与采购数据…")).not.toBeInTheDocument(),
    );
    expect(invListItemsMock).toHaveBeenCalled();
    expect(prListRequestsMock).not.toHaveBeenCalled();
    expect(prListOrdersMock).not.toHaveBeenCalled();
    expect(screen.getByText("低库存")).toBeInTheDocument();
    expect(screen.getByText("缺货")).toBeInTheDocument();
    expect(screen.queryByText("待审批申请")).not.toBeInTheDocument();
    expect(screen.queryByText("待收货订单")).not.toBeInTheDocument();
  });

  it("只有 procurement:read：仅请求采购 API，仅显示待审批/待收货卡", async () => {
    renderDashboard(["room:read", "procurement:read"]);
    expect(await screen.findByText("库存与采购预警")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText("正在加载库存与采购数据…")).not.toBeInTheDocument(),
    );
    expect(invListItemsMock).not.toHaveBeenCalled();
    expect(prListRequestsMock).toHaveBeenCalled();
    expect(prListOrdersMock).toHaveBeenCalled();
    expect(screen.queryByText("低库存")).not.toBeInTheDocument();
    expect(screen.queryByText("缺货")).not.toBeInTheDocument();
    expect(screen.getByText("待审批申请")).toBeInTheDocument();
    expect(screen.getByText("待收货订单")).toBeInTheDocument();
  });

  it("两个权限都没有：不请求、不渲染区块", async () => {
    renderDashboard(["room:read"]);
    await screen.findByRole("heading", { name: /房态概览/ });
    expect(screen.queryByText("库存与采购预警")).not.toBeInTheDocument();
    expect(invListItemsMock).not.toHaveBeenCalled();
    expect(prListRequestsMock).not.toHaveBeenCalled();
    expect(prListOrdersMock).not.toHaveBeenCalled();
  });

  it("加载失败 → 区块内错误提示（不阻塞房态区）", async () => {
    invListItemsMock.mockRejectedValue(new Error("boom"));
    renderDashboard(["room:read", "inventory:read"]);
    expect(await screen.findByRole("heading", { name: /房态概览/ })).toBeInTheDocument();
    expect(
      await screen.findByText("库存/采购预警加载失败"),
    ).toBeInTheDocument();
  });
});
