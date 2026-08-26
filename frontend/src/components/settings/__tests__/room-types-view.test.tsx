/**
 * 房型管理视图：
 * - 真实列表渲染（名称/价格 Decimal 字符串/容量/房间数）
 * - RBAC：无 room_type:write 不显示新建入口
 * - 403 → 无权限且不跳登录；401 → 跳登录
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const { replaceMock, routerMock, listMock } = vi.hoisted(() => {
  const replaceMock = vi.fn();
  return {
    replaceMock,
    routerMock: { replace: replaceMock, refresh: vi.fn() },
    listMock: vi.fn(),
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      roomTypes: { list: listMock },
    },
  };
});

import { ApiError } from "@/lib/api";
import type { MeOut, RoomTypeOut } from "@/lib/api/types";
import RoomTypesView from "@/components/settings/room-types-view";
import { UserContext } from "@/components/app-shell";

const ROOM_TYPES: RoomTypeOut[] = [
  {
    id: 1,
    name: "标准大床房",
    base_price: "328.00",
    capacity: 2,
    description: "1.8m 大床",
    created_at: "2026-08-25T09:00:00Z",
    updated_at: "2026-08-25T09:00:00Z",
    room_count: 8,
  },
  {
    id: 5,
    name: "豪华套房",
    base_price: "688.00",
    capacity: 4,
    description: null,
    created_at: "2026-08-25T09:00:00Z",
    updated_at: "2026-08-25T09:00:00Z",
    room_count: 5,
  },
];

function makeUser(permissions: string[]): MeOut {
  return {
    id: 1,
    username: "admin",
    display_name: "管理员",
    email: null,
    phone: null,
    is_active: true,
    created_at: "x",
    updated_at: "x",
    roles: [{ id: 1, name: "SUPER_ADMIN" }],
    permissions,
  };
}

function pageOf<T>(items: T[]) {
  return { items, total: items.length, page: 1, page_size: 100 };
}

function renderView(user: MeOut) {
  return render(
    <UserContext.Provider value={user}>
      <RoomTypesView />
    </UserContext.Provider>,
  );
}

beforeEach(() => {
  listMock.mockReset();
  replaceMock.mockClear();
});

describe("RoomTypesView", () => {
  it("渲染真实房型列表（名称/价格/容量/房间数）", async () => {
    listMock.mockResolvedValue(pageOf(ROOM_TYPES));
    renderView(makeUser(["room_type:read", "room_type:write", "room_type:delete"]));
    expect(await screen.findByText("标准大床房")).toBeInTheDocument();
    expect(screen.getByText("豪华套房")).toBeInTheDocument();
    expect(screen.getByText("共 2 个房型")).toBeInTheDocument();
    // Decimal 字符串 → 两位小数价格
    expect(screen.getByText("¥328.00")).toBeInTheDocument();
    expect(screen.getByText("¥688.00")).toBeInTheDocument();
    expect(screen.getByText("2 人")).toBeInTheDocument();
    expect(screen.getByText("8 间")).toBeInTheDocument();
  });

  it("无 room_type:write 不显示新建房型按钮", async () => {
    listMock.mockResolvedValue(pageOf(ROOM_TYPES));
    renderView(makeUser(["room_type:read"]));
    await screen.findByText("标准大床房");
    expect(
      screen.queryByRole("button", { name: /新建房型/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /编辑/ })).not.toBeInTheDocument();
  });

  it("403 → 显示无权限，不跳转登录", async () => {
    listMock.mockRejectedValue(
      new ApiError("forbidden", 403, "无权限执行该操作"),
    );
    renderView(makeUser(["room:read"]));
    expect(await screen.findByText("无权限访问该页面")).toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalledWith("/login");
  });

  it("401 → 跳转 /login", async () => {
    listMock.mockRejectedValue(
      new ApiError("unauthorized", 401, "登录已失效"),
    );
    renderView(makeUser(["room_type:read"]));
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/login"));
  });
});
