/**
 * AppShell 导航 RBAC（S2-T2 扩展）：
 * - reservation:read → 显示「预订」；stay:read → 显示「在住」
 * - HOUSEKEEPING / MAINTENANCE / FINANCE 不显示
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

function renderShell(user: MeOut) {
  return render(
    <AppShell user={user} offline={false}>
      <p>页面内容</p>
    </AppShell>,
  );
}

describe("AppShell Booking 导航（S2-T2）", () => {
  it("FRONT_DESK（reservation:read + stay:read）→ 显示预订与在住入口", () => {
    renderShell(
      makeUser(
        ["room:read", "reservation:read", "stay:read"],
        ["FRONT_DESK"],
      ),
    );
    expect(
      screen.getByRole("link", { name: "预订" }),
    ).toHaveAttribute("href", "/reservations");
    expect(
      screen.getByRole("link", { name: "在住" }),
    ).toHaveAttribute("href", "/stays");
  });

  it("HOUSEKEEPING → 不显示预订/在住入口", () => {
    renderShell(makeUser(["room:read", "room:status_cleaning"], ["HOUSEKEEPING"]));
    expect(screen.queryByRole("link", { name: "预订" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "在住" })).not.toBeInTheDocument();
  });

  it("MAINTENANCE / FINANCE → 不显示预订/在住入口", () => {
    renderShell(
      makeUser(["room:read", "room:status_maintenance"], ["MAINTENANCE"]),
    );
    expect(screen.queryByRole("link", { name: "预订" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "在住" })).not.toBeInTheDocument();
  });

  it("仅有 reservation:read（无 stay:read）→ 只显示预订入口", () => {
    renderShell(makeUser(["room:read", "reservation:read"], ["MANAGER"]));
    expect(screen.getByRole("link", { name: "预订" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "在住" })).not.toBeInTheDocument();
  });
});
