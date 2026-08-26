import { redirect } from "next/navigation";
import AppShell from "@/components/app-shell";
import { getCurrentUser } from "@/lib/server/auth";

/**
 * 受保护区域统一布局：
 * - 服务端读取 HttpOnly Cookie → 调后端 /auth/me 校验登录态
 * - 未登录（401）或账号禁用（403）→ 跳 /login
 * - 后端不可达 → 渲染离线态，页面展示“服务暂时不可用”并可重试
 * - 左侧导航 / 顶栏 / 手机 Drawer 由 AppShell 提供，导航按权限动态显示
 */
export default async function MainLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, error } = await getCurrentUser();

  if (!user && error && (error.kind === "unauthorized" || error.kind === "forbidden")) {
    redirect("/login");
  }

  return (
    <AppShell user={user} offline={error !== null}>
      {children}
    </AppShell>
  );
}
