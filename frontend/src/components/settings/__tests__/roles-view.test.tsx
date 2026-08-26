/**
 * 角色与权限视图：
 * - 真实角色列表渲染（角色名/描述/权限 chips）
 * - RBAC：无 role:write 不显示新建/修改入口，仅可查看权限
 * - 403 → 无权限且不跳登录；401 → 跳登录
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const { replaceMock, routerMock, rolesListMock, permissionsListMock } =
  vi.hoisted(() => {
    const replaceMock = vi.fn();
    return {
      replaceMock,
      routerMock: { replace: replaceMock, refresh: vi.fn() },
      rolesListMock: vi.fn(),
      permissionsListMock: vi.fn(),
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
      roles: { list: rolesListMock },
      permissions: { list: permissionsListMock },
    },
  };
});

import { ApiError } from "@/lib/api";
import type { MeOut, RoleOut } from "@/lib/api/types";
import RolesView from "@/components/settings/roles-view";
import { UserContext } from "@/components/app-shell";

const ROLES: RoleOut[] = [
  {
    id: 1,
    name: "SUPER_ADMIN",
    description: "超级管理员：拥有全部权限",
    created_at: "2026-08-25T09:00:00Z",
    updated_at: "2026-08-25T09:00:00Z",
    permissions: [
      { id: 1, code: "user:read", name: "查看用户", description: null },
      { id: 3, code: "role:read", name: "查看角色", description: null },
    ],
  },
  {
    id: 3,
    name: "FRONT_DESK",
    description: "前台",
    created_at: "2026-08-25T09:00:00Z",
    updated_at: "2026-08-25T09:00:00Z",
    permissions: [
      { id: 6, code: "room:read", name: "查看房间", description: null },
    ],
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
      <RolesView />
    </UserContext.Provider>,
  );
}

beforeEach(() => {
  rolesListMock.mockReset();
  permissionsListMock.mockReset();
  replaceMock.mockClear();
});

describe("RolesView", () => {
  it("渲染真实角色列表（角色名 + 权限 chips）", async () => {
    rolesListMock.mockResolvedValue(pageOf(ROLES));
    renderView(makeUser(["role:read", "role:write", "role:delete"]));
    expect(await screen.findByText("SUPER_ADMIN")).toBeInTheDocument();
    expect(screen.getByText("FRONT_DESK")).toBeInTheDocument();
    expect(screen.getByText("共 2 个角色")).toBeInTheDocument();
    // 权限 chips 展示
    expect(screen.getByText("user:read")).toBeInTheDocument();
    expect(screen.getByText("room:read")).toBeInTheDocument();
  });

  it("SUPER_ADMIN（有 role:write）可见新建角色与修改权限入口", async () => {
    rolesListMock.mockResolvedValue(pageOf(ROLES));
    renderView(makeUser(["role:read", "role:write", "role:delete"]));
    await screen.findByText("SUPER_ADMIN");
    expect(
      screen.getByRole("button", { name: /新建角色/ }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: /查看 \/ 修改权限/ }).length,
    ).toBeGreaterThan(0);
  });

  it("无 role:write 仅可查看权限（无新建/编辑/删除入口）", async () => {
    rolesListMock.mockResolvedValue(pageOf(ROLES));
    renderView(makeUser(["role:read"]));
    await screen.findByText("SUPER_ADMIN");
    expect(
      screen.queryByRole("button", { name: /新建角色/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /查看 \/ 修改权限/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "查看权限" }).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /删除/ })).not.toBeInTheDocument();
  });

  it("403 → 显示无权限，不跳转登录", async () => {
    rolesListMock.mockRejectedValue(
      new ApiError("forbidden", 403, "无权限执行该操作"),
    );
    renderView(makeUser(["room:read"]));
    expect(await screen.findByText("无权限访问该页面")).toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalledWith("/login");
  });

  it("401 → 跳转 /login", async () => {
    rolesListMock.mockRejectedValue(
      new ApiError("unauthorized", 401, "登录已失效"),
    );
    renderView(makeUser(["role:read"]));
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/login"));
  });
});
