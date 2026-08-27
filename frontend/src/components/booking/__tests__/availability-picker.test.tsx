/**
 * AvailabilityPicker 测试：
 * - 加载可用房间；不可用房间禁用并展示后端原因
 * - 无可用房间 → Empty 态
 * - 房型筛选传参；日期无效不查询；选择房间带出房型联动
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AvailabilityOut, RoomTypeOut } from "@/lib/api/types";
import { addDays, businessDate } from "@/lib/booking";
import AvailabilityPicker from "@/components/booking/availability-picker";

const { availabilityMock } = vi.hoisted(() => ({ availabilityMock: vi.fn() }));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: { availability: { query: availabilityMock } },
  };
});

const TODAY = businessDate();
const DAY_AFTER = addDays(TODAY, 1);

const ROOM_TYPES: RoomTypeOut[] = [
  { id: 3, name: "豪华大床房", base_price: "428.00", capacity: 2, description: null, created_at: "x", updated_at: "x", room_count: 0 },
  { id: 1, name: "标准大床房", base_price: "328.00", capacity: 2, description: null, created_at: "x", updated_at: "x", room_count: 0 },
];

function makeAvailability(items: AvailabilityOut["items"]): AvailabilityOut {
  return {
    business_date: TODAY,
    check_in_date: TODAY,
    check_out_date: DAY_AFTER,
    total: items.length,
    available_count: items.filter((i) => i.available).length,
    items,
  };
}

function renderPicker(overrides: Partial<React.ComponentProps<typeof AvailabilityPicker>> = {}) {
  const onChange = overrides.onChange ?? vi.fn();
  const onRoomTypeChange = overrides.onRoomTypeChange ?? vi.fn();
  const view = render(
    <AvailabilityPicker
      checkIn={TODAY}
      checkOut={DAY_AFTER}
      roomTypeId={null}
      value={null}
      onChange={onChange}
      onRoomTypeChange={onRoomTypeChange}
      roomTypes={ROOM_TYPES}
      datesValid
      {...overrides}
    />,
  );
  return { onChange, onRoomTypeChange, view };
}

beforeEach(() => {
  availabilityMock.mockReset();
});

describe("AvailabilityPicker", () => {
  it("加载可售房间；不可用房间禁用并展示后端原因", async () => {
    availabilityMock.mockResolvedValue(
      makeAvailability([
        { room_id: 1, room_number: "203", room_type_id: 3, room_type_name: "豪华大床房", floor: 2, available: true, reason: null },
        { room_id: 2, room_number: "204", room_type_id: 3, room_type_name: "豪华大床房", floor: 2, available: false, reason: "该房间在所选日期区间已被预订" },
      ]),
    );
    renderPicker();
    expect(await screen.findByText("共 1 间可用 / 2 间")).toBeInTheDocument();
    const unavailable = screen.getByRole("button", { name: /204/ });
    expect(unavailable).toBeDisabled();
    expect(screen.getByText("该房间在所选日期区间已被预订")).toBeInTheDocument();
  });

  it("无可用房间 → Empty 态", async () => {
    availabilityMock.mockResolvedValue(
      makeAvailability([
        { room_id: 2, room_number: "204", room_type_id: 3, room_type_name: "豪华大床房", floor: 2, available: false, reason: "该房间在所选日期区间已被预订" },
      ]),
    );
    renderPicker();
    expect(await screen.findByText("所选日期无可用房间")).toBeInTheDocument();
  });

  it("房型筛选 → 重新查询并传递 room_type_id", async () => {
    availabilityMock.mockResolvedValue(makeAvailability([]));
    // 受控包装：房型筛选状态由测试容器维护并回传组件
    function Controlled() {
      const [roomTypeId, setRoomTypeId] = React.useState<number | null>(null);
      return (
        <AvailabilityPicker
          checkIn={TODAY}
          checkOut={DAY_AFTER}
          roomTypeId={roomTypeId}
          value={null}
          onChange={vi.fn()}
          onRoomTypeChange={setRoomTypeId}
          roomTypes={ROOM_TYPES}
          datesValid
        />
      );
    }
    render(<Controlled />);
    await userEvent.selectOptions(
      screen.getByLabelText("按房型筛选可售房间"),
      "3",
    );
    await waitFor(() =>
      expect(availabilityMock).toHaveBeenLastCalledWith({
        check_in_date: TODAY,
        check_out_date: DAY_AFTER,
        room_type_id: 3,
      }),
    );
  });

  it("日期无效 → 不查询并提示", () => {
    renderPicker({ datesValid: false });
    expect(availabilityMock).not.toHaveBeenCalled();
    expect(
      screen.getByText("请先选择有效的入住与退房日期"),
    ).toBeInTheDocument();
  });

  it("选择房间 → onChange 带出房型（Room/Room Type 联动）", async () => {
    availabilityMock.mockResolvedValue(
      makeAvailability([
        { room_id: 1, room_number: "203", room_type_id: 3, room_type_name: "豪华大床房", floor: 2, available: true, reason: null },
      ]),
    );
    const { onChange } = renderPicker();
    const room = await screen.findByRole("button", { name: /203/ });
    await userEvent.click(room);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ room_id: 1, room_type_id: 3 }),
    );
  });
});
