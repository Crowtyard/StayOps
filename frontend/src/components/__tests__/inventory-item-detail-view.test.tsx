/**
 * 物资详情（Sprint 7 §41）测试：
 * - Item info / 总库存 / 最低 / 目标 / 建议补货 / 状态徽标
 * - 地点余额（含停用标记）+ 最近流水（type/quantity/location/operator/time）
 * - 期初库存 / 编辑按钮按 inventory:item_manage 显隐
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { InventoryItemDetailOut, MeOut } from "@/lib/api/types";
import InventoryItemDetailView from "@/components/inventory/inventory-item-detail-view";
import { UserContext } from "@/components/app-shell";

const { getItemMock, listLocationsMock } = vi.hoisted(() => ({
  getItemMock: vi.fn(),
  listLocationsMock: vi.fn(),
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
      inventory: {
        getItem: getItemMock,
        listLocations: listLocationsMock,
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

function makeDetail(): InventoryItemDetailOut {
  return {
    id: 1,
    item_code: "AMEN-WATER-500",
    name: "矿泉水",
    category: "GUEST_AMENITY",
    base_unit: "瓶",
    specification: "500ml",
    minimum_stock: "20",
    target_stock: "100",
    is_consumable: true,
    is_active: true,
    notes: null,
    created_at: "x",
    updated_at: "x",
    total_stock: "15",
    stock_status: "LOW_STOCK",
    recommended_replenishment: "85",
    balances: [
      {
        id: 1,
        item_id: 1,
        location_id: 1,
        location_code: "MAIN_STORAGE",
        location_name: "总仓",
        location_active: true,
        quantity: "10",
        updated_at: "x",
      },
      {
        id: 2,
        item_id: 1,
        location_id: 2,
        location_code: "OLD_ROOM",
        location_name: "旧仓库",
        location_active: false,
        quantity: "5",
        updated_at: "x",
      },
    ],
    recent_movements: [
      {
        id: 9,
        movement_no: "SMV20260828-0009",
        item_id: 1,
        location_id: 1,
        location_name: "总仓",
        movement_type: "ISSUE",
        quantity: "-3",
        reason: "领用",
        operator_name: "保洁小王",
        created_at: "2026-08-28T10:00:00+08:00",
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getItemMock.mockResolvedValue(makeDetail());
  listLocationsMock.mockResolvedValue({ items: [], total: 0, page: 1, page_size: 100 });
});

describe("InventoryItemDetailView 物资详情（Sprint 7 §41）", () => {
  it("信息 + 四卡 + 状态徽标 + 建议补货", async () => {
    render(
      <UserContext.Provider value={makeUser(["inventory:read"])}>
        <InventoryItemDetailView id="1" />
      </UserContext.Provider>,
    );
    await waitFor(() => {
      expect(screen.getByText("矿泉水")).toBeInTheDocument();
    });
    expect(screen.getByText(/AMEN-WATER-500/)).toBeInTheDocument();
    expect(screen.getByText("低库存")).toBeInTheDocument();
    expect(screen.getByText("总库存")).toBeInTheDocument();
    expect(screen.getByText("最低库存")).toBeInTheDocument();
    expect(screen.getByText("目标库存")).toBeInTheDocument();
    expect(screen.getByText("建议补货")).toBeInTheDocument();
  });

  it("地点余额（停用地点标记「库存仍计入总库存」）+ 最近流水（类型/数量/操作人）", async () => {
    render(
      <UserContext.Provider value={makeUser(["inventory:read"])}>
        <InventoryItemDetailView id="1" />
      </UserContext.Provider>,
    );
    await waitFor(() => {
      expect(screen.getByText("地点余额")).toBeInTheDocument();
    });
    expect(screen.getByText("总仓")).toBeInTheDocument();
    expect(screen.getByText("旧仓库")).toBeInTheDocument();
    expect(screen.getByText(/已停用，库存仍计入总库存/)).toBeInTheDocument();
    expect(screen.getByText("领用出库")).toBeInTheDocument();
    expect(screen.getByText("-3")).toBeInTheDocument();
    expect(screen.getByText("保洁小王")).toBeInTheDocument();
  });

  it("无 inventory:item_manage：期初库存 / 编辑按钮不显示", async () => {
    render(
      <UserContext.Provider value={makeUser(["inventory:read"])}>
        <InventoryItemDetailView id="1" />
      </UserContext.Provider>,
    );
    await waitFor(() => {
      expect(screen.getByText("矿泉水")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "设置期初库存" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "编辑物资" })).not.toBeInTheDocument();
  });

  it("有 inventory:item_manage：期初库存 / 编辑按钮显示", async () => {
    render(
      <UserContext.Provider
        value={makeUser(["inventory:read", "inventory:item_manage"])}
      >
        <InventoryItemDetailView id="1" />
      </UserContext.Provider>,
    );
    await waitFor(() => {
      expect(screen.getByText("矿泉水")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "设置期初库存" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "编辑物资" })).toBeInTheDocument();
  });

  it("无 inventory:read → Forbidden", async () => {
    render(
      <UserContext.Provider value={makeUser(["room:read"])}>
        <InventoryItemDetailView id="1" />
      </UserContext.Provider>,
    );
    await waitFor(() => {
      expect(screen.getByText(/无权限访问库存/)).toBeInTheDocument();
    });
    expect(getItemMock).not.toHaveBeenCalled();
  });
});
