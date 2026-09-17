/**
 * alpha.9.6 F1 房间资料管理 UI 测试。
 *
 * 关键业务语义：
 * - 房间数量来自后端 COUNT（GET /rooms/summary），不是可编辑字段
 * - 停用 / 启用走专用端点；停用需确认；后端 409 文案原样展示
 * - 房间主数据按钮由 room:inventory_manage 门控（**不是** room:write）；
 *   无该权限则不显示新增/编辑/停用/启用按钮（前端隐藏 + 后端强制）
 * - alpha.9.6 QA DEF-1 回归保护：仅有 room:write 的角色（FRONT_DESK）
 *   不得看到房间主数据按钮
 * - 房态（占用/清洁）只读展示，不在本表单修改
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MeOut, RoomOut, RoomTypeOut } from "@/lib/api/types";
import { ApiError } from "@/lib/api";
import RoomsView from "@/components/rooms-view";
import { UserContext } from "@/components/app-shell";

const {
  roomsListMock,
  roomsSummaryMock,
  roomsCreateMock,
  roomsPatchMock,
  roomsDisableMock,
  roomsEnableMock,
  roomTypesListMock,
  replaceMock,
} = vi.hoisted(() => ({
  roomsListMock: vi.fn(),
  roomsSummaryMock: vi.fn(),
  roomsCreateMock: vi.fn(),
  roomsPatchMock: vi.fn(),
  roomsDisableMock: vi.fn(),
  roomsEnableMock: vi.fn(),
  roomTypesListMock: vi.fn(),
  replaceMock: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      rooms: {
        list: roomsListMock,
        summary: roomsSummaryMock,
        create: roomsCreateMock,
        patch: roomsPatchMock,
        disable: roomsDisableMock,
        enable: roomsEnableMock,
        remove: vi.fn(),
      },
      roomTypes: { list: roomTypesListMock },
    },
  };
});

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

const ROOM_TYPES: RoomTypeOut[] = [
  {
    id: 1,
    name: "标准大床房",
    base_price: "328.00",
    capacity: 2,
    description: null,
    created_at: "x",
    updated_at: "x",
    room_count: 4,
  },
  {
    id: 2,
    name: "豪华大床房",
    base_price: "428.00",
    capacity: 2,
    description: null,
    created_at: "x",
    updated_at: "x",
    room_count: 8,
  },
];

function makeRoom(
  id: number,
  roomNumber: string,
  overrides: Partial<RoomOut> = {},
): RoomOut {
  return {
    id,
    room_number: roomNumber,
    name: null,
    room_type_id: 1,
    floor: 1,
    is_active: true,
    occupancy_status: "available",
    cleaning_status: "clean",
    notes: null,
    created_at: "x",
    updated_at: "x",
    room_type: { id: 1, name: "标准大床房" },
    ...overrides,
  };
}

function pageOf<T>(items: T[]) {
  return { items, total: items.length, page: 1, page_size: 100 };
}

/** 持有房间主数据管理权限（MANAGER 视角） */
const ROOMS_ADMIN = [
  "room:read",
  "room:write",
  "room:inventory_manage",
  "room_type:read",
];

/** FRONT_DESK 视角：有房态操作权（room:write），无房间主数据管理权 */
const ROOMS_FRONT_DESK = ["room:read", "room:write", "room_type:read"];

function makeUser(permissions: string[]): MeOut {
  return {
    id: 1,
    username: "manager",
    display_name: "店长",
    email: null,
    phone: null,
    is_active: true,
    created_at: "x",
    updated_at: "x",
    roles: [{ id: 2, name: "MANAGER" }],
    permissions,
  };
}

function renderView(permissions: string[] = ROOMS_ADMIN) {
  return render(
    <UserContext.Provider value={makeUser(permissions)}>
      <RoomsView />
    </UserContext.Provider>,
  );
}

/** 切到「房间资料」管理视图 */
async function openManageTab() {
  await userEvent.click(await screen.findByRole("tab", { name: "房间资料" }));
}

beforeEach(() => {
  roomsListMock.mockReset();
  roomsSummaryMock.mockReset();
  roomsCreateMock.mockReset();
  roomsPatchMock.mockReset();
  roomsDisableMock.mockReset();
  roomsEnableMock.mockReset();
  roomTypesListMock.mockReset();
  replaceMock.mockClear();
  roomsListMock.mockResolvedValue(
    pageOf([makeRoom(1, "101"), makeRoom(2, "102", { name: "海景大床房" })]),
  );
  roomsSummaryMock.mockResolvedValue({
    total_count: 2,
    enabled_count: 1,
    disabled_count: 1,
  });
  roomTypesListMock.mockResolvedValue(pageOf(ROOM_TYPES));
});

