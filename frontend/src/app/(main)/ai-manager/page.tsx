import type { Metadata } from "next";
import AiManagerView from "@/components/ai/ai-manager-view";

export const metadata: Metadata = { title: "AI 店长" };

export default function AiManagerPage() {
  return <AiManagerView />;
}
