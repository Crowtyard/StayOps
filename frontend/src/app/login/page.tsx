import type { Metadata } from "next";
import { redirect } from "next/navigation";
import LoginForm from "@/components/login-form";
import { getCurrentUser } from "@/lib/server/auth";

export const metadata: Metadata = { title: "登录" };

export default async function LoginPage() {
  const { user, error } = await getCurrentUser();
  if (user) {
    redirect("/dashboard");
  }
  return <LoginForm offline={error?.kind === "network"} />;
}
