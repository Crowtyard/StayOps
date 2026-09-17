/**
 * 房态棋盘（RoomsView）：
 * - 28 间种子房全部渲染（真实总数提示）
 * - 双维度展示：reserved + dirty 组合正确显示两个徽标（文字 + 颜色）
 * - 占用/清洁/房型筛选走后端查询参数；楼层客户端过滤
 * - 401 跳登录；网络错误显示“服务暂时不可用”并可重新加载
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { replaceMock, roomsListMock, roomTypesListMock, roomsSummaryMock, routerMock } =
  vi.hoisted(() => {
    const replaceMock = vi.fn();
    return {
      replaceMock,
      roomsListMock: vi.fn(),
  roomsSummaryMock: vi.fn(),
      roomTypesListMock: vi.fn(),
      // 稳定引用：RoomsView 的 useEffect 依赖 router
      routerMock: { replace: replaceMock, refresh: vi.fn(), push: vi.fn() },
    };
  });

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
      rooms: {
        list: roomsListMock,
        summary: roomsSummaryMock,
        create: vi.fn(),
        patch: vi.fn(),
        disable: vi.fn(),
        enable: vi.fn(),
        remove: vi.fn(),
      },
      roomTypes: { list: roomTypesListMock },
    },
  };
});

import { ApiError } from "@/lib/api";
import type { RoomOut, RoomTypeOut } from "@/lib/api/types";
import RoomsView from "@/components/rooms-view";

const ROOM_TYPES: RoomTypeOut[] = [
  {
    id: 1,
    name: "标准大床房",
    base_price: "328.00",
    capacity: 2,
    description: null,
    created_at: "2026-08-25T09:00:00Z",
    updated_at: "2026-08-25T09:00:00Z",
    room_count: 8,
  },
];

function makeRoom(
  id: number,
  roomNumber: string,
  occupancy: RoomOut["occupancy_status"] = "available",
  cleaning: RoomOut["cleaning_status"] = "clean",
): RoomOut {
  return {
    id,
    room_number: roomNumber,
    name: null,
    is_active: true,
    room_type_id: 1,
    floor: Math.floor(id / 10),
    occupancy_status: occupancy,
    cleaning_status: cleaning,
    notes: null,
    created_at: "2026-08-25T09:00:00Z",
    updated_at: "2026-08-25T09:00:00Z",
    room_type: { id: 1, name: "标准大床房" },
  };
}

/** 28 间种子房（与后端种子一致：101-110 / 201-210 / 301-308）；
 *  101 = reserved + dirty（双维度组合），其余 available + clean */
function makeRooms(): RoomOut[] {
  const numbers = [
    ...Array.from({ length: 10 }, (_, i) => 101 + i),
    ...Array.from({ length: 10 }, (_, i) => 201 + i),
    ...Array.from({ length: 8 }, (_, i) => 301 + i),
  ];
  return numbers.map((number, i) =>
    makeRoom(
      i + 1,
      String(number),
      i === 0 ? "reserved" : "available",
      i === 0 ? "dirty" : "clean",
    ),
  );
}

function pageOf<T>(items: T[]) {
  return { items, total: items.length, page: 1, page_size: 100 };
}

beforeEach(() => {
  roomsListMock.mockReset();
  roomTypesListMock.mockReset();
  replaceMock.mockClear();
  // alpha.9.6 F1：房间数量统计来自后端 COUNT（GET /rooms/summary）
  roomsSummaryMock.mockReset().mockResolvedValue({
    total_count: 28,
    enabled_count: 28,
    disabled_count: 0,
  });
});

describe("RoomsView 房态棋盘", () => {
  it("渲染 28 间种子房（显示 28 / 28 间）", async () => {
    roomsListMock.mockResolvedValue(pageOf(makeRooms()));
    roomTypesListMock.mockResolvedValue(pageOf(ROOM_TYPES));
    render(<RoomsView />);
    expect(await screen.findByText("显示 28 / 28 间")).toBeInTheDocument();
    expect(screen.getAllByRole("link").length).toBe(28);
  });

  it("reserved + dirty 房间同时显示占用与清洁两个维度徽标", async () => {
    roomsListMock.mockResolvedValue(pageOf(makeRooms()));
    roomTypesListMock.mockResolvedValue(pageOf(ROOM_TYPES));
    render(<RoomsView />);
    await screen.findByText("显示 28 / 28 间");

    const card = screen
      .getAllByRole("listitem")
      .find((li) => li.textContent?.startsWith("101"));
    expect(card).toBeDefined();
    const withinCard = within(card!);
    expect(withinCard.getByText("已预订")).toBeInTheDocument();
    expect(withinCard.getByText("待清扫")).toBeInTheDocument();
    // 文字 + 颜色双通道：徽标类名含背景色 token
    expect(withinCard.getByText("已预订")).toHaveClass("bg-amber-100");
    expect(withinCard.getByText("待清扫")).toHaveClass("bg-amber-100");
  });

  it("占用状态筛选走后端查询参数（后端筛选优先）", async () => {
    roomsListMock.mockResolvedValue(pageOf(makeRooms()));
    roomTypesListMock.mockResolvedValue(pageOf(ROOM_TYPES));
    const user = userEvent.setup();
    render(<RoomsView />);
    await screen.findByText("显示 28 / 28 间");

    await user.click(screen.getByRole("button", { name: "已预订" }));
    await waitFor(() =>
      expect(roomsListMock).toHaveBeenCalledWith(
        expect.objectContaining({ occupancy_status: "reserved" }),
      ),
    );
  });

  it("房型筛选走后端查询参数", async () => {
    roomsListMock.mockResolvedValue(pageOf(makeRooms()));
    roomTypesListMock.mockResolvedValue(pageOf(ROOM_TYPES));
    const user = userEvent.setup();
    render(<RoomsView />);
    await screen.findByText("显示 28 / 28 间");

    // 两个下拉框：房型在前、楼层在后
    const roomTypeSelect = screen.getAllByRole("combobox")[0];
    await user.selectOptions(roomTypeSelect, "1");
    await waitFor(() =>
      expect(roomsListMock).toHaveBeenCalledWith(
        expect.objectContaining({ room_type_id: 1 }),
      ),
    );
  });

  it("401 → 跳转 /login", async () => {
    roomsListMock.mockRejectedValue(
      new ApiError("unauthorized", 401, "登录已失效"),
    );
    roomTypesListMock.mockRejectedValue(
      new ApiError("unauthorized", 401, "登录已失效"),
    );
    render(<RoomsView />);
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/login"));
  });

  it("网络错误 → 显示服务暂时不可用并可重新加载", async () => {
    roomsListMock.mockRejectedValueOnce(
      new ApiError("network", null, "服务暂时不可用，请稍后重试"),
    );
    roomsListMock.mockResolvedValueOnce(pageOf(makeRooms()));
    roomTypesListMock.mockResolvedValue(pageOf(ROOM_TYPES));
    const user = userEvent.setup();
    render(<RoomsView />);
    expect(
      await screen.findByText("服务暂时不可用，请稍后重试"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /重新加载/ }));
    expect(await screen.findByText("显示 28 / 28 间")).toBeInTheDocument();
  });
});
