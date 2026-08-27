import type { Metadata } from "next";
import ReservationsView from "@/components/reservations-view";

export const metadata: Metadata = { title: "预订管理" };

export default function ReservationsPage() {
  return <ReservationsView />;
}
