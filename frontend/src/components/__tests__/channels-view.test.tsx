/**
 * alpha.9.6 F3 渠道管理 UI + F4 客源渠道经营分析 UI 测试。
 *
 * F3：
 * - 展示系统预置渠道与自定义渠道（含已停用）
 * - 新增自定义渠道（现场需求：美团/携程/飞猪/其他 之外可扩展）
 * - 系统渠道名称固定（前端禁用输入 + 后端 409 原样展示）
 * - 停用 / 启用；channel:write 门控
 * F4：
 * - 表格第一优先：渠道 / 订单数 / 实际房晚 / 合同房费 / 占比 / 合同 ADR
 * - 合同房费口径标注「非实际收款」
 * - 未指定渠道桶并入合计，保证可对账
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BusinessChannelsOut, ChannelOut, MeOut } from "@/lib/api/types";
import { ApiError } from "@/lib/api";
import ChannelsView from "@/components/channels-view";
import ChannelsTab from "@/components/analytics/channels-tab";
import { UserContext } from "@/components/app-shell";

const { listMock, createMock, patchMock, disableMock, enableMock, removeMock } =
  vi.hoisted(() => ({
    listMock: vi.fn(),
    createMock: vi.fn(),
    patchMock: vi.fn(),
    disableMock: vi.fn(),
    enableMock: vi.fn(),
    removeMock: vi.fn(),
  }));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      channels: {
        list: listMock,
        create: createMock,
        patch: patchMock,
        disable: disableMock,
        enable: enableMock,
        remove: removeMock,
      },
    },
  };
});

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

const CHANNELS: ChannelOut[] = [
  {
    id: 1,
    code: "SYS_MEITUAN",
    name: "美团",
    category: "OTA",
    enabled: true,
    is_system: true,
    sort_order: 10,
    created_at: "x",
    updated_at: "x",
  },
  {
    id: 2,
    code: "SYS_CTRIP",
    name: "携程",
    category: "OTA",
    enabled: true,
    is_system: true,
    sort_order: 20,
    created_at: "x",
    updated_at: "x",
  },
  {
    id: 9,
    code: "CUSTOM_OTHER",
    name: "其他",
    category: "OTHER",
    enabled: true,
    is_system: true,
    sort_order: 900,
    created_at: "x",
    updated_at: "x",
  },
  {
    id: 20,
    code: "CUSTOM_DOUYIN",
    name: "抖音",
    category: "OTA",
    enabled: false,
    is_system: false,
    sort_order: 55,
    created_at: "x",
    updated_at: "x",
  },
];

function makeUser(permissions: string[]): MeOut {
  return {
    id: 1,
    username: "manager",
    display_name: "店长",
    email: null,
    phone: null,
    is_active: true,
    created_at: "x",
    updated_at: "x",
    roles: [{ id: 2, name: "MANAGER" }],
    permissions,
  };
}

function renderChannels(permissions = ["channel:read", "channel:write"]) {
  return render(
    <UserContext.Provider value={makeUser(permissions)}>
      <ChannelsView />
    </UserContext.Provider>,
  );
}

beforeEach(() => {
  listMock.mockReset();
  createMock.mockReset();
  patchMock.mockReset();
  disableMock.mockReset();
  enableMock.mockReset();
  removeMock.mockReset();
  listMock.mockResolvedValue({
    items: CHANNELS,
    total: CHANNELS.length,
    page: 1,
    page_size: 100,
  });
});

describe("ChannelsView（alpha.9.6 F3 渠道管理）", () => {
  it("展示预置渠道与自定义渠道（含已停用标记）", async () => {
    renderChannels();
    expect(await screen.findByRole("cell", { name: "美团" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "携程" })).toBeInTheDocument();
    expect(screen.getAllByRole("cell", { name: "其他" }).length).toBeGreaterThan(0);
    expect(screen.getByRole("cell", { name: "抖音" })).toBeInTheDocument();
    expect(screen.getAllByText("系统预置").length).toBe(3);
    expect(screen.getByText("自定义")).toBeInTheDocument();
    expect(screen.getByText("已停用")).toBeInTheDocument();
    // 请求包含启用与停用渠道（管理界面需要看全部）
    expect(listMock).toHaveBeenCalledWith(
      expect.objectContaining({ include_disabled: true }),
    );
  });

  it("新增自定义渠道：提交名称 / 类别 / 排序", async () => {
    createMock.mockResolvedValue({
      ...CHANNELS[3],
      id: 30,
      name: "小红书",
      enabled: true,
    });
    renderChannels();
    await userEvent.click(await screen.findByRole("button", { name: "新增渠道" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText(/^渠道名称/), "小红书");
    await userEvent.selectOptions(within(dialog).getByLabelText(/^类别/), "OFFLINE");
    await userEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    expect(createMock.mock.calls[0][0]).toEqual({
      name: "小红书",
      category: "OFFLINE",
      sort_order: 0,
    });
  });

  it("系统预置渠道名称输入框禁用（名称固定）", async () => {
    renderChannels();
    const rows = await screen.findAllByRole("button", { name: "编辑" });
    await userEvent.click(rows[0]); // 美团（系统渠道）
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText(/^渠道名称/)).toBeDisabled();
  });

  it("后端 409（系统渠道名称固定）文案原样展示", async () => {
    patchMock.mockRejectedValue(
      new ApiError(
        "conflict",
        409,
        "渠道「其他」为系统预置渠道，名称固定不可修改；如需停用请使用停用操作",
      ),
    );
    renderChannels();
    const editButtons = await screen.findAllByRole("button", { name: "编辑" });
    await userEvent.click(editButtons[2]); // 其他（可改名）
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    expect(
      await screen.findByText(/系统预置渠道，名称固定不可修改/),
    ).toBeInTheDocument();
  });

  it("停用渠道：确认文案说明历史不受影响", async () => {
    disableMock.mockResolvedValue({ ...CHANNELS[0], enabled: false });
    renderChannels();
    const stopButtons = await screen.findAllByRole("button", { name: "停用" });
    await userEvent.click(stopButtons[0]);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/历史预订仍保留其渠道归属/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "停用" }));
    await waitFor(() => expect(disableMock).toHaveBeenCalledWith(1));
  });

  it("系统预置渠道不显示删除按钮；自定义渠道显示", async () => {
    renderChannels();
    await screen.findByRole("cell", { name: "美团" });
    // 4 个渠道中只有 1 个自定义渠道可删除
    expect(screen.getAllByRole("button", { name: "删除" })).toHaveLength(1);
  });

  it("已被预订引用的渠道删除失败 → 展示后端建议改用停用", async () => {
    removeMock.mockRejectedValue(
      new ApiError(
        "conflict",
        409,
        "渠道「抖音」已被 3 条预订使用，不能删除；如需停止使用请改为停用（历史预订不受影响）",
      ),
    );
    renderChannels();
    await userEvent.click(await screen.findByRole("button", { name: "删除" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    expect(await screen.findByText(/请改为停用/)).toBeInTheDocument();
  });

  it("无 channel:read：显示无权提示，不发起请求", async () => {
    renderChannels(["room:read"]);
    expect(
      await screen.findByText(/无权限查看渠道主数据/),
    ).toBeInTheDocument();
    expect(listMock).not.toHaveBeenCalled();
  });

  it("只读角色（channel:read 无 write）：不显示新增/编辑/停用/删除", async () => {
    renderChannels(["channel:read"]);
    expect(await screen.findByRole("cell", { name: "美团" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "新增渠道" })).toBeNull();
    expect(screen.queryByRole("button", { name: "编辑" })).toBeNull();
    expect(screen.queryByRole("button", { name: "停用" })).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* F4 渠道经营分析 Tab                                                 */
