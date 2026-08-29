"use client";

/**
 * 极简 SVG 图表组件（Sprint 8）。
 *
 * 背景：npm registry 在当前网络策略下不可达（E403），无法安装成熟图表库；
 * 本组件只为固定几种图表形态（折线 / 柱状）提供最小实现，不是通用 chart
 * engine（Sprint 8 §50：禁止手写复杂 chart engine）。
 *
 * 可访问性（§51）：readable labels、每点 <title> 值访问、mobile 自适应
 * （viewBox 等比缩放）；重要数值同时以表格/文字提供，不只靠颜色。
 */

export interface ChartPoint {
  label: string;
  value: number;
}

const CHART_TEXT = "fill-gray-500 text-[10px]";
const CHART_LINE = "stroke-gray-200";

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(value)));
  const unit = value / pow;
  const nice = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10;
  return nice * pow;
}

/** 折线图：数据点 + 坐标轴 + 每点 title 提示（空数据返回占位） */
export function LineChart({
  data,
  formatValue,
  height = 170,
  color = "#2563eb",
}: {
  data: ChartPoint[];
  formatValue: (value: number) => string;
  height?: number;
  color?: string;
}) {
  const width = 640;
  const padX = 34;
  const padTop = 12;
  const padBottom = 26;
  const innerW = width - padX - 10;
  const innerH = height - padTop - padBottom;

  if (data.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-md border border-gray-200 text-sm text-gray-400"
        style={{ height }}
        role="img"
        aria-label="暂无数据"
      >
        暂无数据
      </div>
    );
  }

  const max = niceMax(Math.max(...data.map((p) => p.value)));
  const stepX = data.length > 1 ? innerW / (data.length - 1) : innerW;
  const points = data.map((p, i) => ({
    ...p,
    x: padX + i * stepX,
    y: padTop + innerH - (max === 0 ? 0 : (p.value / max) * innerH),
  }));
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
  const labelEvery = Math.max(1, Math.ceil(data.length / 6));

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-auto w-full"
      role="img"
      aria-label={`趋势图，共 ${data.length} 个数据点`}
    >
      {/* 水平参考线 + Y 轴最大值 */}
      <line x1={padX} y1={padTop} x2={width - 10} y2={padTop} className={CHART_LINE} />
      <line x1={padX} y1={padTop} x2={padX} y2={padTop + innerH} className={CHART_LINE} />
      <text x={padX - 6} y={padTop + 3} textAnchor="end" className={CHART_TEXT}>
        {formatValue(max)}
      </text>
      <line x1={padX} y1={padTop + innerH} x2={width - 10} y2={padTop + innerH} className={CHART_LINE} />
      {/* 折线 */}
      <path d={path} fill="none" stroke={color} strokeWidth="2" />
      {/* 数据点 + title 值访问 */}
      {points.map((p, i) => (
        <g key={`${p.label}-${i}`}>
          <circle cx={p.x} cy={p.y} r="3" fill={color} />
          <title>{`${p.label}：${formatValue(p.value)}`}</title>
        </g>
      ))}
      {/* X 轴标签（稀疏） */}
      {points.map((p, i) =>
        i % labelEvery === 0 ? (
          <text key={p.label} x={p.x} y={height - 8} textAnchor="middle" className={CHART_TEXT}>
            {p.label}
          </text>
        ) : null,
      )}
    </svg>
  );
}

/** 柱状图：每根柱带数值 title（空数据返回占位） */
export function BarChart({
  data,
  formatValue,
  height = 170,
  color = "#0f766e",
}: {
  data: ChartPoint[];
  formatValue: (value: number) => string;
  height?: number;
  color?: string;
}) {
  const width = 640;
  const padX = 34;
  const padTop = 18;
  const padBottom = 26;
  const innerW = width - padX - 10;
  const innerH = height - padTop - padBottom;

  if (data.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-md border border-gray-200 text-sm text-gray-400"
        style={{ height }}
        role="img"
        aria-label="暂无数据"
      >
        暂无数据
      </div>
    );
  }

  const max = niceMax(Math.max(...data.map((p) => p.value)));
  const slot = innerW / data.length;
  const barW = Math.max(8, Math.min(44, slot * 0.6));
  const labelEvery = Math.max(1, Math.ceil(data.length / 8));

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-auto w-full"
      role="img"
      aria-label={`分布图，共 ${data.length} 个数据点`}
    >
      <line x1={padX} y1={padTop} x2={padX} y2={padTop + innerH} className={CHART_LINE} />
      <line x1={padX} y1={padTop + innerH} x2={width - 10} y2={padTop + innerH} className={CHART_LINE} />
      {data.map((p, i) => {
        const barH = max === 0 ? 0 : (p.value / max) * innerH;
        const x = padX + i * slot + (slot - barW) / 2;
        const y = padTop + innerH - barH;
        return (
          <g key={`${p.label}-${i}`}>
            <rect x={x} y={y} width={barW} height={barH} fill={color} rx="2" />
            <title>{`${p.label}：${formatValue(p.value)}`}</title>
            {i % labelEvery === 0 ? (
              <text x={padX + i * slot + slot / 2} y={height - 8} textAnchor="middle" className={CHART_TEXT}>
                {p.label}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}
