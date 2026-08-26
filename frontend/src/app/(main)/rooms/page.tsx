import type { Metadata } from "next";
import RoomsView from "@/components/rooms-view";

export const metadata: Metadata = { title: "房态棋盘" };

export default function RoomsPage() {
  return <RoomsView />;
}
