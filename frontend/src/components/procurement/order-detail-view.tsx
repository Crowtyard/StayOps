"use client";

/**
 * /procurement/orders/[id] 采购订单详情（Sprint 7 §44）：
 * - supplier / lines（ordered / received / remaining / unit price / amount）/
 *   status / receipts（历史收货单，不删除）
 * - 动作：Mark Ordered（DRAFT）/ Receive Goods（ORDERED·PARTIALLY_RECEIVED，
 *   支持部分收货）/ Cancel Remaining（DRAFT·ORDERED·PARTIALLY_RECEIVED）
 * 前端不复制后端状态机：非法转换 / 超收由后端 409 裁决并原文展示。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ApiError, api } from "@/lib/api";
import type {
  InventoryLocationOut,
  PurchaseOrderLineOut,
  PurchaseOrderOut,
} from "@/lib/api/types";
import { fmtQty, qty } from "@/lib/inventory";
import { PO_STATUS_META } from "@/lib/procurement";
import { useUser } from "@/components/app-shell";
import { ErrorView, Forbidden, Loading } from "@/components/status-views";
import { StatusBadge } from "@/components/status-badge";
import { Modal } from "@/components/modal";
import { Field, inputClass } from "@/components/booking/shared";

export default function OrderDetailView({ id }: { id: string }) {
  const router = useRouter();
  const user = useUser();
  const permissions = useMemo(() => new Set(user?.permissions ?? []), [user]);
  const canRead = permissions.has("procurement:read");
  const canOrder = permissions.has("procurement:order");
  const canReceive = permissions.has("procurement:receive");

  const [order, setOrder] = useState<PurchaseOrderOut | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showReceipt, setShowReceipt] = useState(false);

  useEffect(() => {
    if (!canRead) return;
    let cancelled = false;
    api.procurement
      .getOrder(id)
      .then((data) => {
        if (!cancelled) setOrder(data);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.kind === "unauthorized") {
          router.replace("/login");
          return;
        }
        setError(
          err instanceof ApiError ? err : new ApiError("unknown", null, "加载失败"),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [canRead, id, router, reloadKey]);

  const refresh = useCallback(() => {
    setError(null);
    setActionError(null);
    setReloadKey((k) => k + 1);
  }, []);

  const runAction = useCallback(
    async (action: () => Promise<unknown>) => {
      if (busy) return;
      setBusy(true);
      setActionError(null);
      try {
        await action();
        refresh();
      } catch (err) {
        setActionError(
          err instanceof ApiError ? err.message : "操作失败，请稍后重试",
        );
      } finally {
        setBusy(false);
      }
    },
    [busy, refresh],
  );

  if (!canRead) {
    return <Forbidden text="无权限访问采购订单（缺少 procurement:read）" />;
  }
  if (error && error.kind !== "not_found") {
    return (
      <ErrorView
        message={error.message}
        offline={error.kind === "network"}
        onRetry={refresh}
      />
    );
  }
  if (error?.kind === "not_found") {
    return <Forbidden text="该采购订单不存在" />;
  }
  if (!order) {
    return <Loading text="正在加载采购订单…" />;
  }

  const status = order.status;
  const canMarkOrdered = canOrder && status === "DRAFT";
  const canReceiveNow =
    canReceive && (status === "ORDERED" || status === "PARTIALLY_RECEIVED");
  const canCancelNow =
    canOrder &&
    (status === "DRAFT" || status === "ORDERED" || status === "PARTIALLY_RECEIVED");

  return (
    <div>
      <Link
        href="/procurement/orders"
        className="mb-4 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900"
      >
        ← 返回采购订单列表
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2.5 text-xl font-semibold text-gray-900">
            {order.order_no}
            <StatusBadge meta={PO_STATUS_META[status]} />
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            供应商 {order.supplier_name ?? `#${order.supplier_id}`}
            {order.request_no ? ` · 来自申请 ${order.request_no}` : " · 直接创建"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canMarkOrdered ? (
            <button
              type="button"
              onClick={() => void runAction(() => api.procurement.markOrdered(order.id))}
              disabled={busy}
              className="rounded-md bg-gray-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
            >
              下达订单
            </button>
          ) : null}
          {canReceiveNow ? (
            <button
              type="button"
              onClick={() => setShowReceipt(true)}
              disabled={busy}
              className="rounded-md bg-emerald-700 px-3.5 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
            >
              收货入库
            </button>
          ) : null}
          {canCancelNow ? (
            <button
              type="button"
              onClick={() => void runAction(() => api.procurement.cancelOrder(order.id))}
              disabled={busy}
              className="rounded-md border border-gray-300 px-3.5 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {status === "PARTIALLY_RECEIVED" ? "取消剩余收货" : "取消订单"}
            </button>
          ) : null}
        </div>
      </div>

      {actionError ? (
        <p
          role="alert"
          className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-inset ring-red-200"
        >
          {actionError}
        </p>
      ) : null}

      <div className="mt-5 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3.5">
          <h2 className="text-sm font-semibold text-gray-900">订单行</h2>
          <p className="text-sm text-gray-500">
            订单金额{" "}
            <span className="font-semibold tabular-nums text-gray-900">
              {qty(order.order_total) > 0 ? `¥${fmtQty(order.order_total)}` : "—"}
            </span>
          </p>
        </div>
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50 text-left text-xs font-medium text-gray-500">
            <tr>
              <th className="px-5 py-2.5">物资</th>
              <th className="px-5 py-2.5 text-right">订购数量</th>
              <th className="px-5 py-2.5 text-right">已收数量</th>
              <th className="px-5 py-2.5 text-right">剩余待收</th>
              <th className="px-5 py-2.5 text-right">单价</th>
              <th className="px-5 py-2.5 text-right">金额</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {order.lines.map((line) => (
              <tr key={line.id}>
                <td className="px-5 py-2.5 text-gray-900">
                  {line.item_name ?? `#${line.item_id}`}
                  <span className="ml-1.5 text-xs text-gray-400">
                    {line.item_code} · {line.base_unit}
                  </span>
                </td>
                <td className="px-5 py-2.5 text-right tabular-nums text-gray-900">
                  {fmtQty(line.ordered_quantity)}
                </td>
                <td className="px-5 py-2.5 text-right tabular-nums text-emerald-700">
                  {fmtQty(line.received_quantity)}
                </td>
                <td
                  className={`px-5 py-2.5 text-right tabular-nums ${
                    qty(line.remaining_quantity) > 0
                      ? "text-amber-700"
                      : "text-gray-400"
                  }`}
                >
                  {fmtQty(line.remaining_quantity)}
                </td>
                <td className="px-5 py-2.5 text-right tabular-nums text-gray-500">
                  {line.unit_price ? `¥${fmtQty(line.unit_price)}` : "—"}
                </td>
                <td className="px-5 py-2.5 text-right tabular-nums text-gray-900">
                  {line.line_total ? `¥${fmtQty(line.line_total)}` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section aria-label="收货记录" className="mt-6">
        <h2 className="text-sm font-semibold text-gray-900">
          收货记录（{order.receipts.length}）
        </h2>
        <div className="mt-3 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
          {order.receipts.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-gray-400">
              暂无收货记录（只有收货才真正增加库存）
            </p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {order.receipts.map((receipt) => (
                <li key={receipt.id} className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-medium text-gray-900">
                      {receipt.receipt_no}
                    </span>
                    <span className="text-xs text-gray-500">
                      入库地点 {receipt.inventory_location_name ?? `#${receipt.inventory_location_id}`}
                    </span>
                    <span className="text-xs text-gray-400">
                      {receipt.receiver_name ?? "—"}
                    </span>
                    <span className="ml-auto text-xs text-gray-400">
                      {receipt.received_at
                        ? new Date(receipt.received_at).toLocaleString("zh-CN", {
                            hour12: false,
                          })
                        : "—"}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-gray-500">
                    {receipt.lines
                      .map(
                        (line) =>
                          `${line.item_name ?? `#${line.item_id}`} ×${fmtQty(line.received_quantity)}`,
                      )
                      .join("；")}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {showReceipt ? (
        <ReceiveGoodsModal
          order={order}
          onClose={() => setShowReceipt(false)}
          onSuccess={() => {
            setShowReceipt(false);
            refresh();
          }}
        />
      ) : null}
    </div>
  );
}

export function ReceiveGoodsModal({
  order,
  onClose,
  onSuccess,
}: {
  order: PurchaseOrderOut;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [locations, setLocations] = useState<InventoryLocationOut[]>([]);
  const [locationId, setLocationId] = useState<number | "">("");
  const [quantities, setQuantities] = useState<Record<number, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.inventory
      .listLocations({ page: 1, page_size: 100 })
      .then((page) => {
        if (!cancelled) setLocations(page.items);
      })
      .catch(() => {
        /* 地点加载失败时仍可关闭 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const receivableLines = order.lines.filter(
    (line) => qty(line.remaining_quantity) > 0,
  );

  const setLine = useCallback((lineId: number, value: string) => {
    setQuantities((prev) => ({ ...prev, [lineId]: value }));
  }, []);

  /** 一键按剩余数量收货（部分收货也支持手动修改） */
  const fillRemaining = useCallback(() => {
    const next: Record<number, string> = {};
    for (const line of receivableLines) {
      next[line.id] = fmtQty(line.remaining_quantity);
    }
    setQuantities(next);
  }, [receivableLines]);

  const submit = useCallback(async () => {
    if (submitting) return;
    if (locationId === "") {
      setError("请选择入库地点");
      return;
    }
    const lines = receivableLines
      .map((line) => ({
        purchase_order_line_id: line.id,
        received_quantity: qty(quantities[line.id]),
      }))
      .filter((entry) => entry.received_quantity > 0);
    if (lines.length === 0) {
      setError("请至少填写一行收货数量（支持部分收货）");
      return;
    }
    for (const entry of lines) {
      const line = receivableLines.find(
        (l) => l.id === entry.purchase_order_line_id,
      ) as PurchaseOrderLineOut;
      if (entry.received_quantity > qty(line.remaining_quantity)) {
        setError(
          `收货数量超过剩余可收数量：${line.item_name ?? `#${line.item_id}`} 剩余 ${fmtQty(line.remaining_quantity)}`,
        );
        return;
      }
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.procurement.receive(order.id, {
        inventory_location_id: Number(locationId),
        lines,
      });
      onSuccess();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "收货失败，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  }, [submitting, locationId, quantities, receivableLines, order.id, onSuccess]);

  return (
    <Modal open title="收货入库" onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-gray-500">
          收货才真正增加库存（PURCHASE_RECEIPT 流水）；任一行超收整体回滚。
        </p>
        <Field label="入库地点" required error={null}>
          <select
            value={locationId === "" ? "" : String(locationId)}
            onChange={(e) =>
              setLocationId(e.target.value === "" ? "" : Number(e.target.value))
            }
            disabled={submitting}
            className={inputClass}
            aria-label="入库地点"
          >
            <option value="">选择地点…</option>
            {locations.map((loc) => (
              <option key={loc.id} value={loc.id}>
                {loc.name}
                {loc.is_active ? "" : "（已停用）"}
              </option>
            ))}
          </select>
        </Field>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-xs font-medium text-gray-600">收货明细</span>
            <button
              type="button"
              onClick={fillRemaining}
              disabled={submitting}
              className="text-xs font-medium text-gray-900 underline-offset-2 hover:underline disabled:opacity-50"
            >
              按剩余数量收货
            </button>
          </div>
          <div className="space-y-2">
            {receivableLines.map((line) => (
              <div key={line.id} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm text-gray-700">
                  {line.item_name ?? `#${line.item_id}`}
                  <span className="ml-1 text-xs text-gray-400">
                    剩余 {fmtQty(line.remaining_quantity)}
                    {line.base_unit}
                  </span>
                </span>
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={quantities[line.id] ?? ""}
                  onChange={(e) => setLine(line.id, e.target.value)}
                  disabled={submitting}
                  placeholder="0"
                  className={`${inputClass} w-28`}
                  aria-label={`${line.item_name ?? line.item_id} 收货数量`}
                />
              </div>
            ))}
          </div>
        </div>

        {error ? (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-inset ring-red-200">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2.5 pt-1">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-md border border-gray-300 px-3.5 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={submitting}
            className="rounded-md bg-gray-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
          >
            {submitting ? "收货中…" : "确认收货"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
