import type { Metadata } from "next";
import RolesView from "@/components/settings/roles-view";

export const metadata: Metadata = { title: "角色与权限" };

export default function RolesPage() {
  return <RolesView />;
}
