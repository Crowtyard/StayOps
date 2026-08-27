import type { Metadata } from "next";
import HousekeepingTaskDetailView from "@/components/housekeeping-task-detail-view";

export const metadata: Metadata = { title: "保洁任务详情" };

export default async function HousekeepingTaskDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // key 确保切换任务时视图组件重新挂载（状态干净）
  return <HousekeepingTaskDetailView key={id} id={id} />;
}
