import type { Metadata } from "next";
import SuppliersView from "@/components/procurement/suppliers-view";

export const metadata: Metadata = { title: "供应商管理" };

export default function SuppliersPage() {
  return <SuppliersView />;
}
