/**
 * AppShell 导航 RBAC（Sprint 9 §22/§38/§40）：
 * - ai_manager:use → 显示「AI 店长」入口（SUPER_ADMIN / MANAGER / FRONT_DESK / FINANCE）
 * - HOUSEKEEPING / MAINTENANCE 无 ai_manager:use → 不显示
 * - ai_manager:manage → 显示「AI 设置」入口（仅 SUPER_ADMIN / MANAGER）
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

describe("AppShell AI Manager 导航（Sprint 9 §22/§38/§40）", () => {
  it("ai_manager:use → 显示「AI 店长」入口（SUPER_ADMIN / MANAGER / FRONT_DESK / FINANCE）", () => {
    for (const role of ["SUPER_ADMIN", "MANAGER", "FRONT_DESK", "FINANCE"]) {
      const { unmount } = render(
        <AppShell user={makeUser(["ai_manager:use"], [role])} offline={false}>
          <p>页面内容</p>
        </AppShell>,
      );
      expect(screen.getByRole("link", { name: "AI 店长" })).toHaveAttribute(
        "href",
        "/ai-manager",
      );
      unmount();
    }
  });

  it("HOUSEKEEPING / MAINTENANCE（无 ai_manager:use）→ 不显示「AI 店长」", () => {
    for (const role of ["HOUSEKEEPING", "MAINTENANCE"]) {
      const { unmount } = render(
        <AppShell
          user={makeUser(
            ["room:read", "housekeeping_task:read"],
            [role],
          )}
          offline={false}
        >
          <p>页面内容</p>
        </AppShell>,
      );
      expect(
        screen.queryByRole("link", { name: "AI 店长" }),
      ).not.toBeInTheDocument();
      unmount();
    }
  });

  it("ai_manager:manage → 显示「AI 设置」入口（仅 SUPER_ADMIN / MANAGER）", () => {
    for (const role of ["SUPER_ADMIN", "MANAGER"]) {
      const { unmount } = render(
        <AppShell user={makeUser(["ai_manager:manage"], [role])} offline={false}>
          <p>页面内容</p>
        </AppShell>,
      );
      expect(screen.getByRole("link", { name: "AI 设置" })).toHaveAttribute(
        "href",
        "/settings/ai",
      );
      unmount();
    }
  });

  it("FRONT_DESK（ai_manager:use 无 ai_manager:manage）→ 有 AI 店长、无 AI 设置", () => {
    render(
      <AppShell
        user={makeUser(["ai_manager:use", "analytics:operations_read"], ["FRONT_DESK"])}
        offline={false}
      >
        <p>页面内容</p>
      </AppShell>,
    );
    expect(screen.getByRole("link", { name: "AI 店长" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "AI 设置" })).not.toBeInTheDocument();
  });

  it("FINANCE（ai_manager:use 无 ai_manager:manage）→ 有 AI 店长、无 AI 设置", () => {
    render(
      <AppShell
        user={makeUser(["ai_manager:use", "analytics:business_read"], ["FINANCE"])}
        offline={false}
      >
        <p>页面内容</p>
      </AppShell>,
    );
    expect(screen.getByRole("link", { name: "AI 店长" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "AI 设置" })).not.toBeInTheDocument();
  });

  it("无任何 AI 权限 → 两个入口都不显示", () => {
    render(
      <AppShell user={makeUser(["room:read"], ["HOUSEKEEPING"])} offline={false}>
        <p>页面内容</p>
      </AppShell>,
    );
    expect(screen.queryByRole("link", { name: "AI 店长" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "AI 设置" })).not.toBeInTheDocument();
  });
});
