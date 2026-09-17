/**
 * Front Desk Command Center 集成测试（组件级，API 全 mock）：
 * - 最低权限 room:read + reservation:read（不足 → Forbidden）
 * - Today Summary 计数与卡片点击 → 右侧 Drawer 列表（不跳离页面）
 * - Attention Center 三条规则 → 抽屉展示 + 下一步入口
 * - Reservation Drawer：字段完整 / clean 到店可 Check-in / dirty 到店显示
 *   「房间尚未准备完成」+ 保洁任务（Check-in 不作为主操作）/ 写操作后 targeted refetch
 * - Room Drawer：双状态 + current stay + active task + next reservation
 * - Search：房号 → Room Drawer；预订单号 → Reservation Drawer；PII 权限提示
 * - PII / 权限：无 guest:read 不显示姓名；无 reservation:cancel 不显示取消
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import FrontDeskView from "@/components/front-desk/front-desk-view";
import { UserContext } from "@/components/app-shell";
import { addDays, businessDate } from "@/lib/booking";
import type {
  HousekeepingTaskOut,
  MeOut,
  ReservationOut,
  RoomOut,
  StayOut,
} from "@/lib/api/types";

const {
  roomsListMock,
  channelsListMock,
  reservationsListMock,
  staysListMock,
  tasksListMock,
  reservationsGetMock,
  reservationsCheckInMock,
  reservationsCancelMock,
  reservationsNoShowMock,
} = vi.hoisted(() => ({
  roomsListMock: vi.fn(),
  channelsListMock: vi.fn(),
  reservationsListMock: vi.fn(),
  staysListMock: vi.fn(),
  tasksListMock: vi.fn(),
  reservationsGetMock: vi.fn(),
  reservationsCheckInMock: vi.fn(),
  reservationsCancelMock: vi.fn(),
  reservationsNoShowMock: vi.fn(),
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
      rooms: { list: roomsListMock, get: vi.fn() },
      reservations: {
        list: reservationsListMock,
        get: reservationsGetMock,
        checkIn: reservationsCheckInMock,
        cancel: reservationsCancelMock,
        noShow: reservationsNoShowMock,
        create: vi.fn(),
        update: vi.fn(),
      },
      stays: { list: staysListMock },
      housekeeping: { list: tasksListMock },
      roomTypes: { list: vi.fn() },
      // alpha.9.6 F3：前台创建预订需要读取渠道
      channels: { list: channelsListMock },
    },
  };
});

const TODAY = businessDate();

const PERMISSIONS = [
  "room:read",
  "room_type:read",
  "reservation:read",
  "reservation:write",
  "reservation:cancel",
  "reservation:no_show",
  "guest:read",
  "guest:write",
  "stay:read",
  "stay:check_in",
  "stay:check_out",
  "housekeeping_task:read",
  "housekeeping_task:write",
  // alpha.9.6 F3：来源渠道（前台创建预订需要读取渠道）
  "channel:read",
];

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

function makeRoom(
  roomNumber: string,
  overrides: Partial<RoomOut> = {},
): RoomOut {
  return {
    id: Number(roomNumber),
    room_number: roomNumber,
    name: null,
    is_active: true,
    room_type_id: 3,
    floor: Number(roomNumber[0]),
    occupancy_status: "available",
    cleaning_status: "clean",
    notes: null,
    created_at: "x",
    updated_at: "x",
    room_type: { id: 3, name: "豪华大床房" },
    ...overrides,
  };
}

function makeReservation(
  checkIn: string,
  overrides: Partial<ReservationOut> = {},
): ReservationOut {
  return {
    id: 1,
    reservation_no: "RSV-FDV-0001",
    guest_id: 7,
    guest_name: "张先生",
    room_id: 101,
    room_number: "101",
    room_type_id: 3,
    room_type_name: "豪华大床房",
    check_in_date: checkIn,
    check_out_date: addDays(checkIn, 2),
    status: "CONFIRMED",
    source: "DIRECT",
    agreed_total_amount: "428.00",
    currency: "CNY",
    ...overrides,
  };
}

function makeStay(
  plannedOut: string,
  overrides: Partial<StayOut> = {},
): StayOut {
  return {
    id: 21,
    stay_no: "STY-FDV-0021",
    reservation_id: 11,
    room_id: 104,
    room_number: "104",
    status: "ACTIVE",
    actual_check_in_at: "x",
    planned_check_out_date: plannedOut,
    ...overrides,
  };
}

const PAGE = (items: unknown[]) => ({
  items,
  total: items.length,
  page: 1,
  page_size: 100,
});

/** 场景：101 干净今日到店；102 脏房今日到店（Rule A）；103 blocked 未来预订（Rule C）；
 *  104 超期在住（Rule B）。 */
