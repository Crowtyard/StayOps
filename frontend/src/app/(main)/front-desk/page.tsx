import type { Metadata } from "next";
import FrontDeskView from "@/components/front-desk/front-desk-view";

export const metadata: Metadata = { title: "前台指挥台" };

export default function FrontDeskPage() {
  return <FrontDeskView />;
}
