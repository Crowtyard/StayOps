import type { Metadata } from "next";
import MaintenanceWorkOrderDetailView from "@/components/maintenance/maintenance-work-order-detail-view";

export const metadata: Metadata = { title: "维修工单详情" };

export default async function MaintenanceWorkOrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // key 确保切换工单时视图组件重新挂载（状态干净）
  return <MaintenanceWorkOrderDetailView key={id} id={id} />;
}