/* ------------------------------------------------------------------ */

function makeChannelsAnalytics(): BusinessChannelsOut {
  return {
    business_date: "2026-09-16",
    period: { from: "2026-08-17", to: "2026-09-16", days: 30 },
    physical_room_count: 28,
    totals: {
      order_count: 104,
      stay_count: 100,
      occupied_room_nights: 208,
      contracted_room_value: "29810.00",
      contracted_adr: "143.32",
    },
    channels: [
      {
        channel_id: 2,
        channel_code: "SYS_CTRIP",
        channel_name: "携程",
        channel_category: "OTA",
        channel_enabled: true,
        is_system: true,
        order_count: 38,
        stay_count: 36,
        occupied_room_nights: 76,
        contracted_room_value: "10820.00",
        contracted_adr: "142.37",
        share: 0.3630,
      },
      {
        channel_id: 1,
        channel_code: "SYS_MEITUAN",
        channel_name: "美团",
        channel_category: "OTA",
        channel_enabled: true,
        is_system: true,
        order_count: 34,
        stay_count: 33,
        occupied_room_nights: 68,
        contracted_room_value: "8960.00",
        contracted_adr: "131.76",
        share: 0.3006,
      },
      {
        channel_id: 21,
        channel_code: "CUSTOM_PHONE",
        channel_name: "电话",
        channel_category: "OFFLINE",
        channel_enabled: false,
        is_system: false,
        order_count: 15,
        stay_count: 15,
        occupied_room_nights: 30,
        contracted_room_value: "5100.00",
        contracted_adr: "170.00",
        share: 0.1711,
      },
    ],
    unassigned: {
      channel_id: null,
      channel_code: null,
      channel_name: "未指定渠道",
      channel_category: null,
      channel_enabled: true,
      is_system: false,
      order_count: 17,
      stay_count: 16,
      occupied_room_nights: 34,
      contracted_room_value: "4930.00",
      contracted_adr: "145.00",
      share: 0.1654,
    },
  };
}

