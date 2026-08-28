import type { Metadata } from "next";
import InventoryItemDetailView from "@/components/inventory/inventory-item-detail-view";

export const metadata: Metadata = { title: "物资详情" };

export default async function InventoryItemDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // key 确保切换物资时视图组件重新挂载（状态干净）
  return <InventoryItemDetailView key={id} id={id} />;
}
