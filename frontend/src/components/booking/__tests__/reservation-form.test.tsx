/**
 * ReservationForm 测试：
 * - 日期 [check_in, check_out) 校验；必填校验
 * - 创建提交载荷正确；提交成功/失败（409/422 展示后端原文）
 * - WALK_IN 自动锁定今天（Property Business Date，动态日期）
 * - 防重复提交（提交期间按钮禁用）
 * - 编辑模式仅提交变更字段；无变更不提交
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "@/lib/api";
import type {
  AvailabilityOut,
  GuestOut,
  MeOut,
  ReservationCreate,
  ReservationOut,
  ReservationUpdate,
} from "@/lib/api/types";
import { addDays, businessDate } from "@/lib/booking";
import ReservationForm from "@/components/booking/reservation-form";
import { UserContext } from "@/components/app-shell";

const { availabilityMock, roomTypesMock, guestsListMock, guestsGetMock, guestsCreateMock } =
  vi.hoisted(() => ({
    availabilityMock: vi.fn(),
    roomTypesMock: vi.fn(),
    guestsListMock: vi.fn(),
    guestsGetMock: vi.fn(),
    guestsCreateMock: vi.fn(),
  }));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      availability: { query: availabilityMock },
      roomTypes: { list: roomTypesMock },
      guests: {
        list: guestsListMock,
        get: guestsGetMock,
        create: guestsCreateMock,
      },
    },
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
}));

const TODAY = businessDate();
const DAY_AFTER = addDays(TODAY, 2);

const GUEST: GuestOut = {
  id: 7,
  name: "张先生",
  phone: "13812345678",
  email: null,
  notes: null,
  created_at: "x",
  updated_at: "x",
};

const AVAILABILITY: AvailabilityOut = {
  business_date: TODAY,
  check_in_date: TODAY,
  check_out_date: DAY_AFTER,
  total: 2,
  available_count: 1,
  items: [
    {
      room_id: 1,
      room_number: "203",
      room_type_id: 3,
      room_type_name: "豪华大床房",
      floor: 2,
      available: true,
      reason: null,
    },
    {
      room_id: 2,
      room_number: "204",
      room_type_id: 3,
      room_type_name: "豪华大床房",
      floor: 2,
      available: false,
      reason: "该房间在所选日期区间已被预订",
    },
  ],
};

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

const FULL_PERMS = [
  "guest:read",
  "guest:write",
  "reservation:read",
  "reservation:write",
  "stay:read",
];

type SubmitFn = ReturnType<typeof vi.fn>;

function renderForm(
  props?: Partial<
    Omit<React.ComponentProps<typeof ReservationForm>, "onSubmit">
  > & { onSubmit?: SubmitFn },
) {
  const { onSubmit: _propOnSubmit, ...restProps } = props ?? {};
  const onSubmit = (_propOnSubmit ?? vi.fn()) as SubmitFn;
  if (!_propOnSubmit) onSubmit.mockResolvedValue({});
  return {
    onSubmit,
    ...render(
      <UserContext.Provider value={makeUser(FULL_PERMS)}>
        <ReservationForm
          mode="create"
          permissions={new Set(FULL_PERMS)}
          submitLabel="创建预订"
          onSubmit={
            onSubmit as unknown as (
              payload: ReservationCreate | ReservationUpdate,
            ) => Promise<unknown>
          }
          {...restProps}
        />
      </UserContext.Provider>,
    ),
  };
}

async function selectGuest(name = "张先生") {
  const input = screen.getByLabelText("搜索客人");
  await userEvent.type(input, name);
  const option = await screen.findByRole("button", { name: /张先生/ });
  await userEvent.click(option);
}

async function fillValidForm() {
  await selectGuest();
  fireEvent.change(screen.getByLabelText("入住日期"), {
    target: { value: TODAY },
  });
  fireEvent.change(screen.getByLabelText("退房日期"), {
    target: { value: DAY_AFTER },
  });
  const room = await screen.findByRole("button", { name: /203/ });
  await userEvent.click(room);
  fireEvent.change(screen.getByLabelText("约定金额"), {
    target: { value: "428.00" },
  });
}

beforeEach(() => {
  availabilityMock.mockReset();
  roomTypesMock.mockReset();
  guestsListMock.mockReset();
  guestsGetMock.mockReset();
  guestsCreateMock.mockReset();
  roomTypesMock.mockResolvedValue({ items: [{ id: 3, name: "豪华大床房" }], total: 1, page: 1, page_size: 100 });
  guestsListMock.mockResolvedValue({ items: [GUEST], total: 1, page: 1, page_size: 10 });
  availabilityMock.mockResolvedValue(AVAILABILITY);
});

describe("ReservationForm 创建", () => {
  it("填写完整表单 → 提交正确载荷（动态日期）", async () => {
    const { onSubmit } = renderForm();
    await fillValidForm();
    await userEvent.click(screen.getByRole("button", { name: "创建预订" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0] as ReservationCreate;
    expect(payload).toEqual({
      guest_id: GUEST.id,
      room_id: 1,
      room_type_id: 3,
      check_in_date: TODAY,
      check_out_date: DAY_AFTER,
      source: "DIRECT",
      external_reference: null,
      agreed_total_amount: "428.00",
      currency: "CNY",
      notes: null,
    });
  });

  it("退房日期 ≤ 入住日期 → 提示且不提交（[ci, co) 语义）", async () => {
    const { onSubmit } = renderForm();
    await selectGuest();
    fireEvent.change(screen.getByLabelText("入住日期"), {
      target: { value: TODAY },
    });
    fireEvent.change(screen.getByLabelText("退房日期"), {
      target: { value: TODAY },
    });
    expect(screen.getByText("退房日期必须晚于入住日期")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "创建预订" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("缺少必填（客人/房间/金额）→ 提示且不提交", async () => {
    const { onSubmit } = renderForm();
    fireEvent.change(screen.getByLabelText("入住日期"), {
      target: { value: TODAY },
    });
    fireEvent.change(screen.getByLabelText("退房日期"), {
      target: { value: DAY_AFTER },
    });
    await userEvent.click(screen.getByRole("button", { name: "创建预订" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("请选择客人")).toBeInTheDocument();
  });

  it("WALK_IN：入住日期自动锁定今天（Property Business Date）", async () => {
    renderForm();
    await userEvent.selectOptions(
      screen.getByLabelText("预订来源"),
      "WALK_IN",
    );
    const checkIn = screen.getByLabelText("入住日期") as HTMLInputElement;
    expect(checkIn.value).toBe(TODAY);
    expect(checkIn.disabled).toBe(true);
  });

  it("409 冲突 → 展示后端原文（冲突条）", async () => {
    const onSubmit = vi
      .fn()
      .mockRejectedValue(
        new ApiError("conflict", 409, "该房间在所选日期区间已被预订"),
      );
    renderForm({ onSubmit });
    await fillValidForm();
    await userEvent.click(screen.getByRole("button", { name: "创建预订" }));
    expect(
      await screen.findByText("冲突：该房间在所选日期区间已被预订"),
    ).toBeInTheDocument();
  });

  it("422 → 展示后端校验文案", async () => {
    const onSubmit = vi
      .fn()
      .mockRejectedValue(
        new ApiError(
          "validation",
          422,
          "房型与房间不一致：reservation.room_type_id 必须等于 room.room_type_id",
        ),
      );
    renderForm({ onSubmit });
    await fillValidForm();
    await userEvent.click(screen.getByRole("button", { name: "创建预订" }));
    expect(
      await screen.findByText(
        "房型与房间不一致：reservation.room_type_id 必须等于 room.room_type_id",
      ),
    ).toBeInTheDocument();
  });

  it("提交期间按钮禁用（防重复提交）", async () => {
    let resolveSubmit: (v: unknown) => void = () => {};
    const onSubmit = vi
      .fn()
      .mockImplementation(
        () => new Promise((resolve) => (resolveSubmit = resolve)),
      );
    renderForm({ onSubmit });
    await fillValidForm();
    const submit = screen.getByRole("button", { name: "创建预订" });
    await userEvent.click(submit);
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    // 双击不触发第二次提交
    await userEvent.dblClick(submit);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    resolveSubmit({});
    await waitFor(() =>
      expect((submit as HTMLButtonElement).disabled).toBe(false),
    );
  });
});

describe("ReservationForm 编辑（CONFIRMED）", () => {
  const INITIAL: ReservationOut = {
    id: 11,
    reservation_no: "RSV-TEST-0001",
    guest_id: GUEST.id,
    guest_name: "张先生",
    room_id: 1,
    room_number: "203",
    room_type_id: 3,
    room_type_name: "豪华大床房",
    check_in_date: TODAY,
    check_out_date: DAY_AFTER,
    status: "CONFIRMED",
    source: "DIRECT",
    external_reference: null,
    agreed_total_amount: "428.00",
    currency: "CNY",
    notes: "原始备注",
  };

  it("修改字段 → 仅提交变更字段", async () => {
    guestsGetMock.mockResolvedValue(GUEST);
    const onSubmit = vi.fn().mockResolvedValue({});
    render(
      <UserContext.Provider value={makeUser(FULL_PERMS)}>
        <ReservationForm
          mode="edit"
          initial={INITIAL}
          permissions={new Set(FULL_PERMS)}
          submitLabel="保存修改"
          onSubmit={onSubmit}
        />
      </UserContext.Provider>,
    );
    await waitFor(() => expect(guestsGetMock).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("预订备注"), {
      target: { value: "新备注" },
    });
    await userEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toEqual({ notes: "新备注" });
  });

  it("无任何变更 → 提示且不调用 onSubmit（禁止空 PATCH）", async () => {
    guestsGetMock.mockResolvedValue(GUEST);
    const onSubmit = vi.fn();
    render(
      <UserContext.Provider value={makeUser(FULL_PERMS)}>
        <ReservationForm
          mode="edit"
          initial={INITIAL}
          permissions={new Set(FULL_PERMS)}
          submitLabel="保存修改"
          onSubmit={onSubmit}
        />
      </UserContext.Provider>,
    );
    await waitFor(() => expect(guestsGetMock).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: "保存修改" }));
    expect(await screen.findByText("没有需要保存的变更")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("修改日期触发 Availability 重新查询（编辑改期）", async () => {
    guestsGetMock.mockResolvedValue(GUEST);
    const onSubmit = vi.fn().mockResolvedValue({});
    render(
      <UserContext.Provider value={makeUser(FULL_PERMS)}>
        <ReservationForm
          mode="edit"
          initial={INITIAL}
          permissions={new Set(FULL_PERMS)}
          submitLabel="保存修改"
          onSubmit={onSubmit}
        />
      </UserContext.Provider>,
    );
    await waitFor(() => expect(guestsGetMock).toHaveBeenCalled());
    const newIn = addDays(TODAY, 3);
    const newOut = addDays(TODAY, 5);
    fireEvent.change(screen.getByLabelText("入住日期"), {
      target: { value: newIn },
    });
    fireEvent.change(screen.getByLabelText("退房日期"), {
      target: { value: newOut },
    });
    await waitFor(() =>
      expect(availabilityMock).toHaveBeenLastCalledWith({
        check_in_date: newIn,
        check_out_date: newOut,
        room_type_id: 3,
      }),
    );
  });
});
