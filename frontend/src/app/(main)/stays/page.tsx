import type { Metadata } from "next";
import StaysView from "@/components/stays-view";

export const metadata: Metadata = { title: "在住管理" };

export default function StaysPage() {
  return <StaysView />;
}
