/**
 * 现场报修表单（Sprint 5 §36/§37/§39）测试：
 * - 移动端友好表单：Room / Category / Severity / Blocks Room / Title / Description / Submit
 * - 预填：?room_id=&source=HOUSEKEEPING（保洁快捷报修）
 * - PRE_OPENING 来源可选（开业前整改）
 * - 提交创建后跳详情；校验提示；409 原文；无 write → Forbidden
 * - PII：表单不含任何 Guest 字段
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "@/lib/api";
import type { MeOut } from "@/lib/api/types";
import MaintenanceReportForm from "@/components/maintenance/report-form";
import { UserContext } from "@/components/app-shell";

const { mwoCreateMock, roomsListMock } = vi.hoisted(() => ({
  mwoCreateMock: vi.fn(),
  roomsListMock: vi.fn(),
}));

const replaceMock = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn(), refresh: vi.fn() }),
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
      maintenance: { create: mwoCreateMock },
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
    roles: [{ id: 2, name: "HOUSEKEEPING" }],
    permissions,
  };
}

function renderView(permissions: string[], prefill = {}) {
  return render(
    <UserContext.Provider value={makeUser(permissions)}>
      <MaintenanceReportForm prefill={prefill} />
    </UserContext.Provider>,
  );
}

beforeEach(() => {
  mwoCreateMock.mockReset();
  roomsListMock.mockReset().mockResolvedValue({
    items: [
      {
        id: 12,
        room_number: "110",
        room_type_id: 1,
        floor: 1,
        occupancy_status: "available",
        cleaning_status: "clean",
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
  replaceMock.mockReset();
});

describe("MaintenanceReportForm", () => {
  it("渲染现场报修字段：房间/分类/严重度/阻断/标题/描述/提交", async () => {
    renderView(["maintenance_order:write"]);
    expect(screen.getByRole("heading", { name: "现场报修" })).toBeInTheDocument();
    expect(screen.getByLabelText("报修房间")).toBeInTheDocument();
    expect(screen.getByLabelText("故障分类")).toBeInTheDocument();
    expect(screen.getByLabelText("阻断客房销售")).toBeInTheDocument();
    expect(screen.getByLabelText("报修来源")).toBeInTheDocument();
    expect(screen.getByLabelText("故障标题")).toBeInTheDocument();
    expect(screen.getByLabelText("故障描述")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "提交报修" })).toBeInTheDocument();
    // PII 隔离：无任何 Guest 相关字段
    expect(screen.queryByText(/客人/)).not.toBeInTheDocument();
  });

  it("预填 room_id + source=HOUSEKEEPING（保洁快捷报修）", async () => {
    const user = userEvent.setup();
    renderView(["maintenance_order:write"], {
      roomId: 12,
      source: "HOUSEKEEPING",
    });
    expect(await screen.findByLabelText("报修房间")).toHaveValue("12");
    expect(screen.getByLabelText("报修来源")).toHaveValue("HOUSEKEEPING");
    await user.type(screen.getByLabelText("故障标题"), "淋浴漏水");
    await user.click(screen.getByRole("button", { name: "提交报修" }));
    await waitFor(() =>
      expect(mwoCreateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          room_id: 12,
          source: "HOUSEKEEPING",
          title: "淋浴漏水",
        }),
      ),
    );
  });

  it("PRE_OPENING 来源可选并随提交上送（开业前整改清单）", async () => {
    const user = userEvent.setup();
    mwoCreateMock.mockResolvedValue({ id: 9, work_order_no: "MWO20260901-0009" });
    renderView(["maintenance_order:write"]);
    await screen.findByRole("option", { name: /110/ }); // 等待房间列表加载
    await user.selectOptions(screen.getByLabelText("报修房间"), "12");
    await user.selectOptions(screen.getByLabelText("报修来源"), "PRE_OPENING");
    await user.type(screen.getByLabelText("故障标题"), "开业前整改：插座松动");
    await user.click(screen.getByRole("button", { name: "提交报修" }));
    await waitFor(() =>
      expect(mwoCreateMock).toHaveBeenCalledWith(
        expect.objectContaining({ source: "PRE_OPENING" }),
      ),
    );
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/maintenance/9"));
  });

  it("blocks_room 勾选随提交上送（severity 与 blocks_room 独立）", async () => {
    const user = userEvent.setup();
    renderView(["maintenance_order:write"]);
    await screen.findByRole("option", { name: /110/ });
    await user.selectOptions(screen.getByLabelText("报修房间"), "12");
    await user.click(screen.getByLabelText("阻断客房销售"));
    await user.type(screen.getByLabelText("故障标题"), "空调故障");
    await user.click(screen.getByRole("button", { name: "提交报修" }));
    await waitFor(() =>
      expect(mwoCreateMock).toHaveBeenCalledWith(
        expect.objectContaining({ blocks_room: true, room_id: 12 }),
      ),
    );
  });

  it("未选房间 / 空标题 → 前端校验提示，不发请求", async () => {
    const user = userEvent.setup();
    renderView(["maintenance_order:write"]);
    await user.click(screen.getByRole("button", { name: "提交报修" }));
    expect(await screen.findByText("请选择房间")).toBeInTheDocument();
    await screen.findByRole("option", { name: /110/ });
    await user.selectOptions(screen.getByLabelText("报修房间"), "12");
    await user.click(screen.getByRole("button", { name: "提交报修" }));
    expect(await screen.findByText("请填写故障标题")).toBeInTheDocument();
    expect(mwoCreateMock).not.toHaveBeenCalled();
  });

  it("409 冲突 → 原文展示（后端最终权威）", async () => {
    const user = userEvent.setup();
    mwoCreateMock.mockRejectedValue(
      new ApiError("conflict", 409, "该房间存在进行中的阻断性维修工单"),
    );
    renderView(["maintenance_order:write"]);
    await screen.findByRole("option", { name: /110/ });
    await user.selectOptions(screen.getByLabelText("报修房间"), "12");
    await user.type(screen.getByLabelText("故障标题"), "重复报修");
    await user.click(screen.getByRole("button", { name: "提交报修" }));
    expect(
      await screen.findByText("该房间存在进行中的阻断性维修工单"),
    ).toBeInTheDocument();
  });

  it("无 maintenance_order:write → Forbidden", () => {
    renderView(["room:read"]);
    expect(
      screen.getByText("无权限报修（缺少 maintenance_order:write）"),
    ).toBeInTheDocument();
  });
});
