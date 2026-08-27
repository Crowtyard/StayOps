"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { logout } from "@/lib/api";
import type { MeOut } from "@/lib/api/types";
import {
  IconAudit,
  IconBooking,
  IconBuilding,
  IconHome,
  IconLogout,
  IconMenu,
  IconRefresh,
  IconRooms,
  IconShield,
  IconStay,
  IconTag,
  IconUsers,
  IconX,
} from "@/components/icons";

const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "StayOps";

const UserContext = createContext<MeOut | null>(null);

/** 客户端组件中读取当前登录用户（角色 + 权限） */
export function useUser(): MeOut | null {
  return useContext(UserContext);
}

/** 供测试环境注入用户上下文（页面组件经 useUser 读取） */
export { UserContext };

interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
  permission?: string;
}

const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "首页", icon: <IconHome /> },
  { href: "/rooms", label: "房态", icon: <IconRooms />, permission: "room:read" },
  {
    href: "/reservations",
    label: "预订",
    icon: <IconBooking />,
    permission: "reservation:read",
  },
  { href: "/stays", label: "在住", icon: <IconStay />, permission: "stay:read" },
  {
    href: "/settings/room-types",
    label: "房型",
    icon: <IconTag />,
    permission: "room_type:read",
  },
  {
    href: "/settings/users",
    label: "用户",
    icon: <IconUsers />,
    permission: "user:read",
  },
  {
    href: "/settings/roles",
    label: "角色与权限",
    icon: <IconShield />,
    permission: "role:read",
  },
  {
    href: "/settings/audit-logs",
    label: "审计日志",
    icon: <IconAudit />,
    permission: "audit:read",
  },
];

function visibleItems(user: MeOut | null): NavItem[] {
  if (!user) return NAV_ITEMS.filter((i) => !i.permission);
  const perms = new Set(user.permissions);
  return NAV_ITEMS.filter((i) => !i.permission || perms.has(i.permission));
}

interface AppShellProps {
  user: MeOut | null;
  /** 后端不可达（无法校验登录态） */
  offline: boolean;
  children: React.ReactNode;
}

export default function AppShell({ user, offline, children }: AppShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const items = visibleItems(user);
  const roleLabel =
    user && user.roles.length > 0
      ? user.roles.map((r) => r.name).join("、")
      : "—";

  useEffect(() => {
    if (!drawerOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [drawerOpen]);

  const handleLogout = useCallback(async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await logout();
    } catch {
      // 网络异常也继续本地退出，跳回登录页
    } finally {
      router.replace("/login");
      router.refresh();
    }
  }, [loggingOut, router]);

  const navList = (
    <nav aria-label="主导航" className="flex flex-1 flex-col gap-1 px-3 py-4">
      {items.map((item) => {
        const active =
          item.href === "/dashboard"
            ? pathname === "/dashboard"
            : pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            onClick={() => setDrawerOpen(false)}
            className={`group flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900 ${
              active
                ? "bg-gray-900 text-white"
                : "text-gray-700 hover:bg-gray-100"
            }`}
          >
            <span className="[&>svg]:size-5">{item.icon}</span>
            <span className="flex-1">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );

  const brand = (
    <div className="flex items-center gap-2.5 px-3">
      <span className="flex size-9 items-center justify-center rounded-md bg-gray-900 text-white">
        <IconBuilding className="size-5" />
      </span>
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-gray-900">{APP_NAME}</p>
        <p className="truncate text-xs text-gray-500">住宿运营系统</p>
      </div>
    </div>
  );

  return (
    <UserContext.Provider value={user}>
      <div className="flex min-h-screen">
        {/* 桌面端侧边栏 */}
        <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-gray-200 bg-white lg:flex">
          <div className="flex h-14 items-center border-b border-gray-200">
            {brand}
          </div>
          {navList}
          <div className="border-t border-gray-200 px-4 py-3 text-xs text-gray-400">
            © StayOps · 内部系统
          </div>
        </aside>

        {/* 手机端 Drawer */}
        {drawerOpen ? (
          <div className="fixed inset-0 z-50 lg:hidden">
            <button
              type="button"
              aria-label="关闭导航菜单"
              className="absolute inset-0 bg-gray-900/40"
              onClick={() => setDrawerOpen(false)}
              tabIndex={-1}
            />
            <div
              className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-white shadow-xl"
              role="dialog"
              aria-modal="true"
              aria-label="导航菜单"
            >
              <div className="flex h-14 items-center justify-between border-b border-gray-200 pr-2">
                {brand}
                <button
                  type="button"
                  aria-label="关闭导航菜单"
                  onClick={() => setDrawerOpen(false)}
                  className="rounded-md p-2 text-gray-500 hover:bg-gray-100"
                >
                  <IconX className="size-5" />
                </button>
              </div>
              {navList}
            </div>
          </div>
        ) : null}

        {/* 主区域 */}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-gray-200 bg-white px-4">
            <button
              type="button"
              aria-label="打开导航菜单"
              onClick={() => setDrawerOpen(true)}
              className="rounded-md p-2 text-gray-600 hover:bg-gray-100 lg:hidden"
            >
              <IconMenu className="size-5" />
            </button>
            <p className="hidden text-sm font-medium text-gray-500 lg:block">
              {APP_NAME}
            </p>
            <div className="flex-1" />
            {offline ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-800 ring-1 ring-inset ring-amber-300">
                后端服务暂时不可用
              </span>
            ) : null}
            <button
              type="button"
              aria-label="刷新页面"
              onClick={() => window.location.reload()}
              className="rounded-md p-2 text-gray-500 hover:bg-gray-100"
            >
              <IconRefresh className="size-4" />
            </button>
            {user ? (
              <div className="flex items-center gap-3">
                <div className="hidden text-right sm:block">
                  <p className="text-sm font-medium leading-tight text-gray-900">
                    {user.display_name || user.username}
                  </p>
                  <p className="text-xs leading-tight text-gray-500">{roleLabel}</p>
                </div>
                <button
                  type="button"
                  onClick={handleLogout}
                  disabled={loggingOut}
                  className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  <IconLogout className="size-3.5" />
                  {loggingOut ? "退出中…" : "退出"}
                </button>
              </div>
            ) : (
              <span className="text-sm text-gray-400">未登录</span>
            )}
          </header>
          <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6">
            {children}
          </main>
        </div>
      </div>
    </UserContext.Provider>
  );
}
