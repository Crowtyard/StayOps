/**
 * 维修运营工作台（Sprint 5）测试：
 * - 状态视图（真实后端查询参数）+ 阻断客房 / 今日完成（客户端组合）
 * - 筛选：分类 / 严重度 / 来源 / 阻断 / 负责人 + 搜索
 * - 快捷操作按 status + 权限显隐：OPEN 派工（需选择负责人）/
 *   ASSIGNED 开始维修 / IN_PROGRESS 提交验收 / RESOLVED 验收（确认对话框）
 * - blocking badge / PRE_OPENING 筛选 / 409 原文展示 / 403 Forbidden
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "@/lib/api";
import type { MaintenanceWorkOrderOut, MeOut } from "@/lib/api/types";
import MaintenanceWorkspaceView from "@/components/maintenance/maintenance-workspace-view";
import { UserContext } from "@/components/app-shell";

const {
  mwoListMock,
  mwoAssignMock,
  mwoStartMock,
  mwoResolveMock,
  mwoVerifyMock,
  mwoAssigneesMock,
} = vi.hoisted(() => ({
  mwoListMock: vi.fn(),
  mwoAssignMock: vi.fn(),
  mwoStartMock: vi.fn(),
  mwoResolveMock: vi.fn(),
  mwoVerifyMock: vi.fn(),
  mwoAssigneesMock: vi.fn(),
}));

// 单例 router：useRouter 每次渲染返回同一引用，
// 避免 router 依赖变化导致列表效应重复触发
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
      maintenance: {
        list: mwoListMock,
        assign: mwoAssignMock,
        start: mwoStartMock,
        resolve: mwoResolveMock,
        verify: mwoVerifyMock,
        assignees: mwoAssigneesMock,
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

function makeOrder(
  overrides: Partial<MaintenanceWorkOrderOut> = {},
): MaintenanceWorkOrderOut {
  return {
    id: 1,
    work_order_no: "MWO20260901-0001",
    room_id: 10,
    room_number: "210",
    room_occupancy_status: "out_of_service",
    room_cleaning_status: "clean",
    category: "HVAC",
    severity: "MEDIUM",
    status: "OPEN",
    source: "MANUAL",
    blocks_room: false,
    title: "空调不制冷",
    created_at: "2026-09-01T10:00:00+08:00",
    updated_at: "2026-09-01T10:00:00+08:00",
    ...overrides,
  };
}

function renderView(permissions: string[]) {
  return render(
    <UserContext.Provider value={makeUser(permissions)}>
      <MaintenanceWorkspaceView />
    </UserContext.Provider>,
  );
}

const EMPTY_PAGE = { items: [], total: 0, page: 1, page_size: 20 };

beforeEach(() => {
  mwoListMock.mockReset().mockResolvedValue(EMPTY_PAGE);
  mwoAssignMock.mockReset();
  mwoStartMock.mockReset();
  mwoResolveMock.mockReset();
  mwoVerifyMock.mockReset();
  mwoAssigneesMock.mockReset().mockResolvedValue([]);
});

describe("MaintenanceWorkspaceView", () => {
  it("加载工单列表并展示房间/状态/严重度/阻断徽标", async () => {
    mwoListMock.mockResolvedValue({
      items: [
        makeOrder({
          blocks_room: true,
          status: "IN_PROGRESS",
          severity: "CRITICAL",
          assignee_name: "维修老张",
        }),
      ],
      total: 1,
      page: 1,
      page_size: 20,
    });
    renderView(["maintenance_order:read"]);
    expect(await screen.findByText(/房间 210/)).toBeInTheDocument();
    const card = screen.getByText(/房间 210/).closest("li") as HTMLElement;
    expect(within(card).getByText("维修中")).toBeInTheDocument();
    expect(within(card).getByText("紧急")).toBeInTheDocument();
    expect(within(card).getByText("阻断客房")).toBeInTheDocument();
    expect(within(card).getByText("维修老张")).toBeInTheDocument();
    expect(within(card).getByText("空调不制冷")).toBeInTheDocument();
  });

  it("状态视图触发真实后端查询参数", async () => {
    const user = userEvent.setup();
    renderView(["maintenance_order:read"]);
    await screen.findByText("暂无维修工单");
    await user.click(screen.getByRole("button", { name: "维修中" }));
    await waitFor(() => {
      expect(mwoListMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: "IN_PROGRESS" }),
      );
    });
  });

  it("阻断客房视图查询 blocks_room=true 并只保留 Active 工单", async () => {
    const user = userEvent.setup();
    mwoListMock.mockResolvedValue({
      items: [
        makeOrder({
          id: 1,
          room_id: 10,
          room_number: "210",
          work_order_no: "MWO20260901-0001",
          blocks_room: true,
          status: "RESOLVED",
        }),
        makeOrder({
          id: 2,
          room_id: 11,
          room_number: "209",
          work_order_no: "MWO20260901-0002",
          blocks_room: true,
          status: "COMPLETED",
        }),
      ],
      total: 2,
      page: 1,
      page_size: 20,
    });
    renderView(["maintenance_order:read"]);
    await screen.findByText(/房间 210/);
    await user.click(screen.getByRole("button", { name: "阻断客房" }));
    await waitFor(() => {
      expect(mwoListMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ blocks_room: true }),
      );
    });
    // COMPLETED 不再阻断：客户端过滤后只剩 RESOLVED 一条
    expect(await screen.findByText(/房间 210/)).toBeInTheDocument();
    expect(screen.queryByText(/房间 209/)).not.toBeInTheDocument();
  });

  it("今日完成视图查询 COMPLETED 并按完成时间过滤", async () => {
    const user = userEvent.setup();
    mwoListMock.mockResolvedValue({
      items: [
        makeOrder({
          id: 1,
          status: "COMPLETED",
          completed_at: "2020-01-01T10:00:00+08:00",
        }),
      ],
      total: 1,
      page: 1,
      page_size: 20,
    });
    renderView(["maintenance_order:read"]);
    await screen.findByText(/房间 210/);
    await user.click(screen.getByRole("button", { name: "今日完成" }));
    await waitFor(() => {
      expect(mwoListMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: "COMPLETED" }),
      );
    });
    // 2020 年不是今天 → 过滤后为空
    expect(await screen.findByText(/当前没有/)).toBeInTheDocument();
  });

  it("筛选：分类 / 严重度 / 来源 / 阻断 / 负责人 / 搜索", async () => {
    const user = userEvent.setup();
    mwoAssigneesMock.mockResolvedValue([
      { id: 5, display_name: "维修老张", username: "zhang" },
    ]);
    renderView(["maintenance_order:read", "maintenance_order:write"]);
    await screen.findByText("暂无维修工单");

    await user.selectOptions(screen.getByLabelText("分类筛选"), "PLUMBING");
    await waitFor(() => {
      expect(mwoListMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ category: "PLUMBING" }),
      );
    });
    await user.selectOptions(screen.getByLabelText("严重度筛选"), "HIGH");
    await waitFor(() => {
      expect(mwoListMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ severity: "HIGH" }),
      );
    });
    await user.selectOptions(screen.getByLabelText("来源筛选"), "PRE_OPENING");
    await waitFor(() => {
      expect(mwoListMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ source: "PRE_OPENING" }),
      );
    });
    await user.selectOptions(screen.getByLabelText("阻断客房筛选"), "true");
    await waitFor(() => {
      expect(mwoListMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ blocks_room: true }),
      );
    });
    await screen.findByRole("option", { name: "维修老张" });
    await user.selectOptions(screen.getByLabelText("负责人筛选"), "5");
    await waitFor(() => {
      expect(mwoListMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ assigned_to: 5 }),
      );
    });

    await user.type(screen.getByLabelText("搜索工单"), "MWO2026");
    await user.click(screen.getByRole("button", { name: "搜索" }));
    await waitFor(() => {
      expect(mwoListMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ search: "MWO2026" }),
      );
    });
  });

  it("OPEN + write → 派工（未选负责人提示，选择后调 assign）", async () => {
    const user = userEvent.setup();
    mwoListMock.mockResolvedValue({
      items: [makeOrder({ status: "OPEN" })],
      total: 1,
      page: 1,
      page_size: 20,
    });
    mwoAssigneesMock.mockResolvedValue([
      { id: 5, display_name: "维修老张", username: "zhang" },
    ]);
    mwoAssignMock.mockResolvedValue(makeOrder({ status: "ASSIGNED" }));
    renderView(["maintenance_order:read", "maintenance_order:write"]);
    await screen.findByText(/房间 210/);

    // 未选负责人：提示不调用
    await user.click(screen.getByRole("button", { name: "派工" }));
    expect(
      await screen.findByText("请先在筛选行选择维修负责人，再点击派工"),
    ).toBeInTheDocument();
    expect(mwoAssignMock).not.toHaveBeenCalled();

    // 等待候选人下拉加载后再选择
    await screen.findByRole("option", { name: "维修老张" });
    await user.selectOptions(screen.getByLabelText("负责人筛选"), "5");
    await user.click(screen.getByRole("button", { name: "派工" }));
    await waitFor(() => expect(mwoAssignMock).toHaveBeenCalledWith(1, 5));
    expect(
      await screen.findByText("工单 MWO20260901-0001 已派工"),
    ).toBeInTheDocument();
  });

  it("ASSIGNED + work → 开始维修", async () => {
    const user = userEvent.setup();
    mwoListMock.mockResolvedValue({
      items: [makeOrder({ status: "ASSIGNED" })],
      total: 1,
      page: 1,
      page_size: 20,
    });
    mwoStartMock.mockResolvedValue(makeOrder({ status: "IN_PROGRESS" }));
    renderView(["maintenance_order:read", "maintenance_order:work"]);
    await screen.findByText(/房间 210/);
    await user.click(screen.getByRole("button", { name: "开始维修" }));
    await waitFor(() => expect(mwoStartMock).toHaveBeenCalledWith(1));
    expect(await screen.findByText("房间 210 已开始维修")).toBeInTheDocument();
  });

  it("IN_PROGRESS + work → 提交验收；RESOLVED + verify → 验收确认框", async () => {
    const user = userEvent.setup();
    mwoListMock.mockResolvedValue({
      items: [makeOrder({ status: "RESOLVED" })],
      total: 1,
      page: 1,
      page_size: 20,
    });
    mwoVerifyMock.mockResolvedValue(makeOrder({ status: "COMPLETED" }));
    renderView([
      "maintenance_order:read",
      "maintenance_order:work",
      "maintenance_order:verify",
    ]);
    await screen.findByText(/房间 210/);
    await user.click(screen.getByRole("button", { name: "验收通过" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/验收通过吗/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "确认通过" }));
    await waitFor(() => expect(mwoVerifyMock).toHaveBeenCalledWith(1));
    expect(
      await screen.findByText("房间 210 验收通过，工单完成"),
    ).toBeInTheDocument();
  });

  it("无对应权限 → 不渲染操作按钮（后端仍是最终权威）", async () => {
    mwoListMock.mockResolvedValue({
      items: [makeOrder({ status: "OPEN", blocks_room: true })],
      total: 1,
      page: 1,
      page_size: 20,
    });
    renderView(["maintenance_order:read"]);
    await screen.findByText(/房间 210/);
    const card = screen.getByText(/房间 210/).closest("li") as HTMLElement;
    expect(within(card).queryByRole("button", { name: "派工" })).not.toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "开始维修" })).not.toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "提交验收" })).not.toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "验收通过" })).not.toBeInTheDocument();
  });

  it("409 冲突 → 原文展示（不吞掉后端 detail）", async () => {
    const user = userEvent.setup();
    mwoListMock.mockResolvedValue({
      items: [makeOrder({ status: "ASSIGNED" })],
      total: 1,
      page: 1,
      page_size: 20,
    });
    mwoStartMock.mockRejectedValue(
      new ApiError("conflict", 409, "仅已派工的工单可开始维修"),
    );
    renderView(["maintenance_order:read", "maintenance_order:work"]);
    await screen.findByText(/房间 210/);
    await user.click(screen.getByRole("button", { name: "开始维修" }));
    expect(
      await screen.findByText("仅已派工的工单可开始维修"),
    ).toBeInTheDocument();
  });

  it("403 → Forbidden 视图（不跳登录）", async () => {
    mwoListMock.mockRejectedValue(new ApiError("forbidden", 403, "权限不足"));
    renderView(["room:read"]);
    expect(await screen.findByText("无权限查看维修工单")).toBeInTheDocument();
  });

  it("write → 现场报修入口；无 write → 不显示", async () => {
    const { unmount } = renderView([
      "maintenance_order:read",
      "maintenance_order:write",
    ]);
    await screen.findByText("暂无维修工单");
    expect(screen.getByRole("link", { name: "现场报修" })).toHaveAttribute(
      "href",
      "/maintenance/new",
    );
    unmount();

    renderView(["maintenance_order:read"]);
    await screen.findByText("暂无维修工单");
    expect(screen.queryByRole("link", { name: "现场报修" })).not.toBeInTheDocument();
  });
});
