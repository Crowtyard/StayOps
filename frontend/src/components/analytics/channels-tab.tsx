"use client";

/**
 * 客源渠道经营分析 Tab（alpha.9.6 F4「客人从哪里来」）。
 *
 * 口径（LOCKED，后端权威，见 docs/DECISIONS.md）：
 * - 订单数 = Arrival Cohort 且排除 CANCELLED / NO_SHOW
 * - 实际房晚 = Stay 派生（换房不重复计数）
 * - 合同房费 = 复用既有经营分析同一事实源（agreed_total_amount 按计划房晚分摊
 *   到实际占用房晚）。**不是实际收款**（StayOps 无 Folio / Payment / Settlement）
 * - 渠道占比 / 合同 ADR 分母 0 -> null（禁止 NaN）
 *
 * UI 原则：**表格数据第一优先**（可核验），柱状图仅作补充。
 */

import type { BusinessChannelsOut, ChannelPerformanceRow } from "@/lib/api/types";
import { fmtCount, fmtMoney, fmtRate } from "@/lib/analytics";
import { channelCategoryLabel } from "@/lib/channels";
import { BarChart, type ChartPoint } from "./charts";
import KpiCard from "./kpi-card";
import { PermissionNote, SectionCard } from "./shared";

export interface ChannelsTabProps {
  channels: BusinessChannelsOut | null;
}

function fmtShare(share: number | null | undefined): string {
  if (share === null || share === undefined) return "—";
  return `${(share * 100).toFixed(1)}%`;
}

function fmtAdr(value: string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `¥${Number(value).toFixed(2)}`;
}

/** 把「未指定渠道」桶并入展示行（保持 Σ 与合计一致，可核验）。 */
function displayRows(data: BusinessChannelsOut): ChannelPerformanceRow[] {
  const rows = [...data.channels];
  const unassigned = data.unassigned;
  if (unassigned && unassigned.order_count + unassigned.occupied_room_nights > 0) {
    rows.push(unassigned);
  }
  return rows;
}

export default function ChannelsTab({ channels }: ChannelsTabProps) {
  if (!channels) {
    return (
      <PermissionNote text="客源渠道经营分析需要经营分析权限（analytics:business_read）" />
    );
  }

  const rows = displayRows(channels);
  const withBusiness = rows.filter(
    (r) => r.order_count > 0 || r.occupied_room_nights > 0,
  );
  const chartData: ChartPoint[] = [...withBusiness]
    .sort(
      (a, b) =>
        Number(b.contracted_room_value) - Number(a.contracted_room_value),
    )
    .slice(0, 8)
    .map((r) => ({ label: r.channel_name, value: Number(r.contracted_room_value) }));

  const topOrders = [...withBusiness].sort(
    (a, b) => b.order_count - a.order_count,
  )[0];
  const topValue = [...withBusiness].sort(
    (a, b) => Number(b.contracted_room_value) - Number(a.contracted_room_value),
  )[0];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard
          label="渠道订单数"
          value={fmtCount(channels.totals.order_count)}
          hint={
            topOrders ? `订单最多：${topOrders.channel_name}` : "区间内暂无订单"
          }
        />
        <KpiCard
          label="实际房晚"
          value={fmtCount(channels.totals.occupied_room_nights)}
        />
        <KpiCard
          label="合同房费"
          value={fmtMoney(channels.totals.contracted_room_value)}
          hint={
            topValue ? `最高：${topValue.channel_name}` : "区间内暂无房费"
          }
        />
        <KpiCard
          label="合同 ADR"
          value={fmtAdr(channels.totals.contracted_adr)}
          hint="合同房费 ÷ 有价实际房晚"
        />
      </div>

      <SectionCard
        title="渠道经营分析"
        hint="合同房费为非实际收款（StayOps 无收银/结算模块）；取消与未到店订单不计入"
      >
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs text-gray-500">
                <th className="px-3 py-2 font-medium">渠道</th>
                <th className="px-3 py-2 font-medium">类别</th>
                <th className="px-3 py-2 text-right font-medium">订单数</th>
                <th className="px-3 py-2 text-right font-medium">实际房晚</th>
                <th className="px-3 py-2 text-right font-medium">合同房费</th>
                <th className="px-3 py-2 text-right font-medium">占比</th>
                <th className="px-3 py-2 text-right font-medium">合同 ADR</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((row) => (
                <tr
                  key={row.channel_id ?? "unassigned"}
                  className={row.channel_id === null ? "text-gray-500" : ""}
                >
                  <td className="px-3 py-2 font-medium text-gray-900">
                    {row.channel_name}
                    {row.channel_enabled === false ? (
                      <span className="ml-1.5 rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-500">
                        已停用
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-gray-500">
                    {row.channel_category
                      ? channelCategoryLabel(row.channel_category)
                      : "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {fmtCount(row.order_count)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {fmtCount(row.occupied_room_nights)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {fmtMoney(row.contracted_room_value)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {fmtShare(row.share)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {fmtAdr(row.contracted_adr)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-gray-300 font-medium text-gray-900">
                <td className="px-3 py-2">合计</td>
                <td className="px-3 py-2" />
                <td className="px-3 py-2 text-right tabular-nums">
                  {fmtCount(channels.totals.order_count)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {fmtCount(channels.totals.occupied_room_nights)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {fmtMoney(channels.totals.contracted_room_value)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {channels.totals.contracted_room_value === "0.00"
                    ? "—"
                    : fmtRate(1)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {fmtAdr(channels.totals.contracted_adr)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
        {withBusiness.length === 0 ? (
          <p className="mt-3 text-sm text-gray-400">
            该区间内没有渠道业务数据（订单数与房费均为 0）
          </p>
        ) : null}
      </SectionCard>

      {chartData.length > 0 ? (
        <SectionCard
          title="渠道合同房费分布"
          hint="按合同房费降序，最多显示 8 个渠道（图表仅为补充，以上表为准）"
        >
          <BarChart data={chartData} formatValue={(v) => `¥${v.toFixed(0)}`} />
        </SectionCard>
      ) : null}
    </div>
  );
}
