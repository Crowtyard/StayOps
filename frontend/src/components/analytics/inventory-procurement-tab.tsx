"use client";

import type {
  BusinessInventoryOut,
  BusinessProcurementOut,
} from "@/lib/api/types";
import { fmtCount, fmtMoney } from "@/lib/analytics";
import { BarChart, type ChartPoint } from "./charts";
import KpiCard from "./kpi-card";
import { PermissionNote, SectionCard, TextTable } from "./shared";

export interface InventoryProcurementTabProps {
  inventory: BusinessInventoryOut | null;
  procurement: BusinessProcurementOut | null;
}

function shortLabel(dateStr: string): string {
  return dateStr.slice(5);
}

const STOCK_STATUS_LABEL: Record<string, string> = {
  NORMAL: "正常",
  LOW_STOCK: "低库存",
  OUT_OF_STOCK: "缺货",
};

/** 库存与采购 Tab（§48，business 权限 only） */
export default function InventoryProcurementTab({
  inventory,
  procurement,
}: InventoryProcurementTabProps) {
  if (!inventory && !procurement) {
    return (
      <PermissionNote text="库存与采购分析需要经营分析权限（analytics:business_read）" />
    );
  }

  const receivedTrend: ChartPoint[] = (procurement?.daily ?? []).map((d) => ({
    label: shortLabel(d.business_date),
    value: Number(d.received_purchase_value),
  }));

  return (
    <div className="space-y-4">
      {inventory ? (
        <SectionCard
          title="库存"
          hint={`领用量为每物资每计量单位的领用毛量（gross issue，不减归还）；不同计量单位不汇总（§26/§27）。占用房晚 ${fmtCount(inventory.occupied_room_nights)}`}
        >
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
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
            <KpiCard
              label="实际占用房晚"
              value={fmtCount(inventory.occupied_room_nights)}
              hint="领用强度分母（非客人实际消费量）"
            />
          </div>
          <div className="mt-3">
            <TextTable
              columns={[
                { key: "code", label: "物资代码" },
                { key: "name", label: "名称" },
                { key: "unit", label: "计量单位" },
                { key: "status", label: "库存状态" },
                { key: "total", label: "当前库存", align: "right" },
                { key: "issue", label: "领用量", align: "right" },
                { key: "intensity", label: "每实际房晚领用强度", align: "right" },
              ]}
              rows={inventory.items.map((item) => ({
                code: item.item_code,
                name: item.name,
                unit: item.base_unit,
                status: (
                  <span
                    className={
                      item.stock_status === "OUT_OF_STOCK"
                        ? "font-medium text-red-700"
                        : item.stock_status === "LOW_STOCK"
                          ? "font-medium text-amber-700"
                          : "text-gray-700"
                    }
                  >
                    {STOCK_STATUS_LABEL[item.stock_status] ?? item.stock_status}
                  </span>
                ),
                total: item.total_stock,
                issue: item.issue_quantity,
                intensity:
                  item.issue_quantity_per_occupied_room_night == null
                    ? "—"
                    : String(item.issue_quantity_per_occupied_room_night),
              }))}
              emptyText="暂无库存物资"
            />
          </div>
        </SectionCard>
      ) : null}

      {procurement ? (
        <SectionCard
          title="采购"
          hint="到货采购金额按收货日期归属；≠ 已付款金额、≠ 会计成本（§30）"
        >
          <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
            <KpiCard
              label="新建采购申请"
              value={fmtCount(procurement.purchase_requests_created)}
            />
            <KpiCard
              label="待处理申请"
              value={fmtCount(procurement.pending_purchase_requests)}
            />
            <KpiCard
              label="新建采购订单"
              value={fmtCount(procurement.purchase_orders_created)}
            />
            <KpiCard
              label="待收货订单"
              value={fmtCount(procurement.pending_receipt_orders)}
            />
            <KpiCard
              label="部分收货"
              value={fmtCount(procurement.partially_received_orders)}
            />
            <KpiCard
              label="到货采购金额"
              value={fmtMoney(procurement.received_purchase_value)}
            />
          </div>
          {procurement.unpriced_received_lines > 0 ? (
            <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800" role="alert">
              数据质量提示：{procurement.unpriced_received_lines} 行收货记录缺少单价，
              未计入到货金额（不猜价格，§30）。
            </p>
          ) : null}
          <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
            <div>
              <p className="mb-2 text-xs font-medium text-gray-500">到货金额趋势（按收货日）</p>
              <BarChart data={receivedTrend} formatValue={(v) => fmtMoney(String(v))} color="#0f766e" />
            </div>
            <div>
              <p className="mb-2 text-xs font-medium text-gray-500">按供应商</p>
              <TextTable
                columns={[
                  { key: "code", label: "供应商" },
                  { key: "name", label: "名称" },
                  { key: "value", label: "到货金额", align: "right" },
                ]}
                rows={procurement.received_value_by_supplier.map((s) => ({
                  code: s.supplier_code,
                  name: s.supplier_name,
                  value: fmtMoney(s.received_value),
                }))}
                emptyText="报告期内无收货"
              />
              <p className="mb-2 mt-4 text-xs font-medium text-gray-500">按物资</p>
              <TextTable
                columns={[
                  { key: "code", label: "物资代码" },
                  { key: "name", label: "名称" },
                  { key: "unit", label: "计量单位" },
                  { key: "value", label: "到货金额", align: "right" },
                ]}
                rows={procurement.received_value_by_item.map((item) => ({
                  code: item.item_code,
                  name: item.item_name,
                  unit: item.base_unit,
                  value: fmtMoney(item.received_value),
                }))}
                emptyText="报告期内无收货"
              />
            </div>
          </div>
        </SectionCard>
      ) : null}
    </div>
  );
}
