/**
 * 保洁运营工作台（Sprint 3）测试：
 * - 状态筛选（真实后端查询参数）
 * - 快捷操作按 status + 权限显隐：PENDING 开始清扫 / IN_PROGRESS 提交验房 /
 *   INSPECTION 通过+返工（确认对话框）；取消需 confirm
 * - 409 冲突原文展示；403 Forbidden；新建任务（dirty 房间选择 + 创建）
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "@/lib/api";
import type { HousekeepingTaskOut, MeOut } from "@/lib/api/types";
import HousekeepingWorkspaceView from "@/components/housekeeping-workspace-view";
import { UserContext } from "@/components/app-shell";

const {
  hkListMock,
  hkStartMock,
  hkSubmitMock,
  hkPassMock,
  hkReworkMock,
  hkCancelMock,
  hkCreateMock,
  roomsListMock,
} = vi.hoisted(() => ({
  hkListMock: vi.fn(),
  hkStartMock: vi.fn(),
  hkSubmitMock: vi.fn(),
  hkPassMock: vi.fn(),
  hkReworkMock: vi.fn(),
  hkCancelMock: vi.fn(),
  hkCreateMock: vi.fn(),
  roomsListMock: vi.fn(),
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
      housekeeping: {
        list: hkListMock,
        start: hkStartMock,
        submitInspection: hkSubmitMock,
        pass: hkPassMock,
        rework: hkReworkMock,
        cancel: hkCancelMock,
        create: hkCreateMock,
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
    status: "PENDING",
    priority: "NORMAL",
    source: "CHECKOUT",
    created_at: "2026-08-27T10:00:00+08:00",
    updated_at: "2026-08-27T10:00:00+08:00",
    ...overrides,
  };
}

function renderView(permissions: string[]) {
  return render(
    <UserContext.Provider value={makeUser(permissions)}>
      <HousekeepingWorkspaceView />
    </UserContext.Provider>,
  );
}

const EMPTY_PAGE = { items: [], total: 0, page: 1, page_size: 20 };

beforeEach(() => {
  hkListMock.mockReset().mockResolvedValue(EMPTY_PAGE);
  hkStartMock.mockReset();
  hkSubmitMock.mockReset();
  hkPassMock.mockReset();
  hkReworkMock.mockReset();
  hkCancelMock.mockReset();
  hkCreateMock.mockReset();
  roomsListMock.mockReset().mockResolvedValue({ items: [], total: 0, page: 1, page_size: 100 });
});

describe("HousekeepingWorkspaceView", () => {
  it("加载任务列表并展示房间号/状态/优先级/保洁员", async () => {
    hkListMock.mockResolvedValue({
      items: [
        makeTask({ assignee_name: "保洁小王", status: "IN_PROGRESS" }),
        makeTask({ id: 2, task_no: "HKT20260827-0002", room_number: "209", status: "INSPECTION", priority: "URGENT" }),
      ],
      total: 2,
      page: 1,
      page_size: 20,
    });
    renderView([
      "housekeeping_task:read",
      "housekeeping_task:work",
      "housekeeping_task:inspect",
    ]);
    expect(await screen.findByText(/房间 210/)).toBeInTheDocument();
    expect(screen.getByText(/房间 209/)).toBeInTheDocument();

    // 状态徽标可能与页面副标题文案重复：按任务卡片作用域断言
    const card210 = screen.getByText(/房间 210/).closest("li") as HTMLElement;
    const card209 = screen.getByText(/房间 209/).closest("li") as HTMLElement;
    expect(within(card210).getByText("清扫中")).toBeInTheDocument();
    expect(within(card209).getByText("待验房")).toBeInTheDocument();
    expect(within(card209).getByText("加急")).toBeInTheDocument();
    expect(within(card210).getByText("保洁小王")).toBeInTheDocument();
    expect(within(card209).getByText("未指派")).toBeInTheDocument();
  });

  it("状态筛选触发真实后端查询参数", async () => {
    const user = userEvent.setup();
    renderView(["housekeeping_task:read"]);
    await screen.findByText("暂无保洁任务");
    await user.click(screen.getByRole("button", { name: "待验房" }));
    await waitFor(() => {
      expect(hkListMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: "INSPECTION" }),
      );
    });
  });

  it("PENDING + work → 开始清扫（一键，无确认框）；成功后刷新列表", async () => {
    const user = userEvent.setup();
    hkListMock.mockResolvedValue({
      items: [makeTask()],
      total: 1,
      page: 1,
      page_size: 20,
    });
    hkStartMock.mockResolvedValue(makeTask({ status: "IN_PROGRESS" }));
    renderView(["housekeeping_task:read", "housekeeping_task:work"]);
    await screen.findByText(/房间 210/);
    await user.click(screen.getByRole("button", { name: "开始清扫" }));
    await waitFor(() => expect(hkStartMock).toHaveBeenCalledWith(1));
    expect(
      await screen.findByText("房间 210 已开始清扫"),
    ).toBeInTheDocument();
    // 刷新列表被再次触发
    expect(hkListMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("IN_PROGRESS + work → 提交验房", async () => {
    const user = userEvent.setup();
    hkListMock.mockResolvedValue({
      items: [makeTask({ status: "IN_PROGRESS" })],
      total: 1,
      page: 1,
      page_size: 20,
    });
    hkSubmitMock.mockResolvedValue(makeTask({ status: "INSPECTION" }));
    renderView(["housekeeping_task:read", "housekeeping_task:work"]);
    await screen.findByText(/房间 210/);
    await user.click(screen.getByRole("button", { name: "提交验房" }));
    await waitFor(() => expect(hkSubmitMock).toHaveBeenCalledWith(1));
    expect(await screen.findByText("房间 210 已提交验房")).toBeInTheDocument();
  });

  it("REWORK + work → 开始清扫（返工后重新开始）", async () => {
    hkListMock.mockResolvedValue({
      items: [makeTask({ status: "REWORK" })],
      total: 1,
      page: 1,
      page_size: 20,
    });
    renderView(["housekeeping_task:read", "housekeeping_task:work"]);
    await screen.findByText(/房间 210/);
    expect(screen.getByRole("button", { name: "开始清扫" })).toBeInTheDocument();
  });

  it("INSPECTION + inspect → 通过 / 返工（确认对话框）", async () => {
    const user = userEvent.setup();
    hkListMock.mockResolvedValue({
      items: [makeTask({ status: "INSPECTION" })],
      total: 1,
      page: 1,
      page_size: 20,
    });
    hkPassMock.mockResolvedValue(makeTask({ status: "COMPLETED" }));
    hkReworkMock.mockResolvedValue(makeTask({ status: "REWORK" }));
    renderView([
      "housekeeping_task:read",
      "housekeeping_task:work",
      "housekeeping_task:inspect",
    ]);
    await screen.findByText(/房间 210/);

    await user.click(screen.getByRole("button", { name: "通过" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/验收通过吗/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "确认通过" }));
    await waitFor(() => expect(hkPassMock).toHaveBeenCalledWith(1));
    expect(
      await screen.findByText("房间 210 验收通过，翻房完成"),
    ).toBeInTheDocument();
  });

  it("无 work/inspect → 不渲染操作按钮（后端仍是最终权威）", async () => {
    hkListMock.mockResolvedValue({
      items: [makeTask()],
      total: 1,
      page: 1,
      page_size: 20,
    });
    renderView(["housekeeping_task:read"]);
    await screen.findByText(/房间 210/);
    // 作用域到任务卡片（筛选标签「返工」等与操作按钮同名，须区分上下文）
    const card = screen.getByText(/房间 210/).closest("li") as HTMLElement;
    expect(within(card).queryByRole("button", { name: "开始清扫" })).not.toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "通过" })).not.toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "返工" })).not.toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "取消" })).not.toBeInTheDocument();
  });

  it("409 冲突 → 原文展示（不吞掉后端 detail）", async () => {
    const user = userEvent.setup();
    hkListMock.mockResolvedValue({
      items: [makeTask()],
      total: 1,
      page: 1,
      page_size: 20,
    });
    hkStartMock.mockRejectedValue(
      new ApiError("conflict", 409, "仅待清扫或返工的任务可开始清扫"),
    );
    renderView(["housekeeping_task:read", "housekeeping_task:work"]);
    await screen.findByText(/房间 210/);
    await user.click(screen.getByRole("button", { name: "开始清扫" }));
    expect(
      await screen.findByText("仅待清扫或返工的任务可开始清扫"),
    ).toBeInTheDocument();
  });

  it("403 → Forbidden 视图（不跳登录）", async () => {
    hkListMock.mockRejectedValue(new ApiError("forbidden", 403, "权限不足"));
    renderView(["room:read"]);
    expect(await screen.findByText("无权限查看保洁任务")).toBeInTheDocument();
  });

  it("新建任务（write）：选择 dirty 房间 → 创建成功跳详情", async () => {
    const user = userEvent.setup();
    roomsListMock.mockResolvedValue({
      items: [
        {
          id: 12,
          room_number: "110",
          room_type_id: 1,
          floor: 1,
          occupancy_status: "available",
          cleaning_status: "dirty",
          notes: null,
          created_at: "x",
          updated_at: "x",
          room_type: { id: 1, name: "标准大床房" },
        },
      ],
      total: 1,
      page: 1,
      page_size: 100,
    });
    hkCreateMock.mockResolvedValue(makeTask({ id: 9, task_no: "HKT20260827-0009", room_number: "110" }));
    renderView([
      "housekeeping_task:read",
      "housekeeping_task:write",
    ]);
    await screen.findByText("暂无保洁任务");

    await user.click(screen.getByRole("button", { name: "新建任务" }));
    const dialog = screen.getByRole("dialog");
    await user.selectOptions(
      within(dialog).getByLabelText("选择待清扫房间"),
      "12",
    );
    await user.click(within(dialog).getByRole("button", { name: "创建" }));
    await waitFor(() =>
      expect(hkCreateMock).toHaveBeenCalledWith(
        expect.objectContaining({ room_id: 12, priority: "NORMAL" }),
      ),
    );
  });

  it("无 write → 不显示新建任务入口", async () => {
    renderView(["housekeeping_task:read"]);
    await screen.findByText("暂无保洁任务");
    expect(screen.queryByRole("button", { name: "新建任务" })).not.toBeInTheDocument();
  });
});
