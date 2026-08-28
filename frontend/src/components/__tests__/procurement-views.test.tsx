/**
 * 采购申请详情 + 采购订单详情（Sprint 7 §43/§44/§54）测试：
 * - PR 动作按 status + 权限显隐：submit（DRAFT）/ approve·reject（SUBMITTED）/
 *   cancel（DRAFT·APPROVED）/ 转订单（APPROVED）
 * - 非法转换 409 原文展示（前端不复制后端状态机）
 * - PO 状态展示：ordered / received / remaining / unit price / amount
 * - 收货表单：部分收货、剩余数量预填与超收拦截、一键按剩余收货
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "@/lib/api";
import type { MeOut, PurchaseOrderOut, PurchaseRequestOut } from "@/lib/api/types";
import RequestDetailView from "@/components/procurement/request-detail-view";
import OrderDetailView, {
  ReceiveGoodsModal,
} from "@/components/procurement/order-detail-view";
import { UserContext } from "@/components/app-shell";

const {
  getRequestMock,
  submitMock,
  approveMock,
  rejectMock,
  cancelRequestMock,
  getOrderMock,
  markOrderedMock,
  cancelOrderMock,
  receiveMock,
  listLocationsMock,
} = vi.hoisted(() => ({
  getRequestMock: vi.fn(),
  submitMock: vi.fn(),
  approveMock: vi.fn(),
  rejectMock: vi.fn(),
  cancelRequestMock: vi.fn(),
  getOrderMock: vi.fn(),
  markOrderedMock: vi.fn(),
  cancelOrderMock: vi.fn(),
  receiveMock: vi.fn(),
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
      procurement: {
        getRequest: getRequestMock,
        submitRequest: submitMock,
        approveRequest: approveMock,
        rejectRequest: rejectMock,
        cancelRequest: cancelRequestMock,
        getOrder: getOrderMock,
        markOrdered: markOrderedMock,
        cancelOrder: cancelOrderMock,
        receive: receiveMock,
      },
      inventory: { listLocations: listLocationsMock },
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

function makeRequest(overrides: Partial<PurchaseRequestOut> = {}): PurchaseRequestOut {
  return {
    id: 1,
    request_no: "PRQ20260828-0001",
    status: "SUBMITTED",
    requester_name: "前台小王",
    created_at: "2026-08-28T10:00:00+08:00",
    updated_at: "2026-08-28T10:00:00+08:00",
    lines: [
      {
        id: 1,
        item_id: 1,
        item_code: "AMEN-WATER-500",
        item_name: "矿泉水",
        base_unit: "瓶",
        quantity: "50",
      },
    ],
    ...overrides,
  };
}

function makeOrder(overrides: Partial<PurchaseOrderOut> = {}): PurchaseOrderOut {
  return {
    id: 1,
    order_no: "PO20260828-0001",
    supplier_id: 1,
    supplier_code: "SUP-001",
    supplier_name: "泉城日用品",
    status: "PARTIALLY_RECEIVED",
    order_total: "150",
    created_at: "2026-08-28T10:00:00+08:00",
    updated_at: "2026-08-28T10:00:00+08:00",
    lines: [
      {
        id: 11,
        item_id: 1,
        item_code: "AMEN-WATER-500",
        item_name: "矿泉水",
        base_unit: "瓶",
        ordered_quantity: "100",
        received_quantity: "60",
        remaining_quantity: "40",
        unit_price: "1.5",
        line_total: "150",
      },
    ],
    receipts: [
      {
        id: 1,
        receipt_no: "GR20260828-0001",
        purchase_order_id: 1,
        inventory_location_id: 1,
        inventory_location_name: "总仓",
        received_at: "2026-08-28T11:00:00+08:00",
        created_at: "2026-08-28T11:00:00+08:00",
        lines: [
          {
            id: 1,
            purchase_order_line_id: 11,
            item_id: 1,
            item_name: "矿泉水",
            received_quantity: "60",
          },
        ],
      },
    ],
    ...overrides,
  };
}

const MANAGER_PERMS = [
  "procurement:read",
  "procurement:request",
  "procurement:approve",
  "procurement:order",
  "procurement:receive",
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("RequestDetailView 采购申请详情（Sprint 7 §43）", () => {
  it("SUBMITTED：批准 / 驳回可见；提交·取消·转单不可见", async () => {
    getRequestMock.mockResolvedValue(makeRequest());
    render(
      <UserContext.Provider value={makeUser(MANAGER_PERMS)}>
        <RequestDetailView id="1" />
      </UserContext.Provider>,
    );
    await waitFor(() => {
      expect(screen.getByText("PRQ20260828-0001")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "批准" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "驳回" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "提交审批" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "转采购订单" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "取消申请" })).not.toBeInTheDocument();
    // 行数据与状态徽标
    expect(screen.getByText("矿泉水")).toBeInTheDocument();
    expect(screen.getByText("50")).toBeInTheDocument();
    expect(screen.getByText("待审批")).toBeInTheDocument();
  });

  it("DRAFT：仅提交与取消可见；无 approve 权限的用户看不到批准按钮", async () => {
    getRequestMock.mockResolvedValue(makeRequest({ status: "DRAFT" }));
    const { unmount } = render(
      <UserContext.Provider value={makeUser(MANAGER_PERMS)}>
        <RequestDetailView id="1" />
      </UserContext.Provider>,
    );
    await waitFor(() => {
      expect(screen.getByText("PRQ20260828-0001")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "提交审批" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消申请" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "批准" })).not.toBeInTheDocument();
    unmount();

    // FRONT_DESK（request 但无 approve）
    getRequestMock.mockResolvedValue(makeRequest());
    render(
      <UserContext.Provider
        value={makeUser(["procurement:read", "procurement:request"])}
      >
        <RequestDetailView id="1" />
      </UserContext.Provider>,
    );
    await waitFor(() => {
      expect(screen.getByText("PRQ20260828-0001")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "批准" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "驳回" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "转采购订单" })).not.toBeInTheDocument();
  });

  it("APPROVED：转采购订单可见；非法转换 409 原文展示", async () => {
    getRequestMock.mockResolvedValue(makeRequest({ status: "APPROVED" }));
    render(
      <UserContext.Provider value={makeUser(MANAGER_PERMS)}>
        <RequestDetailView id="1" />
      </UserContext.Provider>,
    );
    await waitFor(() => {
      expect(screen.getByText("PRQ20260828-0001")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "转采购订单" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消申请" })).toBeInTheDocument();
  });

  it("审批动作失败：后端 409 原文展示（不复制状态机）", async () => {
    getRequestMock.mockResolvedValue(makeRequest());
    approveMock.mockRejectedValue(
      new ApiError("conflict", 409, "仅已提交的采购申请可审批通过"),
    );
    render(
      <UserContext.Provider value={makeUser(MANAGER_PERMS)}>
        <RequestDetailView id="1" />
      </UserContext.Provider>,
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "批准" })).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole("button", { name: "批准" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "仅已提交的采购申请可审批通过",
    );
  });
});

describe("OrderDetailView 采购订单详情（Sprint 7 §44）", () => {
  it("PO 行显示 ordered/received/remaining/单价/金额 + 状态 + 收货记录", async () => {
    getOrderMock.mockResolvedValue(makeOrder());
    render(
      <UserContext.Provider value={makeUser(MANAGER_PERMS)}>
        <OrderDetailView id="1" />
      </UserContext.Provider>,
    );
    await waitFor(() => {
      expect(screen.getByText("PO20260828-0001")).toBeInTheDocument();
    });
    expect(screen.getByText("部分收货")).toBeInTheDocument();
    expect(screen.getByText("矿泉水")).toBeInTheDocument();
    expect(screen.getByText("100")).toBeInTheDocument(); // ordered
    expect(screen.getByText("60")).toBeInTheDocument(); // received
    expect(screen.getByText("40")).toBeInTheDocument(); // remaining
    expect(screen.getByText("¥1.5")).toBeInTheDocument(); // unit price
    // line total 与订单金额相同（150），出现两次
    expect(screen.getAllByText("¥150").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/收货记录（1）/)).toBeInTheDocument();
    expect(screen.getByText("GR20260828-0001")).toBeInTheDocument();
    // 动作：收货 + 取消剩余可见；下达不可见（PARTIALLY_RECEIVED）
    expect(screen.getByRole("button", { name: "收货入库" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消剩余收货" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "下达订单" })).not.toBeInTheDocument();
  });

  it("DRAFT：仅下达 / 取消；无 receive 权限（FRONT_DESK 有 receive 但无 order）", async () => {
    getOrderMock.mockResolvedValue(makeOrder({ status: "DRAFT", receipts: [] }));
    const { unmount } = render(
      <UserContext.Provider value={makeUser(MANAGER_PERMS)}>
        <OrderDetailView id="1" />
      </UserContext.Provider>,
    );
    await waitFor(() => {
      expect(screen.getByText("PO20260828-0001")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "下达订单" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消订单" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "收货入库" })).not.toBeInTheDocument();
    unmount();

    getOrderMock.mockResolvedValue(makeOrder());
    render(
      <UserContext.Provider
        value={makeUser(["procurement:read", "procurement:receive"])}
      >
        <OrderDetailView id="1" />
      </UserContext.Provider>,
    );
    await waitFor(() => {
      expect(screen.getByText("PO20260828-0001")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "收货入库" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "取消剩余收货" })).not.toBeInTheDocument();
  });
});

describe("ReceiveGoodsModal 收货表单（Sprint 7 §44 部分收货）", () => {
  beforeEach(() => {
    listLocationsMock.mockResolvedValue({
      items: [
        { id: 1, location_code: "MAIN_STORAGE", name: "总仓", is_active: true, created_at: "x", updated_at: "x" },
      ],
      total: 1,
      page: 1,
      page_size: 100,
    });
  });

  it("一键按剩余数量收货（部分收货）；剩余不足超收本地拦截", async () => {
    const onSuccess = vi.fn();
    const order = makeOrder();
    render(
      <ReceiveGoodsModal order={order} onClose={() => {}} onSuccess={onSuccess} />,
    );
    expect(screen.getByText(/剩余 40瓶/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "按剩余数量收货" }));
    expect(screen.getByLabelText("矿泉水 收货数量")).toHaveValue(40);

    // 超收（41 > 40）→ 本地拦截，不调用后端
    await userEvent.selectOptions(screen.getByLabelText("入库地点"), "1");
    await userEvent.clear(screen.getByLabelText("矿泉水 收货数量"));
    await userEvent.type(screen.getByLabelText("矿泉水 收货数量"), "41");
    await userEvent.click(screen.getByRole("button", { name: "确认收货" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("收货数量超过剩余可收数量");
    expect(receiveMock).not.toHaveBeenCalled();

    // 合法部分收货（30）→ 提交成功回调
    await userEvent.clear(screen.getByLabelText("矿泉水 收货数量"));
    await userEvent.type(screen.getByLabelText("矿泉水 收货数量"), "30");
    receiveMock.mockResolvedValue({ id: 2, receipt_no: "GR20260828-0002" });
    await userEvent.click(screen.getByRole("button", { name: "确认收货" }));
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalled();
    });
    expect(receiveMock).toHaveBeenCalledWith(1, {
      inventory_location_id: 1,
      lines: [{ purchase_order_line_id: 11, received_quantity: 30 }],
    });
  });

  it("后端 409（并发超收）原文展示", async () => {
    const order = makeOrder();
    render(
      <ReceiveGoodsModal order={order} onClose={() => {}} onSuccess={() => {}} />,
    );
    // 等待地点异步加载完成
    await screen.findByText("总仓");
    await userEvent.selectOptions(screen.getByLabelText("入库地点"), "1");
    await userEvent.type(screen.getByLabelText("矿泉水 收货数量"), "40");
    receiveMock.mockRejectedValue(
      new ApiError("conflict", 409, "收货数量超出剩余可收数量：矿泉水 剩余 0，本次收货 40"),
    );
    await userEvent.click(screen.getByRole("button", { name: "确认收货" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "收货数量超出剩余可收数量",
    );
  });
});
