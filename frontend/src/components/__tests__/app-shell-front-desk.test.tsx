/**
 * Sprint 4 AppShell 前台导航显隐矩阵：
 * - 前台入口需要 room:read AND reservation:read 同时满足（不用角色名判断权限）
 * - SUPER_ADMIN / MANAGER / FRONT_DESK → 可见
 * - HOUSEKEEPING / MAINTENANCE / FINANCE → 隐藏
 * - 只有 room:read 或只有 reservation:read → 隐藏
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { MeOut } from "@/lib/api/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
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

function renderShell(user: MeOut) {
  return render(
    <AppShell user={user} offline={false}>
      <p>页面内容</p>
    </AppShell>,
  );
}

const FRONT_DESK_PAGE_PERMISSIONS = ["room:read", "reservation:read"];

describe("前台导航显隐（room:read + reservation:read）", () => {
  it.each([
    ["SUPER_ADMIN", ["room:read", "reservation:read"]],
    ["MANAGER", ["room:read", "reservation:read"]],
    ["FRONT_DESK", ["room:read", "reservation:read"]],
  ])("%s（含双权限）→ 可见前台入口", (_role, permissions) => {
    renderShell(makeUser(permissions, [_role]));
    expect(screen.getByRole("link", { name: "前台" })).toBeInTheDocument();
  });

  it.each([
    ["HOUSEKEEPING", ["room:read", "room:status_cleaning"]],
    ["MAINTENANCE", ["room:read", "room:status_maintenance"]],
    ["FINANCE", ["room:read", "audit:read"]],
  ])("%s（无 reservation:read）→ 隐藏前台入口", (_role, permissions) => {
    renderShell(makeUser(permissions, [_role]));
    expect(screen.queryByRole("link", { name: "前台" })).not.toBeInTheDocument();
  });

  it("只有 reservation:read（无 room:read）→ 隐藏", () => {
    renderShell(makeUser(["reservation:read"], ["CUSTOM"]));
    expect(screen.queryByRole("link", { name: "前台" })).not.toBeInTheDocument();
  });

  it("只有 room:read（无 reservation:read）→ 隐藏", () => {
    renderShell(makeUser(["room:read"], ["CUSTOM"]));
    expect(screen.queryByRole("link", { name: "前台" })).not.toBeInTheDocument();
  });

  it("前台链接指向 /front-desk", () => {
    renderShell(makeUser(FRONT_DESK_PAGE_PERMISSIONS, ["FRONT_DESK"]));
    expect(screen.getByRole("link", { name: "前台" })).toHaveAttribute(
      "href",
      "/front-desk",
    );
  });
});
