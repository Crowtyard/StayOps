import type { Metadata } from "next";
import OrdersView from "@/components/procurement/orders-view";

export const metadata: Metadata = { title: "采购订单" };

export default function OrdersPage() {
  return <OrdersView />;
}
