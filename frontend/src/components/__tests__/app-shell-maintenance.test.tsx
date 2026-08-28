/**
 * AppShell 导航 RBAC（Sprint 5 扩展）：
 * - maintenance_order:read → 显示「维修」入口
 * - 无权限（如 FINANCE）→ 不显示
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { MeOut } from "@/lib/api/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
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
    display_name: null,
    email: null,
    phone: null,
    is_active: true,
    created_at: "x",
    updated_at: "x",
    roles: roles.map((name, i) => ({ id: i + 1, name })),
    permissions,
  };
}

describe("AppShell Maintenance 导航（Sprint 5）", () => {
  it("maintenance_order:read → 显示维修入口（MANAGER / FRONT_DESK / HOUSEKEEPING / MAINTENANCE）", () => {
    for (const perms of [
      ["room:read", "maintenance_order:read"],
      ["room:read", "maintenance_order:read", "maintenance_order:work"],
      ["room:read", "maintenance_order:read", "maintenance_order:write"],
    ]) {
      const { unmount } = render(
        <AppShell user={makeUser(perms, ["MAINTENANCE"])} offline={false}>
          <p>页面内容</p>
        </AppShell>,
      );
      expect(screen.getByRole("link", { name: "维修" })).toHaveAttribute(
        "href",
        "/maintenance",
      );
      unmount();
    }
  });

  it("无 maintenance_order:read → 不显示维修入口（FINANCE）", () => {
    render(
      <AppShell
        user={makeUser(["room:read", "audit:read"], ["FINANCE"])}
        offline={false}
      >
        <p>页面内容</p>
      </AppShell>,
    );
    expect(screen.queryByRole("link", { name: "维修" })).not.toBeInTheDocument();
  });
});
