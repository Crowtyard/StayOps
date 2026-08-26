/**
 * 用户管理视图：
 * - 真实列表渲染（用户名/角色/启用状态）
 * - RBAC：无 user:write 不显示新建入口
 * - 403 → 无权限且不跳登录；401 → 跳登录
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const { replaceMock, routerMock, usersListMock, rolesListMock } = vi.hoisted(
  () => {
    const replaceMock = vi.fn();
    return {
      replaceMock,
      routerMock: { replace: replaceMock, refresh: vi.fn() },
      usersListMock: vi.fn(),
      rolesListMock: vi.fn(),
    };
  },
);

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      users: { list: usersListMock },
      roles: { list: rolesListMock },
    },
  };
});

import { ApiError } from "@/lib/api";
import type { MeOut, UserOut } from "@/lib/api/types";
import UsersView from "@/components/settings/users-view";
import { UserContext } from "@/components/app-shell";

const USERS: UserOut[] = [
  {
    id: 1,
    username: "admin",
    display_name: "管理员",
    email: null,
    phone: null,
    is_active: true,
    created_at: "2026-08-25T09:00:00Z",
    updated_at: "2026-08-25T09:00:00Z",
    roles: [{ id: 1, name: "SUPER_ADMIN" }],
  },
  {
    id: 2,
    username: "frontdesk01",
    display_name: null,
    email: null,
    phone: null,
    is_active: false,
    created_at: "2026-08-25T09:00:00Z",
    updated_at: "2026-08-25T09:00:00Z",
    roles: [{ id: 3, name: "FRONT_DESK" }],
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
      <UsersView />
    </UserContext.Provider>,
  );
}

beforeEach(() => {
  usersListMock.mockReset();
  rolesListMock.mockReset();
  replaceMock.mockClear();
});

describe("UsersView", () => {
  it("渲染真实用户列表（用户名/角色/启用状态）", async () => {
    usersListMock.mockResolvedValue(pageOf(USERS));
    rolesListMock.mockResolvedValue(pageOf([]));
    renderView(
      makeUser(["user:read", "user:write", "user:delete", "role:read"]),
    );
    expect(await screen.findByText("admin")).toBeInTheDocument();
    expect(screen.getByText("SUPER_ADMIN")).toBeInTheDocument();
    expect(screen.getByText("FRONT_DESK")).toBeInTheDocument();
    // 状态徽标与启停按钮都可能出现“启用/停用”文案
    expect(screen.getAllByText("启用").length).toBeGreaterThan(0);
    expect(screen.getAllByText("停用").length).toBeGreaterThan(0);
  });

  it("无 user:write 权限 → 不显示新建用户按钮", async () => {
    usersListMock.mockResolvedValue(pageOf(USERS));
    renderView(makeUser(["user:read"]));
    await screen.findByText("admin");
    expect(
      screen.queryByRole("button", { name: /新建用户/ }),
    ).not.toBeInTheDocument();
  });

  it("403 → 显示无权限，不跳转登录", async () => {
    usersListMock.mockRejectedValue(
      new ApiError("forbidden", 403, "无权限执行该操作"),
    );
    renderView(makeUser(["room:read"]));
    expect(await screen.findByText("无权限访问该页面")).toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalledWith("/login");
  });

  it("401 → 跳转 /login", async () => {
    usersListMock.mockRejectedValue(
      new ApiError("unauthorized", 401, "登录已失效"),
    );
    renderView(makeUser(["user:read"]));
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/login"));
  });
});
