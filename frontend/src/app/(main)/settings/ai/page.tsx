import type { Metadata } from "next";
import SettingsAiView from "@/components/ai/settings-ai-view";

export const metadata: Metadata = { title: "AI 设置" };

export default function SettingsAiPage() {
  return <SettingsAiView />;
}
