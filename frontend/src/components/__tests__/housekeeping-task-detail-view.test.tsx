/**
 * 保洁任务详情（Sprint 3）测试：
 * - 任务字段 + 房间现场状态（room:read）+ 操作时间线
 * - 操作按 status + 权限显隐；派单 / 优先级 / 备注编辑（仅提交变更字段）
 * - 403 / 404 语义；409 冲突原文展示
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "@/lib/api";
import type { HousekeepingTaskOut, MeOut, RoomOut } from "@/lib/api/types";
import HousekeepingTaskDetailView from "@/components/housekeeping-task-detail-view";
import { UserContext } from "@/components/app-shell";

const {
  hkGetMock,
  hkUpdateMock,
  hkPassMock,
  hkReworkMock,
  hkStartMock,
  roomsGetMock,
  assigneesMock,
} = vi.hoisted(() => ({
  hkGetMock: vi.fn(),
  hkUpdateMock: vi.fn(),
  hkPassMock: vi.fn(),
  hkReworkMock: vi.fn(),
  hkStartMock: vi.fn(),
  roomsGetMock: vi.fn(),
  assigneesMock: vi.fn(),
}));

const { routerMock } = vi.hoisted(() => ({
  routerMock: { replace: vi.fn(), push: vi.fn(), refresh: vi.fn() },
}));

vi.mock("next/navigation", () => ({
  // 单例 router：useRouter 每次渲染返回同一引用，
  // 否则 effect 依赖 [router] 会在每次渲染后重新触发并重置表单状态
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
      housekeeping: {
        get: hkGetMock,
        update: hkUpdateMock,
        pass: hkPassMock,
        rework: hkReworkMock,
        start: hkStartMock,
        assignees: assigneesMock,
      },
      rooms: { get: roomsGetMock },
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
    roles: [{ id: 2, name: "FRONT_DESK" }],
    permissions,
  };
}

function makeTask(
  overrides: Partial<HousekeepingTaskOut> = {},
): HousekeepingTaskOut {
  return {
    id: 1,
    task_no: "HKT20260827-0001",
    room_id: 10,
    room_number: "210",
    status: "INSPECTION",
    priority: "NORMAL",
    source: "CHECKOUT",
    started_at: "2026-08-27T09:00:00+08:00",
    submitted_for_inspection_at: "2026-08-27T09:40:00+08:00",
    created_at: "2026-08-27T08:30:00+08:00",
    updated_at: "2026-08-27T09:40:00+08:00",
    ...overrides,
  };
}

function makeRoom(): RoomOut {
  return {
    id: 10,
    room_number: "210",
    room_type_id: 1,
    floor: 2,
    occupancy_status: "available",
    cleaning_status: "inspection",
    notes: null,
    created_at: "x",
    updated_at: "x",
    room_type: { id: 1, name: "标准大床房" },
  };
}

function renderView(permissions: string[]) {
  return render(
    <UserContext.Provider value={makeUser(permissions)}>
      <HousekeepingTaskDetailView id="1" />
    </UserContext.Provider>,
  );
}

beforeEach(() => {
  hkGetMock.mockReset().mockResolvedValue(makeTask());
  hkUpdateMock.mockReset();
  hkPassMock.mockReset();
  hkReworkMock.mockReset();
  hkStartMock.mockReset();
  roomsGetMock.mockReset().mockResolvedValue(makeRoom());
  assigneesMock.mockReset().mockResolvedValue([]);
});

describe("HousekeepingTaskDetailView", () => {
  it("展示任务信息与房间现场状态（无 PII）", async () => {
    renderView(["housekeeping_task:read", "room:read"]);
    expect(
      await screen.findByText("保洁任务 HKT20260827-0001"),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/房间 210/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("待验房")).toBeInTheDocument();
    expect(screen.getByText("未指派")).toBeInTheDocument();
    // 房间现场状态在任务加载后异步拉取
    expect(await screen.findByText("房间现场状态")).toBeInTheDocument();
    // 不展示任何 Guest / Reservation 数据
    expect(screen.queryByText(/RSV/)).not.toBeInTheDocument();
    expect(screen.queryByText(/STY/)).not.toBeInTheDocument();
  });

  it("INSPECTION + inspect → 验收通过 / 返工按钮；确认后调用后端", async () => {
    const user = userEvent.setup();
    hkPassMock.mockResolvedValue(makeTask({ status: "COMPLETED" }));
    renderView(["housekeeping_task:read", "housekeeping_task:inspect"]);
    await screen.findByText("保洁任务 HKT20260827-0001");
    await user.click(screen.getByRole("button", { name: "验收通过" }));
    await user.click(screen.getByRole("button", { name: "确认通过" }));
    await waitFor(() => expect(hkPassMock).toHaveBeenCalledWith(1));
    expect(await screen.findByText("验收通过，翻房完成")).toBeInTheDocument();
  });

  it("PENDING + work → 开始清扫；无 work → 不渲染", async () => {
    hkGetMock.mockResolvedValue(makeTask({ status: "PENDING" }));
    const { unmount } = renderView([
      "housekeeping_task:read",
      "housekeeping_task:work",
    ]);
    await screen.findByText("保洁任务 HKT20260827-0001");
    expect(screen.getByRole("button", { name: "开始清扫" })).toBeInTheDocument();
    unmount();

    renderView(["housekeeping_task:read"]);
    await screen.findByText("保洁任务 HKT20260827-0001");
    expect(screen.queryByRole("button", { name: "开始清扫" })).not.toBeInTheDocument();
  });

  it("派单与调整：只提交变更字段（含取消派单显式 null）", async () => {
    const user = userEvent.setup();
    assigneesMock.mockResolvedValue([
      {
        id: 7,
        display_name: "保洁小王",
        username: "hk1",
      },
    ]);
    renderView([
      "housekeeping_task:read",
      "housekeeping_task:write",
    ]);
    await screen.findByText("保洁任务 HKT20260827-0001");

    // 等待派单候选用户异步加载完成
    await screen.findByRole("option", { name: /保洁小王/ });
    await user.selectOptions(screen.getByLabelText("指派保洁员"), "7");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(hkUpdateMock).toHaveBeenCalledWith(1, {
        assigned_to_user_id: 7,
      }),
    );
    // 未修改优先级/备注时不提交这些字段
    expect(hkUpdateMock.mock.calls[0][1]).not.toHaveProperty("priority");
    expect(hkUpdateMock.mock.calls[0][1]).not.toHaveProperty("notes");
  });

  it("无变更保存 → 提示且不发请求", async () => {
    const user = userEvent.setup();
    renderView([
      "housekeeping_task:read",
      "housekeeping_task:write",
    ]);
    await screen.findByText("保洁任务 HKT20260827-0001");
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText("没有需要保存的变更")).toBeInTheDocument();
    expect(hkUpdateMock).not.toHaveBeenCalled();
  });

  it("终态任务（COMPLETED）不提供操作与编辑", async () => {
    hkGetMock.mockResolvedValue(makeTask({ status: "COMPLETED" }));
    renderView([
      "housekeeping_task:read",
      "housekeeping_task:work",
      "housekeeping_task:inspect",
      "housekeeping_task:write",
      "housekeeping_task:cancel",
    ]);
    await screen.findByText("保洁任务 HKT20260827-0001");
    expect(screen.queryByRole("button", { name: "验收通过" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "取消任务" })).not.toBeInTheDocument();
    expect(screen.queryByText("派单与调整")).not.toBeInTheDocument();
  });

  it("409 冲突 → 原文展示", async () => {
    const user = userEvent.setup();
    hkPassMock.mockRejectedValue(
      new ApiError("conflict", 409, "仅待验房的任务可通过验收"),
    );
    renderView(["housekeeping_task:read", "housekeeping_task:inspect"]);
    await screen.findByText("保洁任务 HKT20260827-0001");
    await user.click(screen.getByRole("button", { name: "验收通过" }));
    await user.click(screen.getByRole("button", { name: "确认通过" }));
    expect(
      await screen.findByText("仅待验房的任务可通过验收"),
    ).toBeInTheDocument();
  });

  it("403 → Forbidden；404 → 友好提示", async () => {
    hkGetMock.mockRejectedValue(new ApiError("forbidden", 403, "权限不足"));
    const { unmount } = renderView(["room:read"]);
    expect(await screen.findByText("无权限查看保洁任务")).toBeInTheDocument();
    unmount();

    hkGetMock.mockRejectedValue(new ApiError("not_found", 404, "保洁任务不存在"));
    renderView(["housekeeping_task:read"]);
    expect(
      await screen.findByText("保洁任务不存在或已被删除"),
    ).toBeInTheDocument();
  });
});