function defaultData() {
  const rooms = [
    makeRoom("101"),
    makeRoom("102", { cleaning_status: "dirty" }),
    makeRoom("103", { occupancy_status: "blocked" }),
    makeRoom("104", { occupancy_status: "occupied", cleaning_status: "dirty" }),
  ];
  const reservations = [
    makeReservation(TODAY, { id: 1, room_id: 101, room_number: "101" }),
    makeReservation(TODAY, {
      id: 2,
      reservation_no: "RSV-FDV-0002",
      guest_id: 8,
      room_id: 102,
      room_number: "102",
    }),
    makeReservation(addDays(TODAY, 4), {
      id: 3,
      reservation_no: "RSV-FDV-0003",
      guest_id: 9,
      room_id: 103,
      room_number: "103",
    }),
  ];
  const stays = [makeStay(addDays(TODAY, -1))];
  const tasks: HousekeepingTaskOut[] = [
    {
      id: 31,
      task_no: "HKT-FDV-0031",
      room_id: 102,
      room_number: "102",
      status: "IN_PROGRESS",
      priority: "URGENT",
      source: "CHECKOUT",
      assigned_to_user_id: 5,
      assignee_name: "保洁员甲",
    },
  ];
  return { rooms, reservations, stays, tasks };
}

function renderView(permissions: string[] = PERMISSIONS) {
  const user = makeUser(permissions);
  return render(
    <UserContext.Provider value={user}>
      <FrontDeskView />
    </UserContext.Provider>,
  );
}

/** 等待数据就绪（desktop/mobile 双树同时渲染，用唯一 data 属性判断）。 */
async function ready() {
  await waitFor(() =>
    expect(
      document.querySelector('[data-summary-card="attention"]'),
    ).not.toBeNull(),
  );
}

beforeEach(() => {
  const d = defaultData();
  roomsListMock.mockReset().mockResolvedValue(PAGE(d.rooms));
  channelsListMock.mockReset().mockResolvedValue({
    items: [
      {
        id: 11,
        code: "SYS_MEITUAN",
        name: "美团",
        category: "OTA",
        enabled: true,
        is_system: true,
        sort_order: 10,
        created_at: "x",
        updated_at: "x",
      },
    ],
    total: 1,
    page: 1,
    page_size: 100,
  });
  reservationsListMock.mockReset().mockImplementation(
    (params: Record<string, unknown>) => {
      if (params.room_id !== undefined) {
        return Promise.resolve(
          PAGE(d.reservations.filter((r) => r.room_id === params.room_id)),
        );
      }
      if (params.search !== undefined) {
        return Promise.resolve(
          PAGE(
            d.reservations.filter(
              (r) =>
                r.reservation_no.includes(String(params.search)) ||
                (r.guest_name ?? "").includes(String(params.search)),
            ),
          ),
        );
      }
      return Promise.resolve(PAGE(d.reservations));
    },
  );
  staysListMock.mockReset().mockResolvedValue(PAGE(d.stays));
  tasksListMock.mockReset().mockResolvedValue(PAGE(d.tasks));
  reservationsGetMock.mockReset().mockResolvedValue(d.reservations[0]);
  reservationsCheckInMock.mockReset().mockResolvedValue({
    reservation: {
      ...d.reservations[0],
      status: "CHECKED_IN",
      stay_id: 21,
    },
    stay: d.stays[0],
  });
  reservationsCancelMock.mockReset().mockResolvedValue({
    ...d.reservations[0],
    status: "CANCELLED",
  });
  reservationsNoShowMock.mockReset().mockResolvedValue({
    ...d.reservations[0],
    status: "NO_SHOW",
  });
});

