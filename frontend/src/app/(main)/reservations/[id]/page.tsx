import type { Metadata } from "next";
import ReservationDetailView from "@/components/reservation-detail-view";

export const metadata: Metadata = { title: "预订详情" };

export default async function ReservationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // key 确保切换预订时视图组件重新挂载（状态干净）
  return <ReservationDetailView key={id} id={id} />;
}
