/**
 * 房间详情：双维度状态修改、确认对话框（blocked/out_of_service）、
 * 非法转换显示后端 409 文案、按权限禁用维度、401 跳登录。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { replaceMock, getMock, changeStatusMock, routerMock } = vi.hoisted(
  () => {
    const replaceMock = vi.fn();
    return {
      replaceMock,
      getMock: vi.fn(),
      changeStatusMock: vi.fn(),
      // 稳定引用：RoomDetailView 的 useEffect 依赖 router，
      // 若每次渲染返回新对象会导致重复拉取并重置表单状态
      routerMock: { replace: replaceMock, refresh: vi.fn(), push: vi.fn() },
    };
  },
);

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
      rooms: { get: getMock, changeStatus: changeStatusMock },
    },
  };
});

import { ApiError } from "@/lib/api";
import type { MeOut, RoomOut } from "@/lib/api/types";
import RoomDetailView from "@/components/room-detail-view";
import { UserContext } from "@/components/app-shell";

const ROOM: RoomOut = {
  id: 1,
  room_number: "101",
  room_type_id: 1,
  floor: 1,
  occupancy_status: "available",
  cleaning_status: "clean",
  notes: null,
  created_at: "2026-08-25T09:00:00Z",
  updated_at: "2026-08-25T09:00:00Z",
  room_type: { id: 1, name: "标准大床房" },
};

function makeUser(permissions: string[]): MeOut {
  return {
    id: 1,
    username: "admin",
    display_name: null,
    email: null,
    phone: null,
    is_active: true,
    created_at: "x",
    updated_at: "x",
    roles: [{ id: 1, name: "SUPER_ADMIN" }],
    permissions,
  };
}

function renderDetail(user: MeOut) {
  return render(
    <UserContext.Provider value={user}>
      <RoomDetailView id="1" />
    </UserContext.Provider>,
  );
}

beforeEach(() => {
  getMock.mockReset();
  changeStatusMock.mockReset();
  replaceMock.mockClear();
});

describe("RoomDetailView 加载与展示", () => {
  it("加载房间并展示双维度状态（可售 + 干净）", async () => {
    getMock.mockResolvedValue(ROOM);
    renderDetail(makeUser(["room:read", "room:write"]));
    expect(await screen.findByText("房间 101")).toBeInTheDocument();
    expect(screen.getByText("标准大床房")).toBeInTheDocument();
    // 徽标与“当前状态”两处出现
    expect(screen.getAllByText("可售").length).toBeGreaterThan(0);
    expect(screen.getAllByText("干净").length).toBeGreaterThan(0);
  });

  it("加载失败（网络）→ 显示服务暂时不可用并可重新加载", async () => {
    getMock.mockRejectedValueOnce(
      new ApiError("network", null, "服务暂时不可用，请稍后重试"),
    );
    getMock.mockResolvedValueOnce(ROOM);
    const user = userEvent.setup();
    renderDetail(makeUser(["room:read"]));
    expect(
      await screen.findByText("服务暂时不可用，请稍后重试"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /重新加载/ }));
    expect(await screen.findByText("房间 101")).toBeInTheDocument();
  });

  it("401 → 跳转 /login", async () => {
    getMock.mockRejectedValue(new ApiError("unauthorized", 401, "登录已失效"));
    renderDetail(makeUser(["room:read"]));
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/login"));
  });

  it("404 → 显示房间不存在（无重试按钮）", async () => {
    getMock.mockRejectedValue(new ApiError("not_found", 404, "房间不存在"));
    renderDetail(makeUser(["room:read"]));
    expect(
      await screen.findByText("房间不存在或已被删除"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /重新加载/ }),
    ).not.toBeInTheDocument();
  });
});

describe("RoomDetailView 状态修改（真实后端状态机语义）", () => {
  it("合法占用状态修改成功 → 徽标与成功提示更新", async () => {
    getMock.mockResolvedValue(ROOM);
    changeStatusMock.mockResolvedValue({
      ...ROOM,
      occupancy_status: "occupied",
    });
    const user = userEvent.setup();
    renderDetail(makeUser(["room:read", "room:write"]));
    await screen.findByText("房间 101");

    const occupancyForm = screen.getByTestId("occupancy-status-form");
    await user.selectOptions(
      within(occupancyForm).getByLabelText("修改占用状态"),
      "occupied",
    );
    await user.click(
      within(occupancyForm).getByRole("button", { name: "应用" }),
    );

    expect(changeStatusMock).toHaveBeenCalledWith(1, {
      occupancy_status: "occupied",
    });
    // 徽标与“当前状态”两处出现“在住”
    await waitFor(() =>
      expect(screen.getAllByText("在住").length).toBeGreaterThan(0),
    );
    expect(
      screen.getByText(/占用状态已更新为「在住」/),
    ).toBeInTheDocument();
  });

  it("blocked / out_of_service 变更前弹确认框，确认后提交", async () => {
    getMock.mockResolvedValue(ROOM);
    changeStatusMock.mockResolvedValue({
      ...ROOM,
      occupancy_status: "blocked",
    });
    const user = userEvent.setup();
    renderDetail(makeUser(["room:read", "room:write"]));
    await screen.findByText("房间 101");

    const occupancyForm = screen.getByTestId("occupancy-status-form");
    await user.selectOptions(
      within(occupancyForm).getByLabelText("修改占用状态"),
      "blocked",
    );
    await user.click(
      within(occupancyForm).getByRole("button", { name: "应用" }),
    );

    // 确认框出现，未直接提交
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("确定要将占用状态变更为「锁房」吗？");
    expect(changeStatusMock).not.toHaveBeenCalled();

    // 取消 → 不提交
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(changeStatusMock).not.toHaveBeenCalled();

    // 再次触发并确认 → 提交
    await user.click(
      within(occupancyForm).getByRole("button", { name: "应用" }),
    );
    const dialog2 = await screen.findByRole("dialog");
    await user.click(
      within(dialog2).getByRole("button", { name: "确认变更" }),
    );
    expect(changeStatusMock).toHaveBeenCalledWith(1, {
      occupancy_status: "blocked",
    });
    await waitFor(() =>
      expect(screen.getAllByText("锁房").length).toBeGreaterThan(0),
    );
  });

  it("非法转换（409）→ 显示后端可读错误，页面不崩溃", async () => {
    getMock.mockResolvedValue({ ...ROOM, occupancy_status: "occupied" });
    changeStatusMock.mockRejectedValue(
      new ApiError(
        "conflict",
        409,
        "非法占用状态转换: occupied -> blocked",
      ),
    );
    const user = userEvent.setup();
    renderDetail(makeUser(["room:read", "room:write"]));
    await screen.findByText("房间 101");

    const occupancyForm = screen.getByTestId("occupancy-status-form");
    await user.selectOptions(
      within(occupancyForm).getByLabelText("修改占用状态"),
      "blocked",
    );
    await user.click(
      within(occupancyForm).getByRole("button", { name: "应用" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(
      within(dialog).getByRole("button", { name: "确认变更" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "非法占用状态转换: occupied -> blocked",
    );
  });

  it("HOUSEKEEPING：占用维度禁用、清洁维度可用", async () => {
    getMock.mockResolvedValue(ROOM);
    renderDetail(makeUser(["room:read", "room:status_cleaning"]));
    await screen.findByText("房间 101");

    expect(screen.getByTestId("occupancy-status-form")).toHaveTextContent(
      "无权限修改占用状态",
    );
    const cleaningForm = screen.getByTestId("cleaning-status-form");
    expect(
      within(cleaningForm).getByLabelText("修改清洁状态"),
    ).toBeInTheDocument();
  });

  it("MAINTENANCE：仅可把占用置为停用（out_of_service）", async () => {
    getMock.mockResolvedValue(ROOM);
    renderDetail(makeUser(["room:read", "room:status_maintenance"]));
    await screen.findByText("房间 101");

    const occupancyForm = screen.getByTestId("occupancy-status-form");
    const select = within(occupancyForm).getByLabelText(
      "修改占用状态",
    ) as HTMLSelectElement;
    const options = [...select.options].map((o) => o.value);
    expect(options).toContain("out_of_service");
    expect(options).not.toContain("occupied");
    // 清洁维度无权限
    expect(screen.getByTestId("cleaning-status-form")).toHaveTextContent(
      "无权限修改清洁状态",
    );
  });
});
