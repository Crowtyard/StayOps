import type { Metadata } from "next";
import HousekeepingWorkspaceView from "@/components/housekeeping-workspace-view";

export const metadata: Metadata = {
  title: "保洁运营",
};

export default function HousekeepingPage() {
  return <HousekeepingWorkspaceView />;
}
