/**
 * 库存工作台（Sprint 7 §40）测试：
 * - 统计：总物资数 / 低库存 / 缺货 / 库存地点
 * - 表格行：code / name / 分类 / 总库存 / 单位 / 最低库存 / 状态徽标
 * - 筛选：search / category / 低库存 / 缺货
 * - 操作按钮按权限显隐（新建物资=item_manage、领用=issue、调拨=transfer、盘点=adjust）
 * - 无 inventory:read → Forbidden（后端 403 为最终权威）
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import type { InventoryItemListRow, MeOut } from "@/lib/api/types";
import InventoryWorkspaceView from "@/components/inventory/inventory-workspace-view";
import { UserContext } from "@/components/app-shell";

const { listItemsMock, listLocationsMock, roomsListMock } = vi.hoisted(() => ({
  listItemsMock: vi.fn(),
  listLocationsMock: vi.fn(),
  roomsListMock: vi.fn(),
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
        listItems: listItemsMock,
        listLocations: listLocationsMock,
      },
      rooms: { list: roomsListMock },
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

function makeRow(overrides: Partial<InventoryItemListRow> = {}): InventoryItemListRow {
  return {
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
    ...overrides,
  };
}

function renderView(permissions: string[]) {
  return render(
    <UserContext.Provider value={makeUser(permissions)}>
      <InventoryWorkspaceView />
    </UserContext.Provider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  listItemsMock.mockResolvedValue({
    items: [
      makeRow(),
      makeRow({
        id: 2,
        item_code: "CLEAN-DET-001",
        name: "清洁剂",
        category: "CLEANING",
        total_stock: "0",
        stock_status: "OUT_OF_STOCK",
        recommended_replenishment: "50",
      }),
      makeRow({
        id: 3,
        item_code: "OFFICE-PEN-001",
        name: "签字笔",
        category: "OFFICE",
        total_stock: "80",
        minimum_stock: "5",
        target_stock: "50",
        stock_status: "NORMAL",
        recommended_replenishment: "0",
      }),
    ],
    total: 3,
    page: 1,
    page_size: 100,
  });
  listLocationsMock.mockResolvedValue({
    items: [
      { id: 1, location_code: "MAIN_STORAGE", name: "总仓", is_active: true, created_at: "x", updated_at: "x" },
      { id: 2, location_code: "FRONT_DESK", name: "前台", is_active: true, created_at: "x", updated_at: "x" },
    ],
    total: 2,
    page: 1,
    page_size: 100,
  });
  roomsListMock.mockResolvedValue({ items: [], total: 0, page: 1, page_size: 100 });
});

describe("库存工作台（Sprint 7 §40）", () => {
  it("无 inventory:read → Forbidden", async () => {
    renderView(["procurement:read"]);
    await waitFor(() => {
      expect(screen.getByText(/无权限访问库存/)).toBeInTheDocument();
    });
    expect(listItemsMock).not.toHaveBeenCalled();
  });

  it("统计卡：总物资数 3 / 低库存 1 / 缺货 1 / 地点 2", async () => {
    renderView(["inventory:read"]);
    await waitFor(() => {
      expect(screen.getByTitle("全部物资档案数")).toBeInTheDocument();
    });
    // 统计卡带 title（与表格/筛选项的文本区分）
    expect(screen.getByTitle("全部物资档案数")).toHaveTextContent("3");
    expect(screen.getByTitle("总库存低于最低库存的物资数")).toHaveTextContent("1");
    expect(screen.getByTitle("总库存为 0 的物资数")).toHaveTextContent("1");
    expect(screen.getByTitle("库存地点数")).toHaveTextContent("2");
  });

  it("表格行显示 code/名称/分类/总库存/单位/最低库存/状态与建议补货", async () => {
    renderView(["inventory:read"]);
    await waitFor(() => {
      expect(screen.getByRole("link", { name: "AMEN-WATER-500" })).toBeInTheDocument();
    });
    const table = screen.getByRole("table");
    expect(within(table).getByText("矿泉水")).toBeInTheDocument();
    expect(within(table).getByText("客用品")).toBeInTheDocument();
    expect(within(table).getByText("低库存")).toBeInTheDocument();
    expect(within(table).getByText("缺货")).toBeInTheDocument();
    expect(within(table).getByText("正常")).toBeInTheDocument();
    expect(within(table).getByText(/建议补货 85/)).toBeInTheDocument();
  });

  it("搜索过滤：按 code/名称过滤", async () => {
    const userEvent = (await import("@testing-library/user-event")).default;
    renderView(["inventory:read"]);
    await waitFor(() => {
      expect(screen.getByText("矿泉水")).toBeInTheDocument();
    });
    await userEvent.type(screen.getByLabelText("搜索物资"), "清洁");
    expect(screen.getByText("清洁剂")).toBeInTheDocument();
    expect(screen.queryByText("矿泉水")).not.toBeInTheDocument();
  });

  it("低库存/缺货勾选过滤", async () => {
    const userEvent = (await import("@testing-library/user-event")).default;
    renderView(["inventory:read"]);
    await waitFor(() => {
      expect(screen.getByText("矿泉水")).toBeInTheDocument();
    });
    await userEvent.click(screen.getByLabelText("只看缺货"));
    expect(screen.getByText("清洁剂")).toBeInTheDocument();
    expect(screen.queryByText("矿泉水")).not.toBeInTheDocument();
    expect(screen.queryByText("签字笔")).not.toBeInTheDocument();
  });

  it("按钮按权限显隐：MANAGER 全显 / FRONT_DESK 仅领用 / FINANCE 无", async () => {
    const all = renderView([
      "inventory:read",
      "inventory:item_manage",
      "inventory:issue",
      "inventory:transfer",
      "inventory:adjust",
    ]);
    await waitFor(() => {
      expect(screen.getByText("总物资数")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "新建物资" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "领用" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "调拨" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "盘点" })).toBeInTheDocument();
    all.unmount();

    const front = renderView(["inventory:read", "inventory:issue"]);
    await waitFor(() => {
      expect(screen.getByText("总物资数")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "新建物资" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "领用" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "调拨" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "盘点" })).not.toBeInTheDocument();
    front.unmount();

    renderView(["inventory:read"]);
    await waitFor(() => {
      expect(screen.getByText("总物资数")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "新建物资" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "领用" })).not.toBeInTheDocument();
  });

  it("行点击进物资详情", async () => {
    renderView(["inventory:read"]);
    await waitFor(() => {
      expect(screen.getByRole("link", { name: "AMEN-WATER-500" })).toBeInTheDocument();
    });
    expect(screen.getByRole("link", { name: "AMEN-WATER-500" })).toHaveAttribute(
      "href",
      "/inventory/items/1",
    );
  });
});
