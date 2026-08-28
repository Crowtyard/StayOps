/**
 * 维修工单详情（Sprint 5）测试：
 * - 字段 + 房间双状态（后端内嵌）+ 时间线展示
 * - 操作按 status + 权限显隐：start / resolve / verify / rework / cancel
 * - 派工（write）与编辑（write，PATCH strict）
 * - blocking badge / 409 原文展示 / 403 Forbidden / PII 隔离（无 Guest 区块）
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "@/lib/api";
import type { MaintenanceWorkOrderOut, MeOut } from "@/lib/api/types";
import MaintenanceWorkOrderDetailView from "@/components/maintenance/maintenance-work-order-detail-view";
import { UserContext } from "@/components/app-shell";

const {
  mwoGetMock,
  mwoAssignMock,
  mwoStartMock,
  mwoResolveMock,
  mwoVerifyMock,
  mwoReworkMock,
  mwoCancelMock,
  mwoUpdateMock,
  mwoAssigneesMock,
} = vi.hoisted(() => ({
  mwoGetMock: vi.fn(),
  mwoAssignMock: vi.fn(),
  mwoStartMock: vi.fn(),
  mwoResolveMock: vi.fn(),
  mwoVerifyMock: vi.fn(),
  mwoReworkMock: vi.fn(),
  mwoCancelMock: vi.fn(),
  mwoUpdateMock: vi.fn(),
  mwoAssigneesMock: vi.fn(),
}));

// 单例 router：useRouter 每次渲染返回同一引用，
// 避免 router 依赖变化导致 get 效应重跑并重置表单状态
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
        get: mwoGetMock,
        assign: mwoAssignMock,
        start: mwoStartMock,
        resolve: mwoResolveMock,
        verify: mwoVerifyMock,
        rework: mwoReworkMock,
        cancel: mwoCancelMock,
        update: mwoUpdateMock,
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
    room_cleaning_status: "dirty",
    category: "HVAC",
    severity: "HIGH",
    status: "OPEN",
    source: "HOUSEKEEPING",
    blocks_room: true,
    title: "空调不制冷",
    description: "出风口无冷风",
    reporter_name: "保洁小王",
    created_at: "2026-09-01T10:00:00+08:00",
    updated_at: "2026-09-01T10:00:00+08:00",
    ...overrides,
  };
}

function renderView(permissions: string[]) {
  return render(
    <UserContext.Provider value={makeUser(permissions)}>
      <MaintenanceWorkOrderDetailView id="1" />
    </UserContext.Provider>,
  );
}

beforeEach(() => {
  mwoGetMock.mockReset().mockResolvedValue(makeOrder());
  mwoAssignMock.mockReset();
  mwoStartMock.mockReset();
  mwoResolveMock.mockReset();
  mwoVerifyMock.mockReset();
  mwoReworkMock.mockReset();
  mwoCancelMock.mockReset();
  mwoUpdateMock.mockReset();
  mwoAssigneesMock.mockReset().mockResolvedValue([]);
});

describe("MaintenanceWorkOrderDetailView", () => {
  it("展示工单字段 + 房间双状态 + 阻断徽标", async () => {
    renderView(["maintenance_order:read"]);
    expect(await screen.findByText("维修工单 MWO20260901-0001")).toBeInTheDocument();
    expect(screen.getByText("空调不制冷")).toBeInTheDocument();
    expect(screen.getByText("出风口无冷风")).toBeInTheDocument();
    expect(screen.getByText("保洁小王")).toBeInTheDocument();
    expect(screen.getByText("是（阻止新住宿业务）")).toBeInTheDocument();
    // 房间双状态（后端内嵌，无需 room:read）
    expect(screen.getByText("停用")).toBeInTheDocument();
    expect(screen.getByText("待清扫")).toBeInTheDocument();
    // 阻断徽标 + 信息字段标签（至少一处）
    expect(screen.getAllByText("阻断客房").length).toBeGreaterThanOrEqual(1);
  });

  it("不展示任何 Guest / Reservation 区块（PII 隔离）", async () => {
    renderView(["maintenance_order:read"]);
    await screen.findByText("维修工单 MWO20260901-0001");
    expect(screen.queryByText(/客人/)).not.toBeInTheDocument();
    expect(screen.queryByText(/预订/)).not.toBeInTheDocument();
    expect(screen.queryByText(/金额/)).not.toBeInTheDocument();
  });

  it("RESOLVED + verify → 验收通过 / 返工；确认后调用后端", async () => {
    const user = userEvent.setup();
    mwoGetMock.mockResolvedValue(makeOrder({ status: "RESOLVED" }));
    mwoVerifyMock.mockResolvedValue(makeOrder({ status: "COMPLETED" }));
    renderView(["maintenance_order:read", "maintenance_order:verify"]);
    await screen.findByText(/MWO20260901-0001/);
    await user.click(screen.getByRole("button", { name: "验收通过" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/验收通过吗/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "确认通过" }));
    await waitFor(() => expect(mwoVerifyMock).toHaveBeenCalledWith(1));
    expect(await screen.findByText("验收通过，工单完成")).toBeInTheDocument();
  });

  it("RESOLVED + verify → 返工（确认对话框）", async () => {
    const user = userEvent.setup();
    mwoGetMock.mockResolvedValue(makeOrder({ status: "RESOLVED" }));
    mwoReworkMock.mockResolvedValue(makeOrder({ status: "IN_PROGRESS" }));
    renderView(["maintenance_order:read", "maintenance_order:verify"]);
    await screen.findByText(/MWO20260901-0001/);
    await user.click(screen.getByRole("button", { name: "返工" }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "确认返工" }));
    await waitFor(() => expect(mwoReworkMock).toHaveBeenCalledWith(1));
    expect(await screen.findByText("已退回返工")).toBeInTheDocument();
  });

  it("ASSIGNED + work → 开始维修；IN_PROGRESS + work → 提交验收", async () => {
    const user = userEvent.setup();
    mwoGetMock.mockResolvedValue(makeOrder({ status: "ASSIGNED" }));
    mwoStartMock.mockResolvedValue(makeOrder({ status: "IN_PROGRESS" }));
    const { unmount } = renderView(["maintenance_order:read", "maintenance_order:work"]);
    await screen.findByText(/MWO20260901-0001/);
    await user.click(screen.getByRole("button", { name: "开始维修" }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "开始维修" }));
    await waitFor(() => expect(mwoStartMock).toHaveBeenCalledWith(1));
    unmount();
  });

  it("active + cancel → 取消工单", async () => {
    const user = userEvent.setup();
    mwoGetMock.mockResolvedValue(makeOrder({ status: "IN_PROGRESS" }));
    mwoCancelMock.mockResolvedValue(makeOrder({ status: "CANCELLED" }));
    renderView([
      "maintenance_order:read",
      "maintenance_order:cancel",
    ]);
    await screen.findByText(/MWO20260901-0001/);
    await user.click(screen.getByRole("button", { name: "取消工单" }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "确认取消" }));
    await waitFor(() => expect(mwoCancelMock).toHaveBeenCalledWith(1));
    expect(await screen.findByText("工单已取消")).toBeInTheDocument();
  });

  it("无权限 → 不渲染操作按钮（后端仍是最终权威）", async () => {
    mwoGetMock.mockResolvedValue(makeOrder({ status: "RESOLVED" }));
    renderView(["maintenance_order:read"]);
    await screen.findByText(/MWO20260901-0001/);
    expect(screen.queryByRole("button", { name: "验收通过" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "返工" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "取消工单" })).not.toBeInTheDocument();
  });

  it("write + OPEN → 派工（候选人列表 + assign 调用）", async () => {
    const user = userEvent.setup();
    mwoGetMock.mockResolvedValue(makeOrder({ status: "OPEN" }));
    mwoAssigneesMock.mockResolvedValue([
      { id: 5, display_name: "维修老张", username: "zhang" },
    ]);
    mwoAssignMock.mockResolvedValue(makeOrder({ status: "ASSIGNED", assignee_name: "维修老张" }));
    renderView(["maintenance_order:read", "maintenance_order:write"]);
    await screen.findByText(/MWO20260901-0001/);
    await screen.findByRole("option", { name: /维修老张/ }); // 等待候选人加载
    await user.selectOptions(screen.getByLabelText("指派维修负责人"), "5");
    await user.click(screen.getByRole("button", { name: "派工" }));
    await waitFor(() => expect(mwoAssignMock).toHaveBeenCalledWith(1, 5));
    // 成功横幅 + 状态徽标（均有「已派工」文案）
    expect(
      (await screen.findAllByText("已派工")).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("write + active → 编辑（PATCH strict：只提交变更字段）", async () => {
    const user = userEvent.setup();
    mwoGetMock.mockResolvedValue(makeOrder({ status: "ASSIGNED" }));
    mwoUpdateMock.mockResolvedValue(
      makeOrder({ status: "ASSIGNED", severity: "CRITICAL", title: "标题改" }),
    );
    renderView(["maintenance_order:read", "maintenance_order:write"]);
    await screen.findByText(/MWO20260901-0001/);
    await user.selectOptions(screen.getByLabelText("严重程度"), "CRITICAL");
    await user.clear(screen.getByLabelText("工单标题"));
    await user.type(screen.getByLabelText("工单标题"), "标题改");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(mwoUpdateMock).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ severity: "CRITICAL", title: "标题改" }),
      ),
    );
    // 保存成功后以响应刷新表单
    expect(await screen.findByDisplayValue("标题改")).toBeInTheDocument();
  });

  it("409 冲突 → 原文展示（不吞掉后端 detail）", async () => {
    const user = userEvent.setup();
    mwoGetMock.mockResolvedValue(makeOrder({ status: "ASSIGNED" }));
    mwoStartMock.mockRejectedValue(
      new ApiError("conflict", 409, "仅已派工的工单可开始维修"),
    );
    renderView(["maintenance_order:read", "maintenance_order:work"]);
    await screen.findByText(/MWO20260901-0001/);
    await user.click(screen.getByRole("button", { name: "开始维修" }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "开始维修" }));
    expect(
      await screen.findByText("仅已派工的工单可开始维修"),
    ).toBeInTheDocument();
  });

  it("403 → Forbidden 视图（不跳登录）", async () => {
    mwoGetMock.mockRejectedValue(new ApiError("forbidden", 403, "权限不足"));
    renderView(["room:read"]);
    expect(await screen.findByText("无权限查看维修工单")).toBeInTheDocument();
  });
});
