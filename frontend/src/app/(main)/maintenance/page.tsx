import type { Metadata } from "next";
import MaintenanceWorkspaceView from "@/components/maintenance/maintenance-workspace-view";

export const metadata: Metadata = {
  title: "维修运营",
};

export default function MaintenancePage() {
  return <MaintenanceWorkspaceView />;
}
