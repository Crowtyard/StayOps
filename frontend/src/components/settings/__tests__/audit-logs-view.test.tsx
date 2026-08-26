/**
 * 审计日志视图：
 * - 真实列表渲染（时间/操作人/Action/Resource/IP）
 * - details 展开/收起查看（格式化 JSON，不整块塞表格）
 * - 403 显示无权限且不跳登录；401 跳登录；网络错误可重试；空态
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { replaceMock, routerMock, listMock } = vi.hoisted(() => {
  const replaceMock = vi.fn();
  return {
    replaceMock,
    routerMock: { replace: replaceMock, refresh: vi.fn() },
    listMock: vi.fn(),
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      auditLogs: { list: listMock },
    },
  };
});

import { ApiError } from "@/lib/api";
import type { AuditLogOut } from "@/lib/api/types";
import AuditLogsView from "@/components/settings/audit-logs-view";

const LOGS: AuditLogOut[] = [
  {
    id: 2,
    user_id: 1,
    username: "admin",
    action: "room.status_change",
    resource_type: "room",
    resource_id: 1,
    details: {
      occupancy_status: { from: "available", to: "occupied" },
    },
    ip: "127.0.0.1",
    created_at: "2026-08-26T10:00:00Z",
  },
  {
    id: 1,
    user_id: 1,
    username: "admin",
    action: "login",
    resource_type: "auth",
    resource_id: 1,
    details: { username: "admin" },
    ip: "127.0.0.1",
    created_at: "2026-08-26T09:00:00Z",
  },
];

function pageOf(items: AuditLogOut[]) {
  return { items, total: items.length, page: 1, page_size: 100 };
}

beforeEach(() => {
  listMock.mockReset();
  replaceMock.mockClear();
});

describe("AuditLogsView", () => {
  it("渲染审计列表：时间/操作人/Action/Resource/IP", async () => {
    listMock.mockResolvedValue(pageOf(LOGS));
    render(<AuditLogsView />);
    expect(await screen.findByText("room.status_change")).toBeInTheDocument();
    expect(screen.getByText("房态变更")).toBeInTheDocument();
    expect(screen.getAllByText("admin").length).toBeGreaterThan(0);
    // “room”同时出现在表格资源列与资源类型筛选选项中
    expect(screen.getAllByText("room").length).toBeGreaterThan(0);
    expect(screen.getAllByText("#1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("127.0.0.1").length).toBeGreaterThan(0);
  });

  it("details 展开显示格式化 JSON，收起后隐藏（不整块塞表格）", async () => {
    listMock.mockResolvedValue(pageOf(LOGS));
    const user = userEvent.setup();
    render(<AuditLogsView />);
    await screen.findByText("room.status_change");

    // 表格单元格中不直接出现整块 JSON
    expect(screen.queryByText(/"occupancy_status"/)).not.toBeInTheDocument();

    const rows = screen.getAllByRole("row");
    const statusRow = rows.find((r) =>
      r.textContent?.includes("room.status_change"),
    );
    expect(statusRow).toBeDefined();
    const toggle = within(statusRow!).getByRole("button", { name: "详情" });
    await user.click(toggle);

    const pre = await screen.findByText(
      (_content, node) =>
        node?.tagName === "PRE" &&
        (node.textContent ?? "").includes('"occupancy_status"'),
    );
    expect(pre.textContent).toContain('"from": "available"');
    expect(pre.textContent).toContain('"to": "occupied"');

    await user.click(toggle);
    expect(screen.queryByText(/"occupancy_status"/)).not.toBeInTheDocument();
  });

  it("403 → 显示无权限，不跳转登录", async () => {
    listMock.mockRejectedValue(
      new ApiError("forbidden", 403, "无权限执行该操作"),
    );
    render(<AuditLogsView />);
    expect(await screen.findByText("无权限访问该页面")).toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalledWith("/login");
  });

  it("401 → 跳转 /login（登录失效与无权限区分）", async () => {
    listMock.mockRejectedValue(
      new ApiError("unauthorized", 401, "登录已失效"),
    );
    render(<AuditLogsView />);
    await screen.findByText("审计日志");
    expect(replaceMock).toHaveBeenCalledWith("/login");
  });

  it("网络错误 → 服务暂时不可用 + 重新加载成功", async () => {
    listMock.mockRejectedValueOnce(
      new ApiError("network", null, "服务暂时不可用，请稍后重试"),
    );
    listMock.mockResolvedValueOnce(pageOf(LOGS));
    const user = userEvent.setup();
    render(<AuditLogsView />);
    expect(
      await screen.findByText("服务暂时不可用，请稍后重试"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /重新加载/ }));
    expect(await screen.findByText("room.status_change")).toBeInTheDocument();
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it("空态 → 暂无审计记录", async () => {
    listMock.mockResolvedValue(pageOf([]));
    render(<AuditLogsView />);
    expect(await screen.findByText("暂无审计记录")).toBeInTheDocument();
  });

  it("按操作类型筛选 → 以 action 参数重新请求后端", async () => {
    listMock.mockResolvedValueOnce(pageOf(LOGS));
    const filtered = pageOf([LOGS[1]]);
    listMock.mockResolvedValueOnce(filtered);
    const user = userEvent.setup();
    render(<AuditLogsView />);
    await screen.findByText("room.status_change");

    const select = screen.getByLabelText("操作类型");
    await user.selectOptions(select, "login");
    expect(listMock).toHaveBeenLastCalledWith({
      page: 1,
      page_size: 100,
      action: "login",
      resource_type: undefined,
    });
    expect(await screen.findByText("login")).toBeInTheDocument();
  });

  it("按资源类型筛选 → 以 resource_type 参数重新请求后端", async () => {
    listMock.mockResolvedValueOnce(pageOf(LOGS));
    const filtered = pageOf([LOGS[0]]);
    listMock.mockResolvedValueOnce(filtered);
    const user = userEvent.setup();
    render(<AuditLogsView />);
    await screen.findByText("room.status_change");

    const select = screen.getByLabelText("资源类型");
    await user.selectOptions(select, "room");
    expect(listMock).toHaveBeenLastCalledWith({
      page: 1,
      page_size: 100,
      action: undefined,
      resource_type: "room",
    });
    expect(await screen.findByText("room.status_change")).toBeInTheDocument();
  });
});
