/**
 * Front Desk × Maintenance 集成（Sprint 5 §38）最小集成测试：
 * - maintenance_order:read → bundle 拉取维修工单；Room Quick View 展示
 *   Active MWO + status + blocks_room + assignee + 查看维修
 * - 阻断工单红色提示；非阻断灰色
 * - 无 maintenance_order:read → 不请求、不显示
 * - Reservation Quick View 同样感知（occupied/reserved 房未被改 OOS 的场景）
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
  MaintenanceWorkOrderOut,
  MeOut,
  ReservationOut,
  RoomOut,
} from "@/lib/api/types";

const {
  roomsListMock,
  reservationsListMock,
  staysListMock,
  tasksListMock,
  mwoListMock,
} = vi.hoisted(() => ({
  roomsListMock: vi.fn(),
  reservationsListMock: vi.fn(),
  staysListMock: vi.fn(),
  tasksListMock: vi.fn(),
  mwoListMock: vi.fn(),
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
        get: vi.fn(),
        checkIn: vi.fn(),
        cancel: vi.fn(),
        noShow: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      stays: { list: staysListMock },
      housekeeping: { list: tasksListMock },
      maintenance: { list: mwoListMock },
      roomTypes: { list: vi.fn() },
    },
  };
});

const TODAY = businessDate();

const BASE_PERMISSIONS = [
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

function makeRoom(roomNumber: string, overrides: Partial<RoomOut> = {}): RoomOut {
  return {
    id: Number(roomNumber),
    room_number: roomNumber,
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
  room: RoomOut,
  overrides: Partial<ReservationOut> = {},
): ReservationOut {
  return {
    id: 1,
    reservation_no: "RSV-MWO-0001",
    guest_id: 7,
    room_id: room.id,
    room_number: room.room_number,
    room_type_id: room.room_type_id,
    check_in_date: TODAY,
    check_out_date: addDays(TODAY, 2),
    status: "CONFIRMED",
    source: "DIRECT",
    agreed_total_amount: "428.00",
    currency: "CNY",
    ...overrides,
  };
}

function makeOrder(
  room: RoomOut,
  overrides: Partial<MaintenanceWorkOrderOut> = {},
): MaintenanceWorkOrderOut {
  return {
    id: 41,
    work_order_no: "MWO-FD-0041",
    room_id: room.id,
    room_number: room.room_number,
    category: "HVAC",
    severity: "HIGH",
    status: "IN_PROGRESS",
    source: "FRONT_DESK",
    blocks_room: true,
    title: "空调故障",
    assignee_name: "维修老张",
    created_at: "x",
    updated_at: "x",
    ...overrides,
  };
}

const PAGE = (items: unknown[]) => ({
  items,
  total: items.length,
  page: 1,
  page_size: 100,
});

function renderView(permissions: string[]) {
  return render(
    <UserContext.Provider value={makeUser(permissions)}>
      <FrontDeskView />
    </UserContext.Provider>,
  );
}

async function ready() {
  await waitFor(() =>
    expect(
      document.querySelector('[data-summary-card="attention"]'),
    ).not.toBeNull(),
  );
}

beforeEach(() => {
  const rooms = [makeRoom("101"), makeRoom("102", { occupancy_status: "occupied" })];
  const reservations = [makeReservation(rooms[1])];
  roomsListMock.mockReset().mockResolvedValue(PAGE(rooms));
  reservationsListMock.mockReset().mockImplementation(
    (params: Record<string, unknown>) => {
      if (params.room_id !== undefined) {
        return Promise.resolve(
          PAGE(reservations.filter((r) => r.room_id === params.room_id)),
        );
      }
      if (params.overlap_from !== undefined) {
        return Promise.resolve(PAGE(reservations));
      }
      return Promise.resolve(PAGE(reservations));
    },
  );
  staysListMock.mockReset().mockResolvedValue(PAGE([]));
  tasksListMock.mockReset().mockResolvedValue(PAGE([]));
  mwoListMock.mockReset().mockResolvedValue(PAGE([]));
});

describe("Front Desk × Maintenance（Sprint 5 §38）", () => {
  it("Room Quick View 展示 Active 阻断工单：status + blocks_room + assignee + 查看维修", async () => {
    const room = makeRoom("101");
    mwoListMock.mockResolvedValue(
      PAGE([makeOrder(room, { blocks_room: true, status: "IN_PROGRESS" })]),
    );
    renderView([...BASE_PERMISSIONS, "maintenance_order:read"]);
    await ready();

    const cell = document.querySelector('[data-room-cell="101"]') as HTMLElement;
    fireEvent.click(within(cell).getByRole("button"));
    const dialog = await screen.findByRole("dialog", { name: "房间速览" });
    expect(within(dialog).getByText(/MWO-FD-0041/)).toBeInTheDocument();
    expect(within(dialog).getByText(/阻断客房/)).toBeInTheDocument();
    expect(within(dialog).getByText(/维修中/)).toBeInTheDocument();
    expect(within(dialog).getByText(/维修老张/)).toBeInTheDocument();
    expect(
      within(dialog).getByRole("link", { name: /查看维修/ }),
    ).toHaveAttribute("href", "/maintenance/41");
  });

  it("occupied 房间 + 阻断工单：Reservation Quick View 感知（不被改成 OOS 也可见）", async () => {
    const room = makeRoom("102", { occupancy_status: "occupied" });
    mwoListMock.mockResolvedValue(
      PAGE([makeOrder(room, { blocks_room: true, status: "RESOLVED" })]),
    );
    renderView([...BASE_PERMISSIONS, "maintenance_order:read"]);
    await ready();

    const bar = document.querySelector(
      '[data-reservation-bar="RSV-MWO-0001"]',
    ) as HTMLElement;
    fireEvent.click(bar);
    const dialog = await screen.findByRole("dialog", { name: "预订速览" });
    // RESOLVED 仍阻断：展示阻断维修（房间保持 occupied）
    expect(within(dialog).getByText(/MWO-FD-0041/)).toBeInTheDocument();
    expect(within(dialog).getByText(/阻断客房/)).toBeInTheDocument();
    expect(within(dialog).getByText(/待验收/)).toBeInTheDocument();
  });

  it("无 maintenance_order:read → 不请求不显示维修工单", async () => {
    renderView(BASE_PERMISSIONS);
    await ready();
    expect(mwoListMock).not.toHaveBeenCalled();
    const cell = document.querySelector('[data-room-cell="101"]') as HTMLElement;
    fireEvent.click(within(cell).getByRole("button"));
    const dialog = await screen.findByRole("dialog", { name: "房间速览" });
    expect(within(dialog).queryByText(/MWO-FD/)).toBeNull();
    expect(within(dialog).queryByText(/查看维修/)).toBeNull();
  });

  it("非阻断 Active 工单：无红色阻断徽标，仍展示状态与负责人", async () => {
    const room = makeRoom("101");
    mwoListMock.mockResolvedValue(
      PAGE([makeOrder(room, { id: 42, work_order_no: "MWO-FD-0042", blocks_room: false })]),
    );
    renderView([...BASE_PERMISSIONS, "maintenance_order:read"]);
    await ready();
    const cell = document.querySelector('[data-room-cell="101"]') as HTMLElement;
    fireEvent.click(within(cell).getByRole("button"));
    const dialog = await screen.findByRole("dialog", { name: "房间速览" });
    expect(within(dialog).getByText(/MWO-FD-0042/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/阻断客房/)).toBeNull();
    expect(within(dialog).getByText(/维修老张/)).toBeInTheDocument();
  });

  it("终态工单不展示（COMPLETED / CANCELLED 过滤）", async () => {
    const room = makeRoom("101");
    mwoListMock.mockResolvedValue(
      PAGE([
        makeOrder(room, { id: 43, work_order_no: "MWO-FD-0043", status: "COMPLETED" }),
        makeOrder(room, { id: 44, work_order_no: "MWO-FD-0044", status: "CANCELLED" }),
      ]),
    );
    renderView([...BASE_PERMISSIONS, "maintenance_order:read"]);
    await ready();
    const cell = document.querySelector('[data-room-cell="101"]') as HTMLElement;
    fireEvent.click(within(cell).getByRole("button"));
    const dialog = await screen.findByRole("dialog", { name: "房间速览" });
    expect(within(dialog).queryByText(/MWO-FD/)).toBeNull();
  });

  it("S5 修复：occupied + future CONFIRMED + blocking MWO → Attention 主动显示维修风险", async () => {
    const room = makeRoom("102", { occupancy_status: "occupied" });
    const future = makeReservation(room, {
      reservation_no: "RSV-MWO-0002",
      check_in_date: addDays(TODAY, 1),
      check_out_date: addDays(TODAY, 3),
    });
    roomsListMock.mockResolvedValue(PAGE([room]));
    reservationsListMock.mockResolvedValue(PAGE([future]));
    mwoListMock.mockResolvedValue(
      PAGE([makeOrder(room, { id: 41, status: "IN_PROGRESS" })]),
    );
    renderView([...BASE_PERMISSIONS, "maintenance_order:read"]);
    await ready();

    // 不打开任何 Drawer：风险直接在 Today 运营面主动出现（需关注计数）
    const attentionCard = document.querySelector(
      '[data-summary-card="attention"]',
    ) as HTMLElement;
    expect(attentionCard).not.toBeNull();
    expect(attentionCard).toHaveTextContent("1");

    fireEvent.click(attentionCard);
    const dialog = await screen.findByRole("dialog", { name: "需关注" });
    expect(within(dialog).getByText(/预订存在维修风险/)).toBeInTheDocument();
    expect(within(dialog).getByText(/房间 102/)).toBeInTheDocument();
    expect(within(dialog).getByText(/阻断性维修/)).toBeInTheDocument();
    expect(within(dialog).getByText(/MWO-FD-0041/)).toBeInTheDocument();
    expect(within(dialog).getByText(/RSV-MWO-0002/)).toBeInTheDocument();
    expect(
      within(dialog).getByRole("link", { name: /查看维修/ }),
    ).toHaveAttribute("href", "/maintenance/41");
    expect(within(dialog).getByText("查看预订")).toBeInTheDocument();
  });

  it("S5 修复：OOS(MAINTENANCE) + blocking MWO + future 预订 → 仅维修风险，无重复 Rule C", async () => {
    const room = makeRoom("101", {
      occupancy_status: "out_of_service",
      unavailability_source: "MAINTENANCE",
    });
    const future = makeReservation(room, {
      reservation_no: "RSV-MWO-0003",
      check_in_date: addDays(TODAY, 2),
      check_out_date: addDays(TODAY, 4),
    });
    roomsListMock.mockResolvedValue(PAGE([room]));
    reservationsListMock.mockResolvedValue(PAGE([future]));
    mwoListMock.mockResolvedValue(
      PAGE([makeOrder(room, { id: 45, work_order_no: "MWO-FD-0045" })]),
    );
    renderView([...BASE_PERMISSIONS, "maintenance_order:read"]);
    await ready();
    fireEvent.click(
      document.querySelector('[data-summary-card="attention"]') as HTMLElement,
    );
    const dialog = await screen.findByRole("dialog", { name: "需关注" });
    expect(within(dialog).getByText(/预订存在维修风险/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/房间不可用/)).toBeNull();
  });

  it("S5 修复：无 maintenance_order:read → 不请求工单、无维修风险（不扩大权限）", async () => {
    const room = makeRoom("102", { occupancy_status: "occupied" });
    const future = makeReservation(room, {
      reservation_no: "RSV-MWO-0004",
      check_in_date: addDays(TODAY, 1),
      check_out_date: addDays(TODAY, 3),
    });
    roomsListMock.mockResolvedValue(PAGE([room]));
    reservationsListMock.mockResolvedValue(PAGE([future]));
    renderView(BASE_PERMISSIONS); // 无 maintenance_order:read
    await ready();
    expect(mwoListMock).not.toHaveBeenCalled();
    const attentionCard = document.querySelector(
      '[data-summary-card="attention"]',
    ) as HTMLElement;
    expect(attentionCard).toHaveTextContent("0");
    fireEvent.click(attentionCard);
    const dialog = await screen.findByRole("dialog", { name: "需关注" });
    expect(within(dialog).queryByText(/维修风险/)).toBeNull();
  });
});
