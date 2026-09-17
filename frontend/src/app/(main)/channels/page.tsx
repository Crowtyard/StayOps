import type { Metadata } from "next";
import ChannelsView from "@/components/channels-view";

export const metadata: Metadata = { title: "渠道管理" };

export default function ChannelsPage() {
  return <ChannelsView />;
}
