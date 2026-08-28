"use client";

/**
 * Today Summary：今日到店 / 今日离店 / 当前在住 / 空净房 / 需关注。
 * - 全部卡片可点击，点击后在右侧 Drawer 展示对应列表（不跳离 /front-desk）
 * - 空净房 = occupancy available 且 cleaning clean（后端数据实时组合计算）
 * - 需关注 = Attention Center 三条规则命中数
 * - 无 stay:read 时隐藏 今日离店 / 当前在住
 * - 统计条紧凑展示，不占据大量屏幕空间
 */

export type SummaryKind =
  | "arrivals"
  | "departures"
  | "inhouse"
  | "vacantClean"
  | "attention";

export interface TodaySummaryProps {
  counts: Record<SummaryKind, number>;
  showStayCards: boolean;
  onSelect: (kind: SummaryKind) => void;
}

interface CardDef {
  kind: SummaryKind;
  label: string;
  value: number;
  accent: string;
  title: string;
  requireStay?: boolean;
}

export default function TodaySummary({
  counts,
  showStayCards,
  onSelect,
}: TodaySummaryProps) {
  const cards: CardDef[] = [
    {
      kind: "arrivals",
      label: "今日到店",
      value: counts.arrivals,
      accent: "text-blue-600",
      title: "今日到店预订（点击查看列表）",
    },
    {
      kind: "departures",
      label: "今日离店",
      value: counts.departures,
      accent: "text-slate-700",
      title: "今日计划离店（点击查看列表）",
      requireStay: true,
    },
    {
      kind: "inhouse",
      label: "当前在住",
      value: counts.inhouse,
      accent: "text-violet-600",
      title: "当前在住（点击查看列表）",
      requireStay: true,
    },
    {
      kind: "vacantClean",
      label: "空净房",
      value: counts.vacantClean,
      accent: "text-emerald-600",
      title: "可售且干净的房间（点击查看列表）",
    },
    {
      kind: "attention",
      label: "需关注",
      value: counts.attention,
      accent: counts.attention > 0 ? "text-red-600" : "text-gray-900",
      title: "注意力中心：未准备到店房 / 超期在住 / 房间不可用",
    },
  ];

  return (
    <section
      aria-label="今日概览"
      className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5"
    >
      {cards
        .filter((c) => !c.requireStay || showStayCards)
        .map((card) => (
          <button
            key={card.kind}
            type="button"
            onClick={() => onSelect(card.kind)}
            title={card.title}
            data-summary-card={card.kind}
            className="rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-left shadow-sm transition-colors hover:border-gray-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900"
          >
            <p className="truncate text-xs text-gray-500">{card.label}</p>
            <p
              className={`mt-1 text-xl font-semibold tabular-nums ${card.accent}`}
            >
              {card.value}
            </p>
          </button>
        ))}
    </section>
  );
}
