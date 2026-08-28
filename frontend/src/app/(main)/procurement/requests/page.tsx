import type { Metadata } from "next";
import RequestsView from "@/components/procurement/requests-view";

export const metadata: Metadata = { title: "采购申请" };

export default function RequestsPage() {
  return <RequestsView />;
}
