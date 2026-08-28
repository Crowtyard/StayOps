import type { Metadata } from "next";
import InventoryWorkspaceView from "@/components/inventory/inventory-workspace-view";

export const metadata: Metadata = {
  title: "库存管理",
};

export default function InventoryPage() {
  return <InventoryWorkspaceView />;
}