describe("权限门控", () => {
  it("缺 reservation:read（仅 room:read）→ Forbidden", async () => {
    renderView(["room:read"]);
    await waitFor(() =>
      expect(screen.getByText(/无权限访问前台工作台/)).toBeInTheDocument(),
    );
  });

  it("缺 room:read（仅 reservation:read）→ Forbidden", async () => {
    renderView(["reservation:read"]);
    await waitFor(() =>
      expect(screen.getByText(/无权限访问前台工作台/)).toBeInTheDocument(),
    );
  });
});

describe("Today Summary", () => {
  it("计数正确：到店 2 / 在住 1 / 空净 1 / 需关注 3", async () => {
    renderView();
    await ready();
    const arrivals = document.querySelector(
      '[data-summary-card="arrivals"]',
    ) as HTMLElement;
    expect(arrivals).not.toBeNull();
    expect(arrivals).toHaveTextContent("今日到店");
    expect(arrivals).toHaveTextContent("2");
    const attention = document.querySelector(
      '[data-summary-card="attention"]',
    ) as HTMLElement;
    expect(attention).toHaveTextContent("3");
    const vacant = document.querySelector(
      '[data-summary-card="vacantClean"]',
    ) as HTMLElement;
    expect(vacant).toHaveTextContent("1");
    const inhouse = document.querySelector(
      '[data-summary-card="inhouse"]',
    ) as HTMLElement;
    expect(inhouse).toHaveTextContent("1");
  });

  it("卡片点击 → 右侧 Drawer 列表（今日到店），不跳离页面", async () => {
    renderView();
    await ready();
    fireEvent.click(
      document.querySelector('[data-summary-card="arrivals"]') as HTMLElement,
    );
    const dialog = await screen.findByRole("dialog", { name: "今日到店" });
    expect(
      within(dialog).getByText("RSV-FDV-0001 · 张先生"),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/RSV-FDV-0002/)).toBeInTheDocument();
  });

  it("无 stay:read → 不渲染 今日离店 / 当前在住 卡片", async () => {
    renderView(PERMISSIONS.filter((p) => p !== "stay:read"));
    await ready();
    expect(document.querySelector('[data-summary-card="departures"]')).toBeNull();
    expect(document.querySelector('[data-summary-card="inhouse"]')).toBeNull();
  });
});

describe("Attention Center", () => {
  it("需关注抽屉展示三条规则：问题、房间、下一步入口", async () => {
    renderView();
    await ready();
    fireEvent.click(
      document.querySelector('[data-summary-card="attention"]') as HTMLElement,
    );
    const dialog = await screen.findByRole("dialog", { name: "需关注" });
    // Rule A：102 脏房今日到店
    expect(within(dialog).getByText(/到店房间未准备/)).toBeInTheDocument();
    expect(within(dialog).getByText(/尚未准备完成/)).toBeInTheDocument();
    // Rule B：104 超期在住
    expect(within(dialog).getByText(/在住超期/)).toBeInTheDocument();
    expect(within(dialog).getByText(/已超过计划退房日/)).toBeInTheDocument();
    // Rule C：103 blocked 未来预订
    expect(within(dialog).getByText(/房间不可用/)).toBeInTheDocument();
    expect(within(dialog).getAllByText("查看预订")).toHaveLength(2);
    expect(within(dialog).getByRole("link", { name: "查看在住" })).toHaveAttribute(
      "href",
      "/stays/21",
    );
  });

  it("Attention 点击查看预订 → 打开 Reservation Drawer（脏房不提供 Check-in）", async () => {
    renderView();
    await ready();
    fireEvent.click(
      document.querySelector('[data-summary-card="attention"]') as HTMLElement,
    );
    const dialog = await screen.findByRole("dialog", { name: "需关注" });
    fireEvent.click(within(dialog).getAllByText("查看预订")[0]);
    const resDialog = await screen.findByRole("dialog", { name: "预订速览" });
    expect(within(resDialog).getByText("RSV-FDV-0002")).toBeInTheDocument();
    // 脏房到店：不把 Check-in 作为主操作
    expect(
      within(resDialog).getByText("房间尚未准备完成"),
    ).toBeInTheDocument();
    expect(
      within(resDialog).queryByRole("button", { name: "办理入住" }),
    ).toBeNull();
    // 保洁任务信息 + 跳转
    expect(within(resDialog).getByText(/HKT-FDV-0031/)).toBeInTheDocument();
    expect(
      within(resDialog).getByRole("link", { name: /查看保洁任务/ }),
    ).toHaveAttribute("href", "/housekeeping/31");
  });
});

