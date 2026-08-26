import type { Metadata } from "next";
import DashboardView from "@/components/dashboard-view";

export const metadata: Metadata = { title: "当前房态概览" };

export default function DashboardPage() {
  return <DashboardView />;
}
