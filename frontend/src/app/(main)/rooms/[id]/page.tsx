import type { Metadata } from "next";
import RoomDetailView from "@/components/room-detail-view";

export const metadata: Metadata = { title: "房间详情" };

/**
 * /rooms/[id] 详情页：
 * 动态路由在每次请求时渲染（布局读取 Cookie → 动态），
 * 刷新不会 404；404/网络错误由视图组件展示。
 */
export default async function RoomDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // key 确保切换房间时视图组件重新挂载（状态干净）
  return <RoomDetailView key={id} id={id} />;
}
