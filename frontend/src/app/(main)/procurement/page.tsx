import type { Metadata } from "next";
import ProcurementWorkbenchView from "@/components/procurement/procurement-workbench-view";

export const metadata: Metadata = {
  title: "采购工作台",
};

export default function ProcurementPage() {
  return <ProcurementWorkbenchView />;
}
