/**
 * Room Diary 组件测试（Sprint 4）：
 * - 28 间房全量展示（无分页）+ 按楼层分组 + 双状态（占用 + 清洁）同时体现
 * - [check_in, check_out) 时间线：像素宽度/left、相邻预订相接不重叠、跨窗裁剪
 * - 楼层/房型筛选；Today/7/14/30 窗口切换
 * - 空白格点击 → 新建预订（预填链接）/ 查看房间；预订条点击 → 打开抽屉回调
 * - PII：无 guest:read 时预订条只显示预订号
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import RoomDiary from "@/components/front-desk/room-diary";
import { addDays, businessDate } from "@/lib/booking";
import type { ReservationOut, RoomOut, StayOut } from "@/lib/api/types";

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

function makeRoom(roomNumber: string, floor: number): RoomOut {
  return {
    id: Number(roomNumber),
    room_number: roomNumber,
    room_type_id: floor % 2 === 0 ? 3 : 4,
    floor,
    occupancy_status: "available",
    cleaning_status: "clean",
    notes: null,
    created_at: "x",
    updated_at: "x",
    room_type: { id: floor % 2 === 0 ? 3 : 4, name: floor % 2 === 0 ? "豪华大床房" : "豪华双床房" },
  };
}

function makeReservation(
  checkIn: string,
  checkOut: string,
  overrides: Partial<ReservationOut> = {},
): ReservationOut {
  return {
    id: 1,
    reservation_no: "RSV-DIARY-0001",
    guest_id: 7,
    guest_name: "张先生",
    room_id: 101,
    room_number: "101",
    room_type_id: 4,
    room_type_name: "豪华双床房",
    check_in_date: checkIn,
    check_out_date: checkOut,
    status: "CONFIRMED",
    source: "DIRECT",
    agreed_total_amount: "398.00",
    currency: "CNY",
    ...overrides,
  };
}

function makeStay(overrides: Partial<StayOut> = {}): StayOut {
  return {
    id: 11,
    stay_no: "STY-DIARY-0001",
    reservation_id: 1,
    room_id: 101,
    room_number: "101",
    status: "ACTIVE",
    actual_check_in_at: `${TODAY}T14:00:00+08:00`,
    planned_check_out_date: addDays(TODAY, 2),
    guest_name: "王先生",
    ...overrides,
  };
}

/** 28 间种子房（3 层）。 */
function seedRooms(): RoomOut[] {
  const rooms: RoomOut[] = [];
  for (let i = 1; i <= 10; i += 1) rooms.push(makeRoom(`1${String(i).padStart(2, "0")}`, 1));
  for (let i = 1; i <= 10; i += 1) rooms.push(makeRoom(`2${String(i).padStart(2, "0")}`, 2));
  for (let i = 1; i <= 8; i += 1) rooms.push(makeRoom(`3${String(i).padStart(2, "0")}`, 3));
  return rooms;
}

interface RenderOptions {
  rooms?: RoomOut[];
  reservations?: ReservationOut[];
  stays?: StayOut[];
  activeTaskRoomIds?: number[];
  days?: number;
  canReadGuest?: boolean;
  canCreateReservation?: boolean;
}

function renderDiary(opts: RenderOptions = {}) {
  const onOpenReservation = vi.fn();
  const onOpenRoom = vi.fn();
  const onWindowChange = vi.fn();
  const onFloorChange = vi.fn();
  const onRoomTypeChange = vi.fn();
  const rooms = opts.rooms ?? seedRooms();
  const utils = render(
    <RoomDiary
      rooms={rooms}
      reservations={opts.reservations ?? []}
      stays={opts.stays ?? []}
      activeTaskRoomIds={new Set(opts.activeTaskRoomIds ?? [])}
      winStart={TODAY}
      days={opts.days ?? 7}
      windowKey="7"
      onWindowChange={onWindowChange}
      floors={[...new Set(rooms.map((r) => r.floor))].sort((a, b) => a - b)}
      roomTypes={[...new Map(rooms.map((r) => [r.room_type_id, r.room_type?.name ?? ""])).entries()].map(([id, name]) => ({ id, name }))}
      floorFilter="all"
      roomTypeFilter="all"
      onFloorChange={onFloorChange}
      onRoomTypeChange={onRoomTypeChange}
      canReadGuest={opts.canReadGuest ?? true}
      canCreateReservation={opts.canCreateReservation ?? true}
      focusDate={null}
      focusToken={0}
      onOpenReservation={onOpenReservation}
      onOpenRoom={onOpenRoom}
    />,
  );
  return {
    onOpenReservation,
    onOpenRoom,
    onWindowChange,
    onFloorChange,
    onRoomTypeChange,
    utils,
  };
}

