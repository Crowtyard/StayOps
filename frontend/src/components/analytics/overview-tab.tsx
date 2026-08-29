"use client";

import type {
  BusinessInventoryOut,
  BusinessProcurementOut,
  BusinessRoomsOut,
  OperationsOverviewOut,
} from "@/lib/api/types";
import {
  fmtCount,
  fmtDays,
  fmtMoney,
  fmtRate,
} from "@/lib/analytics";
import KpiCard, { kpiChange } from "./kpi-card";
import { PermissionNote, SectionCard } from "./shared";

export interface OverviewTabProps {
  /** operations 域数据；null = 无 operations 权限（不请求） */
  overview: OperationsOverviewOut | null;
  /** business 域数据；null = 无 business 权限（不请求） */
  rooms: BusinessRoomsOut | null;
  inventory: BusinessInventoryOut | null;
  procurement: BusinessProcurementOut | null;
}

/** 总览 Tab（§45）：Operations 权限看运营指标；Business 权限看经营指标；无权限域不渲染 */
export default function OverviewTab({
  overview,
  rooms,
  inventory,
  procurement,
}: OverviewTabProps) {
  const hasOps = overview != null;
  const hasBiz = rooms != null || inventory != null || procurement != null;

  return (
    <div className="space-y-4">
      {!hasOps && !hasBiz ? (
        <PermissionNote text="当前账号没有经营分析权限" />
      ) : null}

      {hasOps ? (
        <>
          <SectionCard title="运营概览" hint="报告期内实际发生（Actual）">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <KpiCard
                label="物理入住率"
                value={fmtRate(overview.metrics.physical_occupancy_rate)}
                change={
                  kpiChange(overview.comparison?.changes.physical_occupancy_rate)?.text
                }
                changeValue={
                  kpiChange(overview.comparison?.changes.physical_occupancy_rate)?.value
                }
                hint="实际占用房晚 ÷ 物理房晚（28 房 × 报告天数）"
              />
              <KpiCard
                label="实际占用房晚"
                value={fmtCount(overview.metrics.actual_occupied_room_nights)}
                change={
                  kpiChange(overview.comparison?.changes.actual_occupied_room_nights)?.text
                }
                changeValue={
                  kpiChange(overview.comparison?.changes.actual_occupied_room_nights)?.value
                }
              />
              <KpiCard
                label="平均住宿时长"
                value={fmtDays(overview.metrics.average_length_of_stay)}
                change={
                  kpiChange(overview.comparison?.changes.average_length_of_stay)?.text
                }
                changeValue={
                  kpiChange(overview.comparison?.changes.average_length_of_stay)?.value
                }
              />
              <KpiCard
                label="完成住宿数"
                value={fmtCount(overview.metrics.completed_stays)}
                change={
                  kpiChange(overview.comparison?.changes.completed_stays)?.text
                }
                changeValue={
                  kpiChange(overview.comparison?.changes.completed_stays)?.value
                }
              />
              <KpiCard
                label="取消率"
                value={fmtRate(overview.metrics.cancellation_rate)}
                change={kpiChange(overview.comparison?.changes.cancellation_rate)?.text}
                changeValue={kpiChange(overview.comparison?.changes.cancellation_rate)?.value}
                hint={`取消 ${overview.metrics.cancelled_arrivals} / 到店 ${overview.metrics.scheduled_arrivals}`}
              />
              <KpiCard
                label="未到店率"
                value={fmtRate(overview.metrics.no_show_rate)}
                change={kpiChange(overview.comparison?.changes.no_show_rate)?.text}
                changeValue={kpiChange(overview.comparison?.changes.no_show_rate)?.value}
                hint={`未到店 ${overview.metrics.no_show_count} 单`}
              />
              <KpiCard
                label="平均预订提前"
                value={fmtDays(overview.metrics.average_booking_lead_days)}
                change={
                  kpiChange(overview.comparison?.changes.average_booking_lead_days)?.text
                }
                changeValue={
                  kpiChange(overview.comparison?.changes.average_booking_lead_days)?.value
                }
              />
              <KpiCard
                label="换房率"
                value={fmtRate(overview.metrics.room_move_rate)}
                change={kpiChange(overview.comparison?.changes.room_move_rate)?.text}
                changeValue={kpiChange(overview.comparison?.changes.room_move_rate)?.value}
                hint={`换房 ${overview.metrics.room_move_count} 次 / ${overview.metrics.moved_stay_count} 个住宿`}
              />
            </div>
          </SectionCard>

          <SectionCard title="当前快照" hint="此刻状态，不是周期指标（§9）">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
              <KpiCard label="当前在住" value={fmtCount(overview.snapshot.active_stays)} />
              <KpiCard
                label="超期在住"
                value={fmtCount(overview.snapshot.overdue_active_stays)}
                accent={overview.snapshot.overdue_active_stays > 0 ? "bad" : "default"}
              />
              <KpiCard
                label="保洁积压"
                value={fmtCount(overview.snapshot.housekeeping_backlog)}
                accent={overview.snapshot.housekeeping_backlog > 0 ? "warn" : "default"}
              />
              <KpiCard
                label="进行中维修"
                value={fmtCount(overview.snapshot.active_maintenance)}
              />
              <KpiCard
                label="阻断性维修"
                value={fmtCount(overview.snapshot.active_blocking_maintenance)}
                accent={overview.snapshot.active_blocking_maintenance > 0 ? "bad" : "default"}
              />
            </div>
          </SectionCard>

          <SectionCard title="在册预测" hint="On-Books：已确认预订 + 在住剩余计划（Future，非 Actual）">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              {(["7d", "14d", "30d"] as const).map((key) => {
                const h = overview.on_books[key];
                return (
                  <div key={key} className="rounded-md border border-gray-100 p-3">
                    <p className="text-xs text-gray-500">未来 {key.replace("d", "")} 天</p>
                    <p className="mt-1 text-lg font-semibold tabular-nums text-gray-900">
                      {fmtRate(h.occupancy_rate)}
                    </p>
                    <p className="mt-1 text-xs text-gray-400 tabular-nums">
                      {h.on_books_room_nights} / {h.physical_room_nights} 房晚
                    </p>
                  </div>
                );
              })}
            </div>
          </SectionCard>
        </>
      ) : null}

      {hasBiz ? (
        <>
          <SectionCard
            title="客房经营"
            hint="合同房费金额：非实际收款、非会计口径（§17/§21/§22）"
          >
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {rooms ? (
                <>
                  <KpiCard
                    label="合同房费金额"
                    value={fmtMoney(rooms.contracted_room_value)}
                    hint="Contracted Room Value：已实际入住房晚的合同金额"
                  />
                  <KpiCard
                    label="合同 ADR"
                    value={fmtMoney(rooms.contracted_adr)}
                    hint="合同房费金额 ÷ 有价实际房晚；非实际收款"
                  />
                  <KpiCard
                    label="合同 RevPAR"
                    value={fmtMoney(rooms.contracted_revpar)}
                    hint="合同房费金额 ÷ 物理房晚（物理房间分母，非财务 RevPAR）"
                  />
                  <KpiCard
                    label="无价实际房晚"
                    value={fmtCount(rooms.unpriced_occupied_room_nights)}
                    accent={rooms.unpriced_occupied_room_nights > 0 ? "bad" : "default"}
                    hint="无可靠合同单价的房晚（正常期望 0，>0 需核查）"
                  />
                </>
              ) : null}
            </div>
          </SectionCard>

          <SectionCard title="库存与采购预警" hint="当前快照（§48）">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {inventory ? (
                <>
                  <KpiCard
                    label="低库存物资"
                    value={fmtCount(inventory.current_low_stock_items)}
                    accent={inventory.current_low_stock_items > 0 ? "warn" : "default"}
                  />
                  <KpiCard
                    label="缺货物资"
                    value={fmtCount(inventory.current_out_of_stock_items)}
                    accent={inventory.current_out_of_stock_items > 0 ? "bad" : "default"}
                  />
                </>
              ) : null}
              {procurement ? (
                <>
                  <KpiCard
                    label="待处理采购申请"
                    value={fmtCount(procurement.pending_purchase_requests)}
                    hint="SUBMITTED（待审批）+ APPROVED（待转单）"
                  />
                  <KpiCard
                    label="待收货订单"
                    value={fmtCount(procurement.pending_receipt_orders)}
                    accent={procurement.pending_receipt_orders > 0 ? "warn" : "default"}
                    hint={`部分收货 ${procurement.partially_received_orders} 单`}
                  />
                </>
              ) : null}
            </div>
          </SectionCard>
        </>
      ) : null}
    </div>
  );
}
