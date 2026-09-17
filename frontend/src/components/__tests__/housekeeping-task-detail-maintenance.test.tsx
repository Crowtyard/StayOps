/**
 * Housekeeping × Maintenance 集成（Sprint 5 §37）测试：
 * - 保洁任务详情「发现设施问题 → 报修」仅 maintenance_order:write 时显示
 * - 点击进入 /maintenance/new 并预填 room_id + source=HOUSEKEEPING
 * - 不复制 Housekeeping Notes
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { HousekeepingTaskOut, MeOut, RoomOut } from "@/lib/api/types";
import HousekeepingTaskDetailView from "@/components/housekeeping-task-detail-view";
import { UserContext } from "@/components/app-shell";

const { hkGetMock, roomsGetMock } = vi.hoisted(() => ({
  hkGetMock: vi.fn(),
  roomsGetMock: vi.fn(),
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
      housekeeping: { get: hkGetMock, assignees: vi.fn().mockResolvedValue([]) },
      rooms: { get: roomsGetMock },
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

function makeTask(): HousekeepingTaskOut {
  return {
    id: 1,
    task_no: "HKT20260901-0001",
    room_id: 12,
    room_number: "110",
    status: "IN_PROGRESS",
    priority: "NORMAL",
    source: "CHECKOUT",
    created_at: "x",
    updated_at: "x",
  };
}

function makeRoom(): RoomOut {
  return {
    id: 12,
    room_number: "110",
    name: null,
    is_active: true,
    room_type_id: 1,
    floor: 1,
    occupancy_status: "available",
    cleaning_status: "cleaning",
    notes: null,
    created_at: "x",
    updated_at: "x",
    room_type: { id: 1, name: "标准大床房" },
  };
}

function renderView(permissions: string[]) {
  return render(
    <UserContext.Provider value={makeUser(permissions)}>
      <HousekeepingTaskDetailView id="1" />
    </UserContext.Provider>,
  );
}

beforeEach(() => {
  hkGetMock.mockReset().mockResolvedValue(makeTask());
  roomsGetMock.mockReset().mockResolvedValue(makeRoom());
});

describe("保洁任务详情 × 维修报修（Sprint 5 §37）", () => {
  it("maintenance_order:write → 显示「发现设施问题 → 报修」并预填房间与来源", async () => {
    renderView([
      "housekeeping_task:read",
      "room:read",
      "maintenance_order:write",
    ]);
    const link = await screen.findByRole("link", {
      name: /发现设施问题/,
    });
    expect(link).toHaveAttribute(
      "href",
      "/maintenance/new?room_id=12&source=HOUSEKEEPING",
    );
  });

  it("无 maintenance_order:write → 不显示报修入口", async () => {
    renderView(["housekeeping_task:read", "room:read"]);
    await screen.findByText(/HKT20260901-0001/);
    expect(
      screen.queryByRole("link", { name: /发现设施问题/ }),
    ).not.toBeInTheDocument();
  });

  it("报修入口不复制 Housekeeping Notes（链接仅含 room_id 与 source）", async () => {
    renderView([
      "housekeeping_task:read",
      "room:read",
      "maintenance_order:write",
    ]);
    const link = await screen.findByRole("link", {
      name: /发现设施问题/,
    });
    const href = link.getAttribute("href") ?? "";
    expect(href).not.toContain("notes");
    expect(href).toContain("source=HOUSEKEEPING");
  });
});
