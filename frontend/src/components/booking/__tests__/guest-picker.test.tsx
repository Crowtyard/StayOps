/**
 * GuestPicker 测试：搜索（name/phone）、选择、创建、权限禁用（guest:read/write）。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "@/lib/api";
import type { GuestOut } from "@/lib/api/types";
import GuestPicker from "@/components/booking/guest-picker";

const { guestsListMock, guestsCreateMock } = vi.hoisted(() => ({
  guestsListMock: vi.fn(),
  guestsCreateMock: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      guests: { list: guestsListMock, create: guestsCreateMock },
    },
  };
});

const GUEST: GuestOut = {
  id: 7,
  name: "张先生",
  phone: "13812345678",
  email: "zhang@example.com",
  notes: null,
  created_at: "x",
  updated_at: "x",
};

function renderPicker(
  overrides: Partial<React.ComponentProps<typeof GuestPicker>> = {},
) {
  const onChange = overrides.onChange ?? vi.fn();
  const view = render(
    <GuestPicker
      value={null}
      selected={null}
      onChange={onChange}
      canSearch
      canCreate
      {...overrides}
    />,
  );
  return { onChange, view };
}

beforeEach(() => {
  guestsListMock.mockReset();
  guestsCreateMock.mockReset();
});

describe("GuestPicker", () => {
  it("搜索并选择客人（防抖搜索 + 结果列表）", async () => {
    guestsListMock.mockResolvedValue({
      items: [GUEST],
      total: 1,
      page: 1,
      page_size: 10,
    });
    const { onChange } = renderPicker();
    await userEvent.type(screen.getByLabelText("搜索客人"), "1381234");
    const option = await screen.findByRole("button", { name: /张先生/ });
    await userEvent.click(option);
    expect(onChange).toHaveBeenCalledWith(GUEST);
  });

  it("搜索无结果 → 提示未找到 + 新建入口", async () => {
    guestsListMock.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      page_size: 10,
    });
    renderPicker();
    await userEvent.type(screen.getByLabelText("搜索客人"), "不存在的人");
    expect(await screen.findByText("未找到匹配客人")).toBeInTheDocument();
  });

  it("创建客人成功 → 自动选中", async () => {
    guestsCreateMock.mockResolvedValue(GUEST);
    const { onChange } = renderPicker();
    await userEvent.click(screen.getByRole("button", { name: "新建客人" }));
    await userEvent.type(screen.getByLabelText("姓名"), "张先生");
    await userEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(GUEST));
  });

  it("创建失败 → 展示错误文案", async () => {
    guestsCreateMock.mockRejectedValue(
      new ApiError("validation", 422, "name: 字段必填"),
    );
    renderPicker();
    await userEvent.click(screen.getByRole("button", { name: "新建客人" }));
    await userEvent.click(screen.getByRole("button", { name: "创建" }));
    expect(await screen.findByText("请输入客人姓名")).toBeInTheDocument();
  });

  it("无 guest:read → 不渲染搜索/身份信息", () => {
    renderPicker({ canSearch: false, canCreate: false });
    expect(
      screen.getByText("无权限查看客人信息（需 guest:read）"),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("搜索客人")).not.toBeInTheDocument();
  });

  it("已选客人展示姓名与电话（guest:read）", () => {
    renderPicker({ value: GUEST.id, selected: GUEST });
    expect(screen.getByText(/已选择客人：张先生/)).toBeInTheDocument();
    expect(screen.getByText(/13812345678/)).toBeInTheDocument();
  });
});
