"use client";

import type {
  HousekeepingOut,
  MaintenanceOut,
  RoomMovesOut,
} from "@/lib/api/types";
import {
  fmtCount,
  fmtMinutes,
  fmtRate,
} from "@/lib/analytics";
import { BarChart, type ChartPoint } from "./charts";
import KpiCard from "./kpi-card";
import { PermissionNote, SectionCard, TextTable } from "./shared";

export interface OperationsTabProps {
  housekeeping: HousekeepingOut | null;
  maintenance: MaintenanceOut | null;
  roomMoves: RoomMovesOut | null;
}

function shortLabel(dateStr: string): string {
  return dateStr.slice(5);
}

/** 运营效率 Tab（§47）：保洁 / 维修 / 换房事实展示（无 AI 建议、无“问题房”定性） */
export default function OperationsTab({
  housekeeping,
  maintenance,
  roomMoves,
}: OperationsTabProps) {
  if (!housekeeping && !maintenance && !roomMoves) {
    return (
      <PermissionNote text="运营效率分析需要运营分析权限（analytics:operations_read）" />
    );
  }

  const hkDaily: ChartPoint[] = (housekeeping?.daily ?? []).map((d) => ({
    label: shortLabel(d.business_date),
    value: d.completed_tasks,
  }));
  const categoryData: ChartPoint[] = (maintenance?.maintenance_by_category ?? []).map(
    (c) => ({ label: c.category, value: c.count }),
  );
  const reasonData: ChartPoint[] = (roomMoves?.room_moves_by_reason ?? []).map(
    (r) => ({ label: r.reason, value: r.count }),
  );

  return (
    <div className="space-y-4">
      {housekeeping ? (
        <>
          <SectionCard title="保洁" hint="周期内完成的任务口径；积压为当前快照（§23）">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
              <KpiCard
                label="完成保洁任务"
                value={fmtCount(housekeeping.housekeeping_completed_tasks)}
              />
              <KpiCard
                label="平均保洁周期"
                value={fmtMinutes(housekeeping.average_housekeeping_cycle_minutes)}
              />
              <KpiCard
                label="退房翻房时长"
                value={fmtMinutes(housekeeping.checkout_turnover_minutes)}
              />
              <KpiCard
                label="换房保洁任务"
                value={fmtCount(housekeeping.room_move_cleaning_tasks)}
              />
              <KpiCard
                label="当前积压"
                value={fmtCount(housekeeping.housekeeping_backlog)}
                accent={housekeeping.housekeeping_backlog > 0 ? "warn" : "default"}
              />
            </div>
            <div className="mt-3">
              <BarChart data={hkDaily} formatValue={(v) => fmtCount(v)} color="#0f766e" />
            </div>
          </SectionCard>
        </>
      ) : null}

      {maintenance ? (
        <SectionCard title="维修" hint="MTTR = 解决时间（resolved - created）；验收 = 完成 - 解决（§24）">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
            <KpiCard
              label="新建工单"
              value={fmtCount(maintenance.maintenance_created)}
            />
            <KpiCard
              label="完成工单"
              value={fmtCount(maintenance.maintenance_completed)}
            />
            <KpiCard
              label="进行中"
              value={fmtCount(maintenance.active_maintenance)}
            />
            <KpiCard
              label="阻断性维修"
              value={fmtCount(maintenance.active_blocking_maintenance)}
              accent={maintenance.active_blocking_maintenance > 0 ? "bad" : "default"}
            />
            <KpiCard
              label="平均解决时长"
              value={fmtMinutes(maintenance.mean_time_to_resolution_minutes)}
            />
            <KpiCard
              label="平均验收时长"
              value={fmtMinutes(maintenance.mean_verification_minutes)}
            />
          </div>
          <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
            <div>
              <p className="mb-2 text-xs font-medium text-gray-500">按分类（新建）</p>
              <BarChart data={categoryData} formatValue={(v) => fmtCount(v)} color="#b91c1c" />
            </div>
            <div>
              <p className="mb-2 text-xs font-medium text-gray-500">高频报修房间（新建）</p>
              <TextTable
                columns={[
                  { key: "room", label: "房号" },
                  { key: "count", label: "新建工单数", align: "right" },
                ]}
                rows={maintenance.maintenance_by_room.map((r) => ({
                  room: r.room_number,
                  count: fmtCount(r.count),
                }))}
                emptyText="报告期内无新建工单"
              />
            </div>
          </div>
        </SectionCard>
      ) : null}

      {roomMoves ? (
        <SectionCard title="换房" hint="换房事件按新分配的开始时间归属报告期（§25）">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            <KpiCard label="换房次数" value={fmtCount(roomMoves.room_move_count)} />
            <KpiCard label="涉及住宿数" value={fmtCount(roomMoves.moved_stay_count)} />
            <KpiCard label="换房率" value={fmtRate(roomMoves.room_move_rate)} />
          </div>
          <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
            <div>
              <p className="mb-2 text-xs font-medium text-gray-500">换房原因分布</p>
              <BarChart data={reasonData} formatValue={(v) => fmtCount(v)} color="#1d4ed8" />
            </div>
            <div>
              <p className="mb-2 text-xs font-medium text-gray-500">换出房分布（来源房）</p>
              <TextTable
                columns={[
                  { key: "room", label: "来源房号" },
                  { key: "count", label: "换出次数", align: "right" },
                ]}
                rows={roomMoves.room_moves_by_source_room.map((r) => ({
                  room: r.room_number,
                  count: fmtCount(r.count),
                }))}
                emptyText="报告期内无换房事件"
              />
            </div>
          </div>
        </SectionCard>
      ) : null}
    </div>
  );
}
