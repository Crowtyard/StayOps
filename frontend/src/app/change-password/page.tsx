import type { Metadata } from "next";
import { redirect } from "next/navigation";
import ChangePasswordForm from "@/components/change-password-form";
import { getCurrentUser } from "@/lib/server/auth";

export const metadata: Metadata = { title: "修改初始密码" };

/**
 * D2 首次安装强制改密页（/change-password）：
 * - 未登录 → /login
 * - 无需改密（must_change_password=false）→ /dashboard
 * - bootstrap 管理员在此设置自己的新密码；后端清除标记后即可正常使用
 */
export default async function ChangePasswordPage() {
  const { user, error } = await getCurrentUser();
  if (!user && error && (error.kind === "unauthorized" || error.kind === "forbidden")) {
    redirect("/login");
  }
  if (user && !user.must_change_password) {
    redirect("/dashboard");
  }
  return <ChangePasswordForm username={user?.username ?? "admin"} />;
}
