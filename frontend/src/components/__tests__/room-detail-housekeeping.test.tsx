/**
 * RoomDetailView Housekeeping 扩展（Sprint 3）测试：
 * - housekeeping_task:read → 进行中保洁任务摘要（状态 / 优先级 / 保洁员）
 * - 无权限 → 不请求 Task API、不渲染区块
 * - 终态任务（COMPLETED/CANCELLED）不显示（只显示进行中任务）
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { HousekeepingTaskOut, MeOut, RoomOut } from "@/lib/api/types";
import RoomDetailView from "@/components/room-detail-view";
import { UserContext } from "@/components/app-shell";

const { getMock, changeStatusMock, staysListMock, reservationsListMock, hkListMock } =
  vi.hoisted(() => ({
    getMock: vi.fn(),
    changeStatusMock: vi.fn(),
    staysListMock: vi.fn(),
    reservationsListMock: vi.fn(),
    hkListMock: vi.fn(),
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
      rooms: { get: getMock, changeStatus: changeStatusMock },
      stays: { list: staysListMock },
      reservations: { list: reservationsListMock },
      housekeeping: { list: hkListMock },
    },
  };
});

const ROOM: RoomOut = {
  id: 1,
  room_number: "210",
  name: null,
  is_active: true,
  room_type_id: 3,
  floor: 2,
  occupancy_status: "available",
  cleaning_status: "cleaning",
  notes: null,
  created_at: "x",
  updated_at: "x",
  room_type: { id: 3, name: "豪华大床房" },
};

function makeTask(overrides: Partial<HousekeepingTaskOut> = {}): HousekeepingTaskOut {
  return {
    id: 31,
    task_no: "HKT20260827-0031",
    room_id: 1,
    room_number: "210",
    status: "IN_PROGRESS",
    priority: "URGENT",
    source: "CHECKOUT",
    assignee_name: "保洁小王",
    created_at: "x",
    updated_at: "x",
    ...overrides,
  };
}

function makeUser(permissions: string[]): MeOut {
  return {
    id: 1,
    username: "fd",
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

function renderDetail(user: MeOut) {
  return render(
    <UserContext.Provider value={user}>
      <RoomDetailView id="1" />
    </UserContext.Provider>,
  );
}

beforeEach(() => {
  getMock.mockReset().mockResolvedValue(ROOM);
  changeStatusMock.mockReset();
  staysListMock.mockReset().mockResolvedValue({ items: [], total: 0, page: 1, page_size: 10 });
  reservationsListMock.mockReset().mockResolvedValue({ items: [], total: 0, page: 1, page_size: 100 });
  hkListMock.mockReset().mockResolvedValue({ items: [], total: 0, page: 1, page_size: 10 });
});

describe("RoomDetailView Housekeeping 任务摘要（Sprint 3）", () => {
  it("housekeeping_task:read → 展示进行中任务（状态/优先级/保洁员 + 链接）", async () => {
    hkListMock.mockResolvedValue({
      items: [makeTask()],
      total: 1,
      page: 1,
      page_size: 10,
    });
    renderDetail(makeUser(["room:read", "housekeeping_task:read"]));
    expect(await screen.findByText("保洁任务")).toBeInTheDocument();
    // 「清扫中」同时出现在房间清洁徽标与任务状态徽标（同一状态，联动一致）
    expect(screen.getAllByText("清扫中").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("加急")).toBeInTheDocument();
    expect(screen.getByText("保洁小王")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "HKT20260827-0031" }),
    ).toHaveAttribute("href", "/housekeeping/31");
  });

  it("终态任务（COMPLETED）不显示（仅进行中任务）", async () => {
    hkListMock.mockResolvedValue({
      items: [makeTask({ status: "COMPLETED", assignee_name: undefined })],
      total: 1,
      page: 1,
      page_size: 10,
    });
    renderDetail(makeUser(["room:read", "housekeeping_task:read"]));
    await screen.findByText("房间 210");
    expect(screen.queryByText("保洁任务")).not.toBeInTheDocument();
  });

  it("无 housekeeping_task:read → 不请求 Task API、不渲染区块", async () => {
    renderDetail(makeUser(["room:read", "reservation:read", "stay:read"]));
    await screen.findByText("房间 210");
    expect(screen.queryByText("保洁任务")).not.toBeInTheDocument();
    expect(hkListMock).not.toHaveBeenCalled();
  });
});
