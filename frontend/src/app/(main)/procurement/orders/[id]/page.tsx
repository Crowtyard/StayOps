import type { Metadata } from "next";
import OrderDetailView from "@/components/procurement/order-detail-view";

export const metadata: Metadata = { title: "采购订单详情" };

export default async function OrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // key 确保切换订单时视图组件重新挂载（状态干净）
  return <OrderDetailView key={id} id={id} />;
}
