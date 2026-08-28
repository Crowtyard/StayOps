/**
 * 采购工作台（Sprint 7 §42/§54）测试：
 * - 分区：低库存建议 / 待审批申请 / 已批准待转单 / 已下达待收货 / 部分收货
 * - 权限门控：无 inventory:read 不请求不显示低库存分区；
 *   无 procurement:read → Forbidden
 * - 低库存建议显示建议补货量（仅建议，不自动创建申请/订单）
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { MeOut } from "@/lib/api/types";
import ProcurementWorkbenchView from "@/components/procurement/procurement-workbench-view";
import { UserContext } from "@/components/app-shell";

const { listItemsMock, listRequestsMock, listOrdersMock } = vi.hoisted(() => ({
  listItemsMock: vi.fn(),
  listRequestsMock: vi.fn(),
  listOrdersMock: vi.fn(),
}));

const routerMock = vi.hoisted(() => ({
  replace: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
}));

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
      inventory: { listItems: listItemsMock },
      procurement: {
        listRequests: listRequestsMock,
        listOrders: listOrdersMock,
      },
    },
  };
});

function makeUser(permissions: string[]): MeOut {
  return {
    id: 1,
    username: "tester",
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

function renderView(permissions: string[]) {
  return render(
    <UserContext.Provider value={makeUser(permissions)}>
      <ProcurementWorkbenchView />
    </UserContext.Provider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  listItemsMock.mockResolvedValue({
    items: [
      {
        id: 1,
        item_code: "AMEN-WATER-500",
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
    ],
    total: 1,
    page: 1,
    page_size: 100,
  });
  listRequestsMock.mockImplementation((params?: { status?: string }) => {
    if (params?.status === "SUBMITTED") {
      return Promise.resolve({
        items: [
          {
            id: 1,
            request_no: "PRQ20260828-0001",
            status: "SUBMITTED",
            requester_name: "前台小王",
            created_at: "2026-08-28T10:00:00+08:00",
            updated_at: "2026-08-28T10:00:00+08:00",
            lines: [{ id: 1, item_id: 1, quantity: "50" }],
          },
        ],
        total: 1,
        page: 1,
        page_size: 100,
      });
    }
    return Promise.resolve({
      items: [
        {
          id: 2,
          request_no: "PRQ20260828-0002",
          status: "APPROVED",
          requester_name: "前台小王",
          created_at: "2026-08-28T10:00:00+08:00",
          updated_at: "2026-08-28T10:00:00+08:00",
          lines: [{ id: 2, item_id: 1, quantity: "80" }],
        },
      ],
      total: 1,
      page: 1,
      page_size: 100,
    });
  });
  listOrdersMock.mockImplementation((params?: { status?: string }) => {
    const orders =
      params?.status === "PARTIALLY_RECEIVED"
        ? [
            {
              id: 2,
              order_no: "PO20260828-0002",
              supplier_id: 1,
              supplier_name: "泉城日用品",
              status: "PARTIALLY_RECEIVED",
              order_total: "300",
              lines: [
                {
                  id: 2,
                  item_id: 1,
                  ordered_quantity: "100",
                  received_quantity: "60",
                  remaining_quantity: "40",
                },
              ],
              receipts: [],
            },
          ]
        : [
            {
              id: 1,
              order_no: "PO20260828-0001",
              supplier_id: 1,
              supplier_name: "泉城日用品",
              status: "ORDERED",
              order_total: "150",
              lines: [
                {
                  id: 1,
                  item_id: 1,
                  ordered_quantity: "50",
                  received_quantity: "0",
                  remaining_quantity: "50",
                },
              ],
              receipts: [],
            },
          ];
    return Promise.resolve({
      items: orders,
      total: orders.length,
      page: 1,
      page_size: 100,
    });
  });
});

describe("采购工作台（Sprint 7 §42）", () => {
  it("无 procurement:read → Forbidden 且不请求", async () => {
    renderView(["inventory:read"]);
    await waitFor(() => {
      expect(screen.getByText(/无权限访问采购/)).toBeInTheDocument();
    });
    expect(listRequestsMock).not.toHaveBeenCalled();
    expect(listOrdersMock).not.toHaveBeenCalled();
  });

  it("MANAGER：低库存建议 + 待审批 + 已批准 + 待收货 + 部分收货全分区", async () => {
    renderView([
      "inventory:read",
      "procurement:read",
      "procurement:request",
      "procurement:order",
      "procurement:supplier_manage",
    ]);
    await waitFor(() => {
      expect(screen.getByText("低库存建议")).toBeInTheDocument();
    });
    expect(screen.getByText("矿泉水")).toBeInTheDocument();
    expect(screen.getByText(/建议补货 85/)).toBeInTheDocument();
    expect(screen.getByText("PRQ20260828-0001")).toBeInTheDocument();
    expect(screen.getByText("PRQ20260828-0002")).toBeInTheDocument();
    expect(screen.getByText("PO20260828-0001")).toBeInTheDocument();
    expect(screen.getByText("PO20260828-0002")).toBeInTheDocument();
    expect(screen.getByText("部分收货")).toBeInTheDocument();
    // 快捷入口按权限显示
    expect(screen.getByRole("link", { name: "供应商管理" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "采购申请" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "采购订单" })).toBeInTheDocument();
  });

  it("无 inventory:read（FRONT_DESK 矩阵之外的角色）→ 不显示低库存建议分区", async () => {
    renderView(["procurement:read", "procurement:request"]);
    await waitFor(() => {
      expect(screen.getByText("待审批采购申请")).toBeInTheDocument();
    });
    expect(screen.queryByText("低库存建议")).not.toBeInTheDocument();
    expect(listItemsMock).not.toHaveBeenCalled();
  });

  it("低库存建议仅为建议：不自动创建采购申请/订单", async () => {
    renderView(["inventory:read", "procurement:read"]);
    await waitFor(() => {
      expect(screen.getByText("低库存建议")).toBeInTheDocument();
    });
    // 组件无任何创建调用（api.procurement.createRequest 未 mock 也不会被调用）
    expect(screen.getByRole("link", { name: /库存工作台/ })).toHaveAttribute(
      "href",
      "/inventory",
    );
  });
});
