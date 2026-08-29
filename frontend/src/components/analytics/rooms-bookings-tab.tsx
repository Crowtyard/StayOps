"use client";

import type {
  BookingsOut,
  BusinessRoomsOut,
  ForecastOut,
} from "@/lib/api/types";
import {
  fmtCount,
  fmtDays,
  fmtMoney,
  fmtRate,
} from "@/lib/analytics";
import { BarChart, LineChart, type ChartPoint } from "./charts";
import KpiCard from "./kpi-card";
import { PermissionNote, SectionCard } from "./shared";

export interface RoomsBookingsTabProps {
  bookings: BookingsOut | null;
  forecast: ForecastOut | null;
  rooms: BusinessRoomsOut | null;
}

function shortLabel(dateStr: string): string {
  return dateStr.slice(5); // MM-DD
}

/** 客房与预订 Tab（§46）：占用趋势 / 在册预测 / 提前天数分布 / 取消·未到店 / ALOS / 换房 */
export default function RoomsBookingsTab({
  bookings,
  forecast,
  rooms,
}: RoomsBookingsTabProps) {
  const hasOps = bookings != null;

  if (!hasOps) {
    return (
      <PermissionNote text="客房与预订分析需要运营分析权限（analytics:operations_read）" />
    );
  }

  const occupancyTrend: ChartPoint[] = bookings.daily.map((d) => ({
    label: shortLabel(d.business_date),
    value: d.occupied_room_nights,
  }));
  const occupancyRateTrend: ChartPoint[] = bookings.daily.map((d) => ({
    label: shortLabel(d.business_date),
    value: d.occupancy_rate ?? 0,
  }));
  const forecastTrend: ChartPoint[] = (forecast?.daily ?? []).map((d) => ({
    label: shortLabel(d.business_date),
    value: d.on_books_room_nights,
  }));
  const leadDistribution: ChartPoint[] = bookings.booking_lead_distribution.map(
    (b) => ({ label: b.bucket, value: b.count }),
  );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard
          label="计划到店"
          value={fmtCount(bookings.scheduled_arrivals)}
          hint={`取消 ${bookings.cancelled_arrivals} 单`}
        />
        <KpiCard
          label="取消率"
          value={fmtRate(bookings.cancellation_rate)}
        />
        <KpiCard
          label="未到店率"
          value={fmtRate(bookings.no_show_rate)}
          hint={`未到店 ${bookings.no_show_count} 单`}
        />
        <KpiCard
          label="平均预订提前"
          value={fmtDays(bookings.average_booking_lead_days)}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label="平均住宿时长" value={fmtDays(bookings.average_length_of_stay)} />
        <KpiCard
          label="完成住宿数"
          value={fmtCount(bookings.completed_stays)}
        />
        <KpiCard label="换房次数" value={fmtCount(bookings.room_move_count)} />
        <KpiCard
          label="换房率"
          value={fmtRate(bookings.room_move_rate)}
          hint={`涉及 ${bookings.moved_stay_count} 个住宿`}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <SectionCard title="物理入住率趋势" hint="每日实际占用 ÷ 当日物理房数">
          <LineChart
            data={occupancyRateTrend}
            formatValue={(v) => fmtRate(v / 100)}
            color="#0f766e"
          />
        </SectionCard>
        <SectionCard title="实际占用房晚趋势" hint="每日实际占用房晚（Actual）">
          <LineChart data={occupancyTrend} formatValue={(v) => fmtCount(v)} />
        </SectionCard>
      </div>

      <SectionCard title="在册预测（未来 30 天）" hint="On-Books：已确认预订 + 在住剩余计划（distinct 房晚）">
        <LineChart
          data={forecastTrend}
          formatValue={(v) => fmtCount(v)}
          color="#7c3aed"
        />
      </SectionCard>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <SectionCard title="预订提前天数分布" hint="非取消预订按提前天数分桶（Bucket 由后端权威计算）">
          <BarChart data={leadDistribution} formatValue={(v) => fmtCount(v)} />
        </SectionCard>

        {rooms ? (
          <SectionCard
            title="合同房费趋势"
            hint="每日合同房费金额（非实际收款）"
          >
            <BarChart
              data={rooms.daily.map((d) => ({
                label: shortLabel(d.business_date),
                value: Number(d.contracted_room_value),
              }))}
              formatValue={(v) => fmtMoney(String(v))}
              color="#b45309"
            />
          </SectionCard>
        ) : null}
      </div>
    </div>
  );
}