describe("ChannelsTab（alpha.9.6 F4 客源渠道经营分析）", () => {
  it("表格展示渠道 / 订单数 / 实际房晚 / 合同房费 / 占比 / 合同 ADR", () => {
    render(<ChannelsTab channels={makeChannelsAnalytics()} />);
    expect(screen.getByRole("cell", { name: "携程" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "美团" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: /^电话/ })).toBeInTheDocument();
    expect(screen.getByText(/10,820\.00/)).toBeInTheDocument();
    expect(screen.getByText("36.3%")).toBeInTheDocument();
    expect(screen.getByText("¥142.37")).toBeInTheDocument();
    // 列标题齐全（表格为第一优先）
    for (const header of ["渠道", "类别", "订单数", "实际房晚", "合同房费", "占比", "合同 ADR"]) {
      expect(screen.getByRole("columnheader", { name: header })).toBeInTheDocument();
    }
  });

  it("标注合同房费非实际收款（口径诚实）", () => {
    render(<ChannelsTab channels={makeChannelsAnalytics()} />);
    expect(
      screen.getByText(/合同房费为非实际收款/),
    ).toBeInTheDocument();
  });

  it("停用渠道仍展示历史业绩并标记「已停用」", () => {
    render(<ChannelsTab channels={makeChannelsAnalytics()} />);
    expect(screen.getByText("已停用")).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: /^电话/ })).toBeInTheDocument();
  });

  it("合计行 = Σ 渠道 + 未指定渠道（可对账）", () => {
    render(<ChannelsTab channels={makeChannelsAnalytics()} />);
    const footer = screen.getByRole("row", { name: /合计/ });
    // 订单数 38+34+15+17 = 104
    expect(within(footer).getByText("104")).toBeInTheDocument();
    // 合同房费 10820+8960+5100+4930 = 29810
    expect(within(footer).getByText(/29,810\.00/)).toBeInTheDocument();
  });

  it("无经营分析权限 → 显示权限说明", () => {
    render(<ChannelsTab channels={null} />);
    expect(screen.getByText(/需要经营分析权限/)).toBeInTheDocument();
  });

  it("零数据：分母 0 -> 显示 —（禁止 NaN）", () => {
    const empty: BusinessChannelsOut = {
      business_date: "2026-09-16",
      period: { from: "2026-08-17", to: "2026-09-16", days: 30 },
      physical_room_count: 28,
      totals: {
        order_count: 0,
        stay_count: 0,
        occupied_room_nights: 0,
        contracted_room_value: "0.00",
        contracted_adr: null,
      },
      channels: [
        {
          channel_id: 1,
          channel_code: "SYS_MEITUAN",
          channel_name: "美团",
          channel_category: "OTA",
          channel_enabled: true,
          is_system: true,
          order_count: 0,
          stay_count: 0,
          occupied_room_nights: 0,
          contracted_room_value: "0.00",
          contracted_adr: null,
          share: null,
        },
      ],
      unassigned: {
        channel_id: null,
        channel_name: "未指定渠道",
        order_count: 0,
        stay_count: 0,
        occupied_room_nights: 0,
        contracted_room_value: "0.00",
        contracted_adr: null,
        share: null,
      },
    };
    render(<ChannelsTab channels={empty} />);
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.getByText(/该区间内没有渠道业务数据/)).toBeInTheDocument();
  });
});
