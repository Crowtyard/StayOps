"use client";

import { changeTone, fmtPercentChange, fmtPpDelta } from "@/lib/analytics";
import { IconTrendDown, IconTrendFlat, IconTrendUp } from "@/components/icons";

/** KPI 卡片：数值 + 可选对比变化（§32 显示语义） */
export interface KpiCardProps {
  label: string;
  value: string;
  /** 对比文案（"与上一周期对比" 开启时展示变化） */
  change?: string | null;
  /** change 的来源值（pp 或 percent，用于箭头方向与色调） */
  changeValue?: number | null;
  hint?: string;
  accent?: "default" | "good" | "warn" | "bad";
}

const ACCENT_TEXT: Record<NonNullable<KpiCardProps["accent"]>, string> = {
  default: "text-gray-900",
  good: "text-emerald-700",
  warn: "text-amber-700",
  bad: "text-red-700",
};

function ChangeIcon({ value }: { value: number | null | undefined }) {
  const tone = changeTone(value);
  if (tone === "up") return <IconTrendUp className="size-3.5" />;
  if (tone === "down") return <IconTrendDown className="size-3.5" />;
  if (tone === "flat") return <IconTrendFlat className="size-3.5" />;
  return null;
}

export default function KpiCard({
  label,
  value,
  change,
  changeValue,
  hint,
  accent = "default",
}: KpiCardProps) {
  const tone = changeTone(changeValue);
  const changeColor =
    tone === "up"
      ? "text-emerald-600"
      : tone === "down"
        ? "text-red-600"
        : "text-gray-400";
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3.5">
      <p className="text-xs font-medium text-gray-500" title={hint}>
        {label}
      </p>
      <p className={`mt-1 text-xl font-semibold tabular-nums ${ACCENT_TEXT[accent]}`}>
        {value}
      </p>
      {change != null ? (
        <p className={`mt-1 flex items-center gap-1 text-xs tabular-nums ${changeColor}`}>
          <ChangeIcon value={changeValue} />
          {change}
        </p>
      ) : null}
    </div>
  );
}

/** 由后端对比结果构造 KPI 变化文案（§32：比率 -> pp；数量/金额/平均 -> percent） */
export function kpiChange(
  change: { percent_change?: number | null; pp_delta?: number | null } | null | undefined,
): { text: string; value: number | null } | null {
  if (!change) return null;
  if (change.pp_delta != null) {
    return { text: fmtPpDelta(change.pp_delta), value: change.pp_delta };
  }
  if (change.percent_change != null) {
    return { text: fmtPercentChange(change.percent_change), value: change.percent_change };
  }
  return null;
}
