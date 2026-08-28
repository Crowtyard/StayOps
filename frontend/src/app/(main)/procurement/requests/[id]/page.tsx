import type { Metadata } from "next";
import RequestDetailView from "@/components/procurement/request-detail-view";

export const metadata: Metadata = { title: "采购申请详情" };

export default async function RequestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // key 确保切换申请时视图组件重新挂载（状态干净）
  return <RequestDetailView key={id} id={id} />;
}
