/**
 * AppShell 导航 RBAC（Sprint 7 §46）：
 * - inventory:read → 显示「库存」入口
 * - procurement:read → 显示「采购」入口
 * - 无权限（如 MAINTENANCE 无 procurement:read）→ 不显示对应入口
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

describe("AppShell Inventory / Procurement 导航（Sprint 7 §46）", () => {
  it("inventory:read → 显示库存入口（全角色矩阵）", () => {
    for (const role of [
      "SUPER_ADMIN",
      "MANAGER",
      "FRONT_DESK",
      "HOUSEKEEPING",
      "MAINTENANCE",
      "FINANCE",
    ]) {
      const { unmount } = render(
        <AppShell user={makeUser(["inventory:read"], [role])} offline={false}>
          <p>页面内容</p>
        </AppShell>,
      );
      expect(screen.getByRole("link", { name: "库存" })).toHaveAttribute(
        "href",
        "/inventory",
      );
      unmount();
    }
  });

  it("procurement:read → 显示采购入口（SUPER_ADMIN / MANAGER / FRONT_DESK / FINANCE）", () => {
    for (const role of ["SUPER_ADMIN", "MANAGER", "FRONT_DESK", "FINANCE"]) {
      const { unmount } = render(
        <AppShell user={makeUser(["procurement:read"], [role])} offline={false}>
          <p>页面内容</p>
        </AppShell>,
      );
      expect(screen.getByRole("link", { name: "采购" })).toHaveAttribute(
        "href",
        "/procurement",
      );
      unmount();
    }
  });

  it("无 inventory:read → 不显示库存入口", () => {
    render(
      <AppShell user={makeUser(["room:read"], ["FINANCE"])} offline={false}>
        <p>页面内容</p>
      </AppShell>,
    );
    expect(screen.queryByRole("link", { name: "库存" })).not.toBeInTheDocument();
  });

  it("HOUSEKEEPING（procurement:request 但无 procurement:read）→ 不显示采购入口", () => {
    render(
      <AppShell
        user={makeUser(
          ["inventory:read", "inventory:issue", "procurement:request"],
          ["HOUSEKEEPING"],
        )}
        offline={false}
      >
        <p>页面内容</p>
      </AppShell>,
    );
    expect(screen.queryByRole("link", { name: "采购" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "库存" })).toBeInTheDocument();
  });
});
