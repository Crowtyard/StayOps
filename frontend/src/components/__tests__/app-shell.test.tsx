/**
 * AppShell RBAC 导航显隐与退出登录：
 * - SUPER_ADMIN 可见全部导航；FRONT_DESK / HOUSEKEEPING 按权限收窄
 * - 未登录仅显示公开项；退出清 Cookie 后跳 /login
 * - 离线时显示后端不可用徽标
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MeOut } from "@/lib/api/types";

const { replaceMock, routerMock } = vi.hoisted(() => {
  const replaceMock = vi.fn();
  return {
    replaceMock,
    // 返回稳定对象，避免每次渲染产生新 router 引发 effect 抖动
    routerMock: { replace: replaceMock, refresh: vi.fn(), push: vi.fn() },
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  usePathname: () => "/dashboard",
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

import AppShell from "@/components/app-shell";

function makeUser(permissions: string[], roles: string[]): MeOut {
  return {
    id: 1,
    username: "tester",
    display_name: "测试员",
    email: null,
    phone: null,
    is_active: true,
    created_at: "2026-08-25T09:00:00Z",
    updated_at: "2026-08-25T09:00:00Z",
    roles: roles.map((name, i) => ({ id: i + 1, name })),
    permissions,
  };
}

function renderShell(user: MeOut | null, offline = false) {
  return render(
    <AppShell user={user} offline={offline}>
      <p>页面内容</p>
    </AppShell>,
  );
}

describe("AppShell 导航 RBAC 显隐", () => {
  it("SUPER_ADMIN 可见全部导航（首页/房态/房型/用户/角色与权限/审计日志）", () => {
    renderShell(
      makeUser(
        ["room:read", "room_type:read", "user:read", "role:read", "audit:read"],
        ["SUPER_ADMIN"],
      ),
    );
    for (const label of ["首页", "房态", "房型", "用户", "角色与权限", "审计日志"]) {
      expect(
        screen.getByRole("link", { name: label }),
      ).toBeInTheDocument();
    }
    // T3b 占位角标已移除
    expect(screen.queryByText("T3b")).not.toBeInTheDocument();
  });

  it("FRONT_DESK 看不到用户与角色管理，但可见房态/房型/审计", () => {
    renderShell(
      makeUser(
        ["room:read", "room:write", "room_type:read", "audit:read"],
        ["FRONT_DESK"],
      ),
    );
    expect(screen.getByRole("link", { name: "房态" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "房型" })).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "审计日志" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "用户" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "角色与权限" }),
    ).not.toBeInTheDocument();
  });

  it("HOUSEKEEPING 仅见首页与房态（无任何设置入口）", () => {
    renderShell(
      makeUser(["room:read", "room:status_cleaning"], ["HOUSEKEEPING"]),
    );
    expect(screen.getByRole("link", { name: "首页" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "房态" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "房型" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "用户" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "角色与权限" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "审计日志" }),
    ).not.toBeInTheDocument();
  });

  it("未登录仅显示公开导航，顶栏显示未登录", () => {
    renderShell(null);
    expect(screen.getByRole("link", { name: "首页" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "房态" })).not.toBeInTheDocument();
    expect(screen.getByText("未登录")).toBeInTheDocument();
  });

  it("离线时显示后端服务不可用徽标", () => {
    renderShell(
      makeUser(["room:read"], ["FRONT_DESK"]),
      true,
    );
    expect(screen.getByText("后端服务暂时不可用")).toBeInTheDocument();
  });

  it("顶栏显示用户名与角色", () => {
    renderShell(makeUser(["room:read"], ["SUPER_ADMIN"]));
    expect(screen.getByText("测试员")).toBeInTheDocument();
    expect(screen.getAllByText("SUPER_ADMIN").length).toBeGreaterThan(0);
  });
});

describe("AppShell 退出登录", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    replaceMock.mockClear();
  });

  it("点击退出 → 调 POST /api/auth/logout 并跳 /login", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 200 }));
    const user = userEvent.setup();
    renderShell(makeUser(["room:read"], ["SUPER_ADMIN"]));
    await user.click(screen.getByRole("button", { name: "退出" }));
    expect(fetch).toHaveBeenCalledWith(
      "/api/auth/logout",
      expect.objectContaining({ method: "POST" }),
    );
    expect(replaceMock).toHaveBeenCalledWith("/login");
  });

  it("退出接口失败也本地退出并跳 /login（网络容错）", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("fetch failed"));
    const user = userEvent.setup();
    renderShell(makeUser(["room:read"], ["SUPER_ADMIN"]));
    await user.click(screen.getByRole("button", { name: "退出" }));
    expect(replaceMock).toHaveBeenCalledWith("/login");
  });
});
