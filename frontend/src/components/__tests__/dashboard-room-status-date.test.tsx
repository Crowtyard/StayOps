/**
 * alpha.9.6 F2 首页房态概览「按日期显示」测试。
 *
 * 核心语义（后端权威）：
 * - 默认查询业务日期（今天）
 * - 前一天 / 后一天 / 今天 / 日期选择器都会以 date 参数重新查询
 * - 展示的是**某日房态**（可售/已预订/在住/维修停用），不是当前 rooms.occupancy_status
 * - 未来日期：physical_status_authoritative=false → 必须显式提示，且不显示
 *   当前物理/清洁状态（禁止用当前房态冒充未来房态）
 * - 点击分类卡片可钻取对应房间列表
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MeOut, RoomStatusOut } from "@/lib/api/types";
import { addDays, businessDate } from "@/lib/booking";
import DashboardView from "@/components/dashboard-view";
import { UserContext } from "@/components/app-shell";

const { roomStatusMock, reservationsListMock, staysListMock, replaceMock } =
  vi.hoisted(() => ({
    roomStatusMock: vi.fn(),
    reservationsListMock: vi.fn(),
    staysListMock: vi.fn(),
    replaceMock: vi.fn(),
  }));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      dashboard: { roomStatus: roomStatusMock },
      rooms: { list: vi.fn(), summary: vi.fn() },
      reservations: { list: reservationsListMock },
      stays: { list: staysListMock },
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

const TODAY = businessDate();

function makeUser(permissions: string[]): MeOut {
  return {
    id: 1,
    username: "fd",
    display_name: "前台",
    email: null,
    phone: null,
    is_active: true,
    created_at: "x",
    updated_at: "x",
    roles: [{ id: 2, name: "FRONT_DESK" }],
    permissions,
  };
}

function roomStatus(
  date: string,
  overrides: Partial<RoomStatusOut> = {},
): RoomStatusOut {
  const isToday = date === TODAY;
  const counts = {
    available: 26,
    reserved: 1,
    occupied: 1,
    out_of_service: 0,
    total_enabled_rooms: 28,
    sellable_total: 26,
    ...(overrides.counts ?? {}),
  };
  return {
    date,
    business_date: TODAY,
    is_today: isToday,
    is_past: date < TODAY,
    physical_status_authoritative: date <= TODAY,
    enabled_room_count: 28,
    disabled_room_count: 0,
    total_room_count: 28,
    rooms: [
      {
        room_id: 1,
        room_number: "101",
        room_name: null,
        floor: 1,
        is_active: true,
        room_type_id: 1,
        room_type_name: "标准大床房",
        status: "OCCUPIED",
        effective_occupancy_status: isToday ? "occupied" : null,
        current_cleaning_status: isToday ? "dirty" : null,
        arriving: false,
        stay_id: 9,
        stay_no: "STY20260916-0001",
        reservation_id: 5,
        check_in_date: date,
        planned_check_out_date: addDays(date, 2),
      },
      {
        room_id: 2,
        room_number: "102",
        room_name: "海景大床房",
        floor: 1,
        is_active: true,
        room_type_id: 1,
        room_type_name: "标准大床房",
        status: "RESERVED",
        effective_occupancy_status: isToday ? "available" : null,
        current_cleaning_status: isToday ? "clean" : null,
        arriving: true,
        stay_id: null,
        stay_no: null,
        reservation_id: 6,
        check_in_date: date,
        planned_check_out_date: addDays(date, 3),
      },
    ],
    counts,
    ...overrides,
  };
}

function renderView() {
  return render(
    <UserContext.Provider
      value={makeUser(["room:read", "reservation:read", "stay:read"])}
    >
      <DashboardView />
    </UserContext.Provider>,
  );
}

beforeEach(() => {
  roomStatusMock.mockReset();
  reservationsListMock.mockReset();
  staysListMock.mockReset();
  replaceMock.mockClear();
  roomStatusMock.mockImplementation((params?: { date?: string }) =>
    Promise.resolve(roomStatus(params?.date ?? TODAY)),
  );
  reservationsListMock.mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    page_size: 100,
  });
  staysListMock.mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    page_size: 100,
  });
});

describe("DashboardView 按日期房态（alpha.9.6 F2）", () => {
  it("默认查询业务日期（今天）并展示标题日期", async () => {
    renderView();
    expect(
      await screen.findByRole("heading", { name: `房态概览 · ${TODAY}` }),
    ).toBeInTheDocument();
    expect(roomStatusMock).toHaveBeenCalledWith({ date: TODAY });
  });

  it("展示某日房态四分类 + 启用/停用房间数（含分区合计）", async () => {
    renderView();
    const cards = await screen.findByRole("button", { name: /可售/ });
    expect(cards).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /已预订/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /在住/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /维修停用/ })).toBeInTheDocument();
    // 表头统计
    expect(screen.getByText("启用房间")).toBeInTheDocument();
    expect(screen.getByText("停用房间")).toBeInTheDocument();
    // 分区合计口径
    expect(
      screen.getByText(/合计 28 间（启用房间）= 总数 28 − 停用 0/),
    ).toBeInTheDocument();
  });

  it("后一天 / 前一天 / 今天 都会以 date 参数重新查询", async () => {
    renderView();
    await screen.findByRole("heading", { name: `房态概览 · ${TODAY}` });

    await userEvent.click(screen.getByRole("button", { name: "后一天" }));
    const tomorrow = addDays(TODAY, 1);
    await waitFor(() =>
      expect(roomStatusMock).toHaveBeenCalledWith({ date: tomorrow }),
    );

    await userEvent.click(screen.getByRole("button", { name: "前一天" }));
    await waitFor(() =>
      expect(roomStatusMock).toHaveBeenLastCalledWith({ date: TODAY }),
    );
  });

  it("日期选择器切换日期后重新查询", async () => {
    renderView();
    await screen.findByRole("heading", { name: `房态概览 · ${TODAY}` });
    const target = addDays(TODAY, 9);
    const input = screen.getByLabelText("房态日期") as HTMLInputElement;
    // date input 必须一次性设置完整值（逐字符输入不会形成合法日期）
    fireEvent.change(input, { target: { value: target } });
    await waitFor(() =>
      expect(roomStatusMock).toHaveBeenCalledWith({ date: target }),
    );
    expect(
      await screen.findByRole("heading", { name: `房态概览 · ${target}` }),
    ).toBeInTheDocument();
  });

  it("未来日期：显式提示物理房态不可用，且不显示当前清洁状态", async () => {
    const future = addDays(TODAY, 5);
    roomStatusMock.mockImplementation(() =>
      Promise.resolve(roomStatus(future)),
    );
    renderView();
    await screen.findByRole("heading", { name: `房态概览 · ${TODAY}` });
    await userEvent.click(screen.getByRole("button", { name: "后一天" }));
    // 连续点 4 次到未来第 5 天
    for (let i = 0; i < 4; i += 1) {
      await userEvent.click(screen.getByRole("button", { name: "后一天" }));
    }
    expect(
      await screen.findByText(/未来日期：物理房态仅供参考，以预订占用为准/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/未来日期：不显示当前物理\/清洁状态，仅显示预订占用/),
    ).toBeInTheDocument();
    // 清洁维度不推断未来
    expect(
      screen.getByText("清洁状态仅表示当天实况，历史 / 未来日期不推断"),
    ).toBeInTheDocument();
  });

  it("点击分类卡片钻取对应房间列表（到店日标记「今日到店」）", async () => {
    renderView();
    const reservedCard = await screen.findByRole("button", { name: /已预订/ });
    await userEvent.click(reservedCard);
    const panel = await screen.findByRole("heading", { name: /已预订（1 间）/ });
    expect(panel).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /102/ });
    expect(within(link).getByText("今日到店")).toBeInTheDocument();
  });

  it("在住房间钻取展示 stay_no；再点同一卡片收起", async () => {
    renderView();
    await userEvent.click(await screen.findByRole("button", { name: /在住/ }));
    expect(await screen.findByText("STY20260916-0001")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "收起" }));
    await waitFor(() =>
      expect(screen.queryByText("STY20260916-0001")).toBeNull(),
    );
  });

  it("今天按钮在已是今天时禁用", async () => {
    renderView();
    const todayButton = await screen.findByRole("button", { name: "今天" });
    expect(todayButton).toBeDisabled();
  });
});
