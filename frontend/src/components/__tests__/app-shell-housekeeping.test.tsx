/**
 * AppShell 导航 RBAC（Sprint 3 扩展）：
 * - housekeeping_task:read → 显示「保洁」入口
 * - 无权限（如 MAINTENANCE）→ 不显示
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

describe("AppShell Housekeeping 导航（Sprint 3）", () => {
  it("housekeeping_task:read → 显示保洁入口（FRONT_DESK / HOUSEKEEPING）", () => {
    for (const perms of [
      ["room:read", "housekeeping_task:read", "housekeeping_task:write"],
      ["room:read", "housekeeping_task:read", "housekeeping_task:work", "housekeeping_task:inspect"],
    ]) {
      const { unmount } = render(
        <AppShell user={makeUser(perms, ["FRONT_DESK"])} offline={false}>
          <p>页面内容</p>
        </AppShell>,
      );
      expect(screen.getByRole("link", { name: "保洁" })).toHaveAttribute(
        "href",
        "/housekeeping",
      );
      unmount();
    }
  });

  it("无 housekeeping_task:read → 不显示保洁入口（MAINTENANCE）", () => {
    render(
      <AppShell
        user={makeUser(["room:read", "room:status_maintenance"], ["MAINTENANCE"])}
        offline={false}
      >
        <p>页面内容</p>
      </AppShell>,
    );
    expect(screen.queryByRole("link", { name: "保洁" })).not.toBeInTheDocument();
  });
});