describe("Reservation Drawer", () => {
  it("字段完整：房间/客人/日期/晚数/来源/金额/状态/占用/清洁", async () => {
    renderView();
    await ready();
    const bar = document.querySelector(
      '[data-reservation-bar="RSV-FDV-0001"]',
    ) as HTMLElement;
    fireEvent.click(bar);
    const dialog = await screen.findByRole("dialog", { name: "预订速览" });
    expect(within(dialog).getByText("RSV-FDV-0001")).toBeInTheDocument();
    expect(within(dialog).getByText("101")).toBeInTheDocument();
    expect(within(dialog).getByText("张先生")).toBeInTheDocument();
    expect(within(dialog).getByText(/2 晚/)).toBeInTheDocument();
    expect(within(dialog).getByText(/CNY 428\.00/)).toBeInTheDocument();
    expect(within(dialog).getAllByText("已确认").length).toBeGreaterThanOrEqual(
      1,
    );
    expect(within(dialog).getAllByText("可售").length).toBeGreaterThanOrEqual(1);
    expect(within(dialog).getAllByText("干净").length).toBeGreaterThanOrEqual(1);
  });

  it("干净今日到店：办理入住 → 确认 → checkIn API + targeted refetch", async () => {
    renderView();
    await ready();
    const callsBefore = roomsListMock.mock.calls.length;
    const bar = document.querySelector(
      '[data-reservation-bar="RSV-FDV-0001"]',
    ) as HTMLElement;
    fireEvent.click(bar);
    const dialog = await screen.findByRole("dialog", { name: "预订速览" });
    fireEvent.click(within(dialog).getByRole("button", { name: "办理入住" }));
    const confirm = screen.getByRole("dialog", { name: "办理入住" });
    fireEvent.click(within(confirm).getByRole("button", { name: "办理入住" }));
    await waitFor(() => expect(reservationsCheckInMock).toHaveBeenCalledWith(1));
    await waitFor(() =>
      expect(roomsListMock.mock.calls.length).toBeGreaterThan(callsBefore),
    );
  });

  it("权限门控：无 reservation:cancel / no_show 不显示对应按钮", async () => {
    renderView(
      PERMISSIONS.filter(
        (p) => p !== "reservation:cancel" && p !== "reservation:no_show",
      ),
    );
    await ready();
    const bar = document.querySelector(
      '[data-reservation-bar="RSV-FDV-0001"]',
    ) as HTMLElement;
    fireEvent.click(bar);
    const dialog = await screen.findByRole("dialog", { name: "预订速览" });
    expect(within(dialog).queryByRole("button", { name: "取消预订" })).toBeNull();
    expect(
      within(dialog).queryByRole("button", { name: "标记未到店" }),
    ).toBeNull();
    expect(
      within(dialog).getByRole("button", { name: "办理入住" }),
    ).toBeInTheDocument();
  });

  it("PII：无 guest:read 时抽屉显示 ID 而非姓名", async () => {
    renderView(PERMISSIONS.filter((p) => p !== "guest:read"));
    await ready();
    const bar = document.querySelector(
      '[data-reservation-bar="RSV-FDV-0001"]',
    ) as HTMLElement;
    fireEvent.click(bar);
    const dialog = await screen.findByRole("dialog", { name: "预订速览" });
    expect(within(dialog).getByText("ID 7")).toBeInTheDocument();
    expect(within(dialog).queryByText("张先生")).toBeNull();
  });
});

