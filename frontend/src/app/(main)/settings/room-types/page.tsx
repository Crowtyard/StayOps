import type { Metadata } from "next";
import RoomTypesView from "@/components/settings/room-types-view";

export const metadata: Metadata = { title: "房型管理" };

export default function RoomTypesPage() {
  return <RoomTypesView />;
}