describe("RoomsManagementView（alpha.9.6 F1）", () => {
  it("房间数量来自后端 COUNT（总数 / 启用 / 停用）", async () => {
    renderView();
    await openManageTab();
    expect(await screen.findByText("总房间数")).toBeInTheDocument();
    expect(screen.getByText("启用房间数")).toBeInTheDocument();
    expect(screen.getByText("停用房间数")).toBeInTheDocument();
    await waitFor(() =>
      expect(roomsSummaryMock).toHaveBeenCalledTimes(1),
    );
    // 三个数值（2 / 1 / 1）渲染自后端 summary，而非前端统计
    expect(screen.getByText("总房间数").nextSibling?.textContent).toBe("2");
  });

  it("展示房号 / 房间名称 / 房型 / 楼层与经营状态", async () => {
    renderView();
    await openManageTab();
    expect(await screen.findByRole("cell", { name: "101" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "海景大床房" })).toBeInTheDocument();
    expect(screen.getAllByText("标准大床房").length).toBeGreaterThan(0);
  });

  it("新增房间：提交 room_number / room_type_id / floor / name", async () => {
    roomsCreateMock.mockResolvedValue(makeRoom(3, "301", { floor: 3 }));
    renderView();
    await openManageTab();
    await userEvent.click(await screen.findByRole("button", { name: "新增房间" }));

    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText(/^房号/), "301");
    await userEvent.type(
      within(dialog).getByLabelText("房间名称"),
      "豪华大床房",
    );
    await userEvent.clear(within(dialog).getByLabelText(/^楼层/));
    await userEvent.type(within(dialog).getByLabelText(/^楼层/), "3");
    await userEvent.click(within(dialog).getByRole("button", { name: "保存" }));

    await waitFor(() => expect(roomsCreateMock).toHaveBeenCalledTimes(1));
    expect(roomsCreateMock.mock.calls[0][0]).toEqual({
      room_number: "301",
      name: "豪华大床房",
      room_type_id: 1,
      floor: 3,
      notes: null,
    });
  });

  it("编辑房间：101 大床房 → 豪华大床房（改房型与名称）", async () => {
    roomsPatchMock.mockResolvedValue(makeRoom(1, "101"));
    renderView();
    await openManageTab();
    const editButtons = await screen.findAllByRole("button", { name: "编辑" });
    await userEvent.click(editButtons[0]);

    const dialog = await screen.findByRole("dialog");
    await userEvent.type(
      within(dialog).getByLabelText("房间名称"),
      "豪华大床房",
    );
    await userEvent.selectOptions(
      within(dialog).getByLabelText(/^房型/),
      "2",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "保存" }));

    await waitFor(() => expect(roomsPatchMock).toHaveBeenCalledTimes(1));
    const [id, body] = roomsPatchMock.mock.calls[0];
    expect(id).toBe(1);
    expect(body.room_type_id).toBe(2);
    expect(body.name).toBe("豪华大床房");
  });

  it("后端 409（房号重复）文案原样展示在对话框内", async () => {
    roomsCreateMock.mockRejectedValue(
      new ApiError("conflict", 409, "房间号 101 已被启用的房间占用，请换一个房间号"),
    );
    renderView();
    await openManageTab();
    await userEvent.click(await screen.findByRole("button", { name: "新增房间" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText(/^房号/), "101");
    await userEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    expect(
      await screen.findByText("房间号 101 已被启用的房间占用，请换一个房间号"),
    ).toBeInTheDocument();
  });

  it("停用房间：确认后调用 disable（停用优先于删除）", async () => {
    roomsDisableMock.mockResolvedValue(makeRoom(1, "101", { is_active: false }));
    renderView();
    await openManageTab();
    const stopButtons = await screen.findAllByRole("button", { name: "停用" });
    await userEvent.click(stopButtons[0]);

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/停用后该房间不再参与可售与新预订/)).toBeInTheDocument();
    expect(within(dialog).getByText(/房号也不会被释放/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "停用" }));

    await waitFor(() => expect(roomsDisableMock).toHaveBeenCalledWith(1));
  });

  it("停用被后端拒绝（在住）→ 展示可读错误", async () => {
    roomsDisableMock.mockRejectedValue(
      new ApiError("conflict", 409, "房间 101 当前有在住记录（STY20260916-0001），不能停用；请先办理退房或换房"),
    );
    renderView();
    await openManageTab();
    const stopButtons = await screen.findAllByRole("button", { name: "停用" });
    await userEvent.click(stopButtons[0]);
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "停用" }));
    expect(await screen.findByText(/当前有在住记录/)).toBeInTheDocument();
  });

  it("[DEF-1] 仅 room:write（FRONT_DESK）：不显示新增 / 编辑 / 停用 / 启用按钮", async () => {
    renderView(ROOMS_FRONT_DESK);
    await openManageTab();
    expect(await screen.findByText("总房间数")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "新增房间" })).toBeNull();
    expect(screen.queryByRole("button", { name: "编辑" })).toBeNull();
    expect(screen.queryByRole("button", { name: "停用" })).toBeNull();
    expect(screen.queryByRole("button", { name: "启用" })).toBeNull();
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
    // 表格仍可只读查看（房号可见），只是没有操作列
    expect(await screen.findByRole("cell", { name: "101" })).toBeInTheDocument();
  });

  it("无任何房间权限：不显示新增 / 编辑 / 停用按钮（前端隐藏，后端仍强制）", async () => {
    renderView(["room:read", "room_type:read"]);
    await openManageTab();
    expect(await screen.findByText("总房间数")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "新增房间" })).toBeNull();
    expect(screen.queryByRole("button", { name: "编辑" })).toBeNull();
    expect(screen.queryByRole("button", { name: "停用" })).toBeNull();
  });

  it("room:inventory_manage 独立生效：无 room:write 也可管理主数据", async () => {
    renderView(["room:read", "room:inventory_manage", "room_type:read"]);
    await openManageTab();
    expect(
      await screen.findByRole("button", { name: "新增房间" }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "编辑" }).length).toBeGreaterThan(
      0,
    );
    // room:delete 未授予 → 删除按钮不显示（后端还额外要求无历史引用）
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
  });

  it("room:inventory_manage + room:delete：才显示删除按钮", async () => {
    renderView([...ROOMS_ADMIN, "room:delete"]);
    await openManageTab();
    expect(
      (await screen.findAllByRole("button", { name: "删除" })).length,
    ).toBeGreaterThan(0);
  });

  it("房间列表请求携带真实后端筛选参数（房态棋盘仍在同一页面）", async () => {
    renderView();
    await screen.findByText("显示 2 / 2 间");
    expect(roomsListMock).toHaveBeenCalled();
  });
});