describe("Room Drawer", () => {
  it("双状态 + active task + next reservation + 完整详情链接", async () => {
    renderView();
    await ready();
    const cell = document.querySelector('[data-room-cell="102"]') as HTMLElement;
    fireEvent.click(within(cell).getByRole("button"));
    const dialog = await screen.findByRole("dialog", { name: "房间速览" });
    expect(within(dialog).getByText("房间 102")).toBeInTheDocument();
    expect(within(dialog).getByText("可售")).toBeInTheDocument();
    expect(within(dialog).getByText("待清扫")).toBeInTheDocument();
    // active task（102）
    expect(within(dialog).getByText(/HKT-FDV-0031/)).toBeInTheDocument();
    // next reservation（102 今日到店预订）
    expect(within(dialog).getByText(/RSV-FDV-0002/)).toBeInTheDocument();
    expect(
      within(dialog).getByRole("link", { name: /完整房间详情/ }),
    ).toHaveAttribute("href", "/rooms/102");
  });

  it("无 housekeeping_task:read → 不请求不显示保洁任务", async () => {
    renderView(PERMISSIONS.filter((p) => p !== "housekeeping_task:read"));
    await ready();
    expect(tasksListMock).not.toHaveBeenCalled();
    const cell = document.querySelector('[data-room-cell="102"]') as HTMLElement;
    fireEvent.click(within(cell).getByRole("button"));
    const dialog = await screen.findByRole("dialog", { name: "房间速览" });
    expect(within(dialog).queryByText(/HKT-FDV/)).toBeNull();
  });
});

describe("Search", () => {
  /** desktop / mobile 双树都渲染 SearchBox：取第一个（行为一致）。 */
  function searchInput() {
    return screen.getAllByLabelText("搜索房号、客人、预订单号")[0];
  }

  it("房号 → 打开 Room Drawer（本地匹配，不发起 PII 搜索）", async () => {
    renderView();
    await ready();
    fireEvent.change(searchInput(), {
      target: { value: "104" },
    });
    const result = await waitFor(
      () => document.querySelector('[data-search-room="104"]') as HTMLElement,
    );
    expect(result).not.toBeNull();
    fireEvent.click(result);
    const dialog = await screen.findByRole("dialog", { name: "房间速览" });
    expect(within(dialog).getByText("房间 104")).toBeInTheDocument();
    // 房号搜索不触发带 search 参数的后端请求
    const searchCalls = reservationsListMock.mock.calls.filter(
      (call) => (call[0] as Record<string, unknown>).search !== undefined,
    );
    expect(searchCalls).toHaveLength(0);
  });

  it("预订单号 → 打开 Reservation Drawer", async () => {
    renderView();
    await ready();
    fireEvent.change(searchInput(), {
      target: { value: "RSV-FDV-0003" },
    });
    // 搜索防抖 300ms：等待真实计时器完成 API 调用与渲染
    await new Promise((r) => setTimeout(r, 500));
    const result = document.querySelector(
      '[data-search-reservation="3"]',
    ) as HTMLElement | null;
    expect(result).not.toBeNull();
    fireEvent.click(result as HTMLElement);
    const dialog = await screen.findByRole("dialog", { name: "预订速览" });
    expect(within(dialog).getByText(/2 晚/)).toBeInTheDocument();
  });

  it("无 guest:read 时按姓名搜索受限：提示 + 不发起后端搜索", async () => {
    renderView(PERMISSIONS.filter((p) => p !== "guest:read"));
    await ready();
    fireEvent.change(searchInput(), {
      target: { value: "张先生" },
    });
    await waitFor(() =>
      expect(
        screen.getByText(/按客人姓名 \/ 手机号搜索需要 guest:read 权限/),
      ).toBeInTheDocument(),
    );
    const searchCalls = reservationsListMock.mock.calls.filter(
      (call) => (call[0] as Record<string, unknown>).search !== undefined,
    );
    expect(searchCalls).toHaveLength(0);
  });
});
