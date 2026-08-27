import type { Metadata } from "next";
import NewReservationView from "@/components/new-reservation-view";

export const metadata: Metadata = { title: "新建预订" };

export default function NewReservationPage() {
  return <NewReservationView />;
}
