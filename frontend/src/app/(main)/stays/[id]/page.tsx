import type { Metadata } from "next";
import StayDetailView from "@/components/stay-detail-view";

export const metadata: Metadata = { title: "在住详情" };

export default async function StayDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // key 确保切换入住记录时视图组件重新挂载（状态干净）
  return <StayDetailView key={id} id={id} />;
}
