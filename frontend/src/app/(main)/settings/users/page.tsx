import type { Metadata } from "next";
import UsersView from "@/components/settings/users-view";

export const metadata: Metadata = { title: "用户管理" };

export default function UsersPage() {
  return <UsersView />;
}
