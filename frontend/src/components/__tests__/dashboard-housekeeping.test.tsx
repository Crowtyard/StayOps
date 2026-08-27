/**
 * Dashboard HousekeepingOverview（Sprint 3）测试：
 * - 待清扫 / 清扫中 / 待验房 / 返工 计数（组合 GET /housekeeping/tasks）
 * - 无 housekeeping_task:read → 不请求、不渲染
 * - 加载失败 → 区块内错误提示（不阻塞房态区）
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import type { HousekeepingTaskOut, MeOut } from "@/lib/api/types";
import DashboardView from "@/components/dashboard-view";
import { UserContext } from "@/components/app-shell";

const { roomsListMock, reservationsListMock, staysListMock, hkListMock } = vi.hoisted(() => ({
  roomsListMock: vi.fn(),
  reservationsListMock: vi.fn(),
  staysListMock: vi.fn(),
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
      rooms: { list: roomsListMock },
      reservations: { list: reservationsListMock },
      stays: { list: staysListMock },
      housekeeping: { list: hkListMock },
    },
  };
});

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

function makeTask(status: HousekeepingTaskOut["status"], id: number): HousekeepingTaskOut {
  return {
    id,
    task_no: `HKT20260827-${String(id).padStart(4, "0")}`,
    room_id: id,
    room_number: String(100 + id),
    status,
    priority: "NORMAL",
    source: "CHECKOUT",
    created_at: "x",
    updated_at: "x",
  };
}

beforeEach(() => {
  roomsListMock.mockReset().mockResolvedValue({ items: [], total: 0, page: 1, page_size: 100 });
  reservationsListMock.mockReset().mockResolvedValue({ items: [], total: 0, page: 1, page_size: 100 });
  staysListMock.mockReset().mockResolvedValue({ items: [], total: 0, page: 1, page_size: 100 });
  hkListMock.mockReset().mockResolvedValue({ items: [], total: 0, page: 1, page_size: 100 });
});

describe("Dashboard HousekeepingOverview（Sprint 3）", () => {
  it("待清扫/清扫中/待验房/返工计数（组合 List API）", async () => {
    hkListMock.mockResolvedValue({
      items: [
        makeTask("PENDING", 1),
        makeTask("PENDING", 2),
        makeTask("IN_PROGRESS", 3),
        makeTask("INSPECTION", 4),
        makeTask("REWORK", 5),
        makeTask("COMPLETED", 6), // 终态不计入四卡
      ],
      total: 6,
      page: 1,
      page_size: 100,
    });
    render(
      <UserContext.Provider
        value={makeUser(["room:read", "housekeeping_task:read"])}
      >
        <DashboardView />
      </UserContext.Provider>,
    );
    expect(await screen.findByText("保洁运营概览")).toBeInTheDocument();
    // 等待任务数据加载完成（加载态消失）
    await waitFor(() =>
      expect(screen.queryByText("正在加载保洁任务…")).not.toBeInTheDocument(),
    );

    // 作用域到保洁概览区块（房态主卡中也有「待清扫」等标签）
    const heading = screen.getByText("保洁运营概览");
    const section = heading.closest("div.mt-6") as HTMLElement;
    const cardValue = (label: string): string | null => {
      const labelEl = within(section)
        .getAllByText(label)
        .find((el) => el.tagName === "P");
      const card = labelEl?.closest("div");
      if (!card) return null;
      const number = within(card as HTMLElement).queryAllByText(/^\d+$/);
      return number[0]?.textContent ?? null;
    };
    expect(cardValue("待清扫")).toBe("2");
    expect(cardValue("清扫中")).toBe("1");
    expect(cardValue("待验房")).toBe("1");
    expect(cardValue("返工")).toBe("1");
  });

  it("无 housekeeping_task:read → 不请求、不渲染区块", async () => {
    render(
      <UserContext.Provider
        value={makeUser(["room:read", "reservation:read", "stay:read"])}
      >
        <DashboardView />
      </UserContext.Provider>,
    );
    await screen.findByText("当前房态概览");
    expect(screen.queryByText("保洁运营概览")).not.toBeInTheDocument();
    expect(hkListMock).not.toHaveBeenCalled();
  });

  it("保洁概览加载失败 → 区块内错误提示（不阻塞房态区）", async () => {
    hkListMock.mockRejectedValue(new Error("boom"));
    render(
      <UserContext.Provider
        value={makeUser(["room:read", "housekeeping_task:read"])}
      >
        <DashboardView />
      </UserContext.Provider>,
    );
    expect(await screen.findByText("当前房态概览")).toBeInTheDocument();
    expect(
      await screen.findByText("保洁任务概览加载失败"),
    ).toBeInTheDocument();
  });
});