beforeEach(() => {
  // jsdom 无 getBoundingClientRect 布局：轨道左缘按 0 处理，clientX 映射日列
  Element.prototype.getBoundingClientRect = vi.fn(
    () =>
      ({
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect,
  );
});

describe("RoomDiary 房间与分组", () => {
  it("28 间房全部展示（无分页）且按楼层分组", () => {
    renderDiary();
    expect(document.querySelectorAll("[data-room-cell]")).toHaveLength(28);
    const region = screen.getByRole("region", {
      name: "房态日历（可横向滚动）",
    });
    expect(within(region).getByText("1 层")).toBeInTheDocument();
    expect(within(region).getByText("2 层")).toBeInTheDocument();
    expect(within(region).getByText("3 层")).toBeInTheDocument();
  });

  it("房间栏同时体现占用与清洁双状态（不合并成单状态）", () => {
    const rooms = [
      {
        ...makeRoom("101", 1),
        occupancy_status: "available" as const,
        cleaning_status: "dirty" as const,
      },
    ];
    renderDiary({ rooms });
    const cell = document.querySelector(
      '[data-room-cell="101"]',
    ) as HTMLElement | null;
    expect(cell).not.toBeNull();
    // available + dirty 是合法且重要的业务状态：两个徽标必须同时出现
    expect(within(cell as HTMLElement).getByText("可售")).toBeInTheDocument();
    expect(
      within(cell as HTMLElement).getByText("待清扫"),
    ).toBeInTheDocument();
  });

  it("有进行中保洁任务的房间显示任务指示", () => {
    const rooms = [makeRoom("101", 1)];
    renderDiary({ rooms, activeTaskRoomIds: [101] });
    expect(screen.getByTitle("保洁任务进行中")).toBeInTheDocument();
  });

  it("窗口切换按钮：Today / 7 天 / 14 天 / 30 天", () => {
    const { onWindowChange } = renderDiary();
    fireEvent.click(screen.getByRole("button", { name: "14 天" }));
    expect(onWindowChange).toHaveBeenCalledWith("14");
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(onWindowChange).toHaveBeenCalledWith("today");
  });

  it("楼层与房型筛选触发回调", () => {
    const { onFloorChange, onRoomTypeChange } = renderDiary();
    fireEvent.change(screen.getByLabelText("按楼层筛选"), {
      target: { value: "2" },
    });
    expect(onFloorChange).toHaveBeenCalledWith(2);
    fireEvent.change(screen.getByLabelText("按房型筛选"), {
      target: { value: "3" },
    });
    expect(onRoomTypeChange).toHaveBeenCalledWith(3);
  });
});

describe("Reservation Timeline 渲染", () => {
  it("[ci, co) 两晚预订：left=0、width=2×64px", () => {
    const res = makeReservation(TODAY, addDays(TODAY, 2));
    renderDiary({ reservations: [res] });
    const bar = document.querySelector("[data-reservation-bar]") as HTMLElement;
    expect(bar).not.toBeNull();
    expect(bar.style.left).toBe("0px");
    expect(bar.style.width).toBe("128px");
    expect(bar).toHaveTextContent("张先生");
  });

  it("相邻预订 [28,30) 与 [30,32)：首尾相接不重叠", () => {
    const first = makeReservation(TODAY, addDays(TODAY, 2), {
      id: 1,
      reservation_no: "RSV-A",
    });
    const second = makeReservation(addDays(TODAY, 2), addDays(TODAY, 4), {
      id: 2,
      reservation_no: "RSV-B",
    });
    renderDiary({ reservations: [first, second] });
    const bars = document.querySelectorAll("[data-reservation-bar]");
    expect(bars).toHaveLength(2);
    const [a, b] = [bars[0] as HTMLElement, bars[1] as HTMLElement];
    expect(a.style.width).toBe("128px");
    expect(b.style.width).toBe("128px");
    expect(b.style.left).toBe("128px");
  });

  it("跨窗裁剪：窗口前开始的预订只覆盖窗口内晚数", () => {
    const res = makeReservation(addDays(TODAY, -2), addDays(TODAY, 1), {
      id: 3,
      reservation_no: "RSV-C",
    });
    renderDiary({ reservations: [res], days: 7 });
    const bar = document.querySelector("[data-reservation-bar]") as HTMLElement;
    expect(bar.style.left).toBe("0px");
    expect(bar.style.width).toBe("64px");
  });

  it("CANCELLED / NO_SHOW / COMPLETED 不作为占用条渲染", () => {
    const cancelled = makeReservation(TODAY, addDays(TODAY, 2), {
      id: 4,
      status: "CANCELLED",
    });
    const completed = makeReservation(addDays(TODAY, 1), addDays(TODAY, 3), {
      id: 5,
      status: "COMPLETED",
    });
    renderDiary({ reservations: [cancelled, completed] });
    expect(document.querySelectorAll("[data-reservation-bar]")).toHaveLength(0);
  });

  it("Sprint 6 §24：CHECKED_IN 预订不再画成当前实际占用", () => {
    const checkedIn = makeReservation(TODAY, addDays(TODAY, 2), {
      id: 6,
      status: "CHECKED_IN",
    });
    renderDiary({ reservations: [checkedIn] });
    expect(document.querySelectorAll("[data-reservation-bar]")).toHaveLength(0);
  });

  it("Sprint 6 §24：ACTIVE Stay 按 stay.room_id 渲染为当前实际占用条", () => {
    const stay = makeStay();
    renderDiary({ stays: [stay] });
    const bar = document.querySelector("[data-stay-bar]") as HTMLElement;
    expect(bar).not.toBeNull();
    expect(bar.style.left).toBe("0px");
    expect(bar.style.width).toBe("128px");
    expect(bar).toHaveTextContent("王先生");
    expect(bar.getAttribute("href")).toBe("/stays/11");
  });

  it("Sprint 6 §24：换房后 Stay 画在新房，旧房不画占用条", () => {
    const moved = makeStay({ room_id: 102, room_number: "102" });
    renderDiary({ stays: [moved] });
    expect(document.querySelector('[data-room-track="101"] [data-stay-bar]')).toBeNull();
    const bar = document.querySelector(
      '[data-room-track="102"] [data-stay-bar]',
    ) as HTMLElement;
    expect(bar).not.toBeNull();
  });

  it("预订条点击 → onOpenReservation；空白格点击 → 快捷菜单", () => {
    const res = makeReservation(TODAY, addDays(TODAY, 2));
    const { onOpenReservation } = renderDiary({ reservations: [res] });
    const bar = document.querySelector("[data-reservation-bar]") as HTMLElement;
    fireEvent.click(bar);
    expect(onOpenReservation).toHaveBeenCalledWith(
      expect.objectContaining({ id: res.id }),
    );

    // 空白格（今天列空白处，clientX 落在第二列）
    const track = document.querySelector('[data-room-track="101"]') as HTMLElement;
    fireEvent.click(track, { clientX: 2 * 64 + 1, clientY: 10 });
    const menu = screen.getByRole("menu");
    expect(menu).toBeInTheDocument();
    const newLink = within(menu).getByText("新建预订");
    const href = (newLink as HTMLElement).getAttribute("href") ?? "";
    const url = new URL(href, "http://x");
    expect(url.pathname).toBe("/reservations/new");
    expect(url.searchParams.get("room_id")).toBe("101");
    expect(url.searchParams.get("check_in_date")).toBe(addDays(TODAY, 2));
    expect(url.searchParams.get("check_out_date")).toBe(addDays(TODAY, 3));
    fireEvent.click(within(menu).getByText("查看房间"));
  });

  it("无 reservation:write 时快捷菜单不提供新建预订", () => {
    renderDiary({ canCreateReservation: false });
    const track = document.querySelector('[data-room-track="101"]') as HTMLElement;
    fireEvent.click(track, { clientX: 5, clientY: 10 });
    const menu = screen.getByRole("menu");
    expect(within(menu).queryByText("新建预订")).not.toBeInTheDocument();
    expect(within(menu).getByText("查看房间")).toBeInTheDocument();
  });

  it("PII：无 guest:read 时预订条显示预订号而非姓名，tooltip 不含姓名", () => {
    const res = makeReservation(TODAY, addDays(TODAY, 2), {
      guest_name: "隐私客人",
    });
    renderDiary({ reservations: [res], canReadGuest: false });
    const bar = document.querySelector("[data-reservation-bar]") as HTMLElement;
    expect(bar).toHaveTextContent("RSV-DIARY-0001");
    expect(bar).not.toHaveTextContent("隐私客人");
    expect(bar.getAttribute("title")).not.toContain("隐私客人");
    expect(bar.getAttribute("title")).toContain("RSV-DIARY-0001");
  });
});
