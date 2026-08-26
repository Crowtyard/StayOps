import type { Metadata } from "next";
import AuditLogsView from "@/components/settings/audit-logs-view";

export const metadata: Metadata = { title: "审计日志" };

export default function AuditLogsPage() {
  return <AuditLogsView />;
}
