"use client";

/**
 * /procurement/orders 采购订单列表 + 新建（Sprint 7 §26/§28）：
 * - 新建方式：由已批准申请转单（复制申请行）或直接创建（无申请）
 * - 权限：读 procurement:read；创建 procurement:order（SUPER_ADMIN/MANAGER）
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ApiError, api } from "@/lib/api";
import type {
  InventoryItemListRow,
  PurchaseOrderOut,
  PurchaseOrderStatus,
  PurchaseRequestOut,
  SupplierOut,
} from "@/lib/api/types";
import { fmtQty, qty } from "@/lib/inventory";
import { PO_STATUS_META, PO_STATUSES } from "@/lib/procurement";
import { useUser } from "@/components/app-shell";
import { ErrorView, Forbidden, Loading } from "@/components/status-views";
import { StatusBadge } from "@/components/status-badge";
import { Modal } from "@/components/modal";
import { Field, inputClass } from "@/components/booking/shared";

interface DraftLine {
  key: number;
  itemId: number | "";
  orderedQuantity: string;
  unitPrice: string;
}

let nextKey = 3000;

export default function OrdersView() {
  const router = useRouter();
  const user = useUser();
  const permissions = useMemo(() => new Set(user?.permissions ?? []), [user]);
  const canRead = permissions.has("procurement:read");
  const canOrder = permissions.has("procurement:order");

  const [orders, setOrders] = useState<PurchaseOrderOut[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [statusFilter, setStatusFilter] = useState<PurchaseOrderStatus | "">("");
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    if (!canRead) return;
    let cancelled = false;
    const load = async () => {
      try {
        const all: PurchaseOrderOut[] = [];
        let page = 1;
        for (;;) {
          const result = await api.procurement.listOrders({
            page,
            page_size: 100,
            status: statusFilter === "" ? undefined : statusFilter,
          });
          all.push(...result.items);
          if (result.page * result.page_size >= result.total) break;
          page += 1;
        }
        if (!cancelled) setOrders(all);
      } catch (err: unknown) {
        if (cancelled) return;
        if (err instanceof ApiError && err.kind === "unauthorized") {
          router.replace("/login");
          return;
        }
        setError(
          err instanceof ApiError ? err : new ApiError("unknown", null, "加载失败"),
        );
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [canRead, router, reloadKey, statusFilter]);

  const refresh = useCallback(() => {
    setError(null);
    setReloadKey((k) => k + 1);
  }, []);

  if (!canRead) {
    return <Forbidden text="无权限访问采购订单（缺少 procurement:read）" />;
  }
  if (error) {
    return (
      <ErrorView
        message={error.message}
        offline={error.kind === "network"}
        onRetry={refresh}
      />
    );
  }
  if (!orders) {
    return <Loading text="正在加载采购订单…" />;
  }

  return (
    <div>
      <Link
        href="/procurement"
        className="mb-4 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900"
      >
        ← 返回采购工作台
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">采购订单</h1>
          <p className="mt-1 text-sm text-gray-500">
            草稿 → 下达 → 部分收货 → 已收货（PO 不改变库存，收货才入库）
          </p>
        </div>
        {canOrder ? (
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="rounded-md bg-gray-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-gray-700"
          >
            新建采购订单
          </button>
        ) : null}
      </div>

      <div className="mt-5 flex items-center gap-2">
        <select
          value={statusFilter}
          onChange={(e) =>
            setStatusFilter(e.target.value as PurchaseOrderStatus | "")
          }
          className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
          aria-label="按状态筛选"
        >
          <option value="">全部状态</option>
          {PO_STATUSES.map((s) => (
            <option key={s} value={s}>
              {PO_STATUS_META[s].label}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-4 overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50 text-left text-xs font-medium text-gray-500">
            <tr>
              <th className="px-4 py-3">订单号</th>
              <th className="px-4 py-3">供应商</th>
              <th className="px-4 py-3">状态</th>
              <th className="px-4 py-3 text-right">行数</th>
              <th className="px-4 py-3 text-right">订单金额</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {orders.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-gray-400">
                  暂无采购订单
                </td>
              </tr>
            ) : (
              orders.map((po) => (
                <tr key={po.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <Link
                      href={`/procurement/orders/${po.id}`}
                      className="font-medium text-gray-900 hover:underline"
                    >
                      {po.order_no}
                    </Link>
                    {po.request_no ? (
                      <span className="ml-2 text-xs text-gray-400">
                        来自 {po.request_no}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-gray-500">
                    {po.supplier_name ?? `#${po.supplier_id}`}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge meta={PO_STATUS_META[po.status]} />
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-500">
                    {po.lines.length}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-900">
                    {qty(po.order_total) > 0 ? `¥${fmtQty(po.order_total)}` : "—"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <CreateOrderModal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onSuccess={(orderId) => {
          setShowCreate(false);
          refresh();
          router.push(`/procurement/orders/${orderId}`);
        }}
      />
    </div>
  );
}

export function CreateOrderModal({
  open,
  onClose,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  onSuccess: (orderId: number) => void;
}) {
  const [mode, setMode] = useState<"request" | "direct">("request");
  const [approvedRequests, setApprovedRequests] = useState<PurchaseRequestOut[]>([]);
  const [requestId, setRequestId] = useState<number | "">("");
  const [suppliers, setSuppliers] = useState<SupplierOut[]>([]);
  const [supplierId, setSupplierId] = useState<number | "">("");
  const [items, setItems] = useState<InventoryItemListRow[]>([]);
  const [lines, setLines] = useState<DraftLine[]>([
    { key: nextKey++, itemId: "", orderedQuantity: "1", unitPrice: "" },
  ]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    Promise.all([
      api.procurement.listRequests({ status: "APPROVED", page: 1, page_size: 100 }),
      api.procurement.listSuppliers({ page: 1, page_size: 100 }),
      api.inventory.listItems({ page: 1, page_size: 100 }),
    ])
      .then(([requests, supplierPage, itemPage]) => {
        if (cancelled) return;
        setApprovedRequests(requests.items);
        setSuppliers(supplierPage.items.filter((s) => s.is_active));
        setItems(itemPage.items.filter((i) => i.is_active));
      })
      .catch(() => {
        /* 加载失败时表单仍可关闭 */
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const updateLine = useCallback((key: number, patch: Partial<DraftLine>) => {
    setLines((prev) =>
      prev.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    );
  }, []);

  const addLine = useCallback(() => {
    setLines((prev) => [
      ...prev,
      { key: nextKey++, itemId: "", orderedQuantity: "1", unitPrice: "" },
    ]);
  }, []);

  const removeLine = useCallback((key: number) => {
    setLines((prev) =>
      prev.length <= 1 ? prev : prev.filter((line) => line.key !== key),
    );
  }, []);

  const submit = useCallback(async () => {
    if (submitting) return;
    if (supplierId === "") {
      setError("请选择供应商");
      return;
    }
    if (mode === "request") {
      if (requestId === "") {
        setError("请选择要转单的已批准申请");
        return;
      }
      setSubmitting(true);
      setError(null);
      try {
        const order = await api.procurement.createOrder({
          supplier_id: Number(supplierId),
          purchase_request_id: Number(requestId),
        });
        onSuccess(order.id);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "创建失败，请稍后重试");
      } finally {
        setSubmitting(false);
      }
      return;
    }
    const validLines = lines.filter(
      (line) => line.itemId !== "" && qty(line.orderedQuantity) > 0,
    );
    if (validLines.length === 0) {
      setError("请至少选择一种物资并填写订购数量");
      return;
    }
    const itemIds = validLines.map((line) => line.itemId as number);
    if (new Set(itemIds).size !== itemIds.length) {
      setError("同一采购订单不允许重复物资");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const order = await api.procurement.createOrder({
        supplier_id: Number(supplierId),
        lines: validLines.map((line) => ({
          item_id: line.itemId as number,
          ordered_quantity: qty(line.orderedQuantity),
          unit_price: line.unitPrice.trim() === "" ? null : qty(line.unitPrice),
        })),
      });
      onSuccess(order.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "创建失败，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  }, [submitting, supplierId, mode, requestId, lines, onSuccess]);

  return (
    <Modal open={open} title="新建采购订单" onClose={onClose}>
      <div className="space-y-4">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setMode("request")}
            aria-pressed={mode === "request"}
            disabled={submitting}
            className={`rounded-full px-3.5 py-1.5 text-sm font-medium ${
              mode === "request"
                ? "bg-gray-900 text-white"
                : "border border-gray-300 text-gray-700 hover:bg-gray-50"
            }`}
          >
            由申请转单
          </button>
          <button
            type="button"
            onClick={() => setMode("direct")}
            aria-pressed={mode === "direct"}
            disabled={submitting}
            className={`rounded-full px-3.5 py-1.5 text-sm font-medium ${
              mode === "direct"
                ? "bg-gray-900 text-white"
                : "border border-gray-300 text-gray-700 hover:bg-gray-50"
            }`}
          >
            直接创建
          </button>
        </div>

        <Field label="供应商" required error={null}>
          <select
            value={supplierId === "" ? "" : String(supplierId)}
            onChange={(e) =>
              setSupplierId(e.target.value === "" ? "" : Number(e.target.value))
            }
            disabled={submitting}
            className={inputClass}
            aria-label="订单供应商"
          >
            <option value="">选择供应商…</option>
            {suppliers.map((supplier) => (
              <option key={supplier.id} value={supplier.id}>
                {supplier.name}（{supplier.supplier_code}）
              </option>
            ))}
          </select>
        </Field>

        {mode === "request" ? (
          <Field
            label="采购申请"
            required
            error={null}
            hint="仅已批准（APPROVED）的申请可转单；转单后申请变为已下单"
          >
            <select
              value={requestId === "" ? "" : String(requestId)}
              onChange={(e) =>
                setRequestId(e.target.value === "" ? "" : Number(e.target.value))
              }
              disabled={submitting}
              className={inputClass}
              aria-label="转单采购申请"
            >
              <option value="">
                {approvedRequests.length === 0
                  ? "暂无已批准申请"
                  : "选择申请…"}
              </option>
              {approvedRequests.map((pr) => (
                <option key={pr.id} value={pr.id}>
                  {pr.request_no}（{pr.lines.length} 行）
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <Field label="订单行" required error={null} hint="单价可选（仅作采购业务金额，S7 不做付款/应付）">
            <div className="space-y-2">
              {lines.map((line) => (
                <div key={line.key} className="flex items-center gap-2">
                  <select
                    value={line.itemId === "" ? "" : String(line.itemId)}
                    onChange={(e) =>
                      updateLine(line.key, {
                        itemId:
                          e.target.value === "" ? "" : Number(e.target.value),
                      })
                    }
                    disabled={submitting}
                    className={`${inputClass} min-w-0 flex-1`}
                    aria-label="订单物资"
                  >
                    <option value="">选择物资…</option>
                    {items.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.item_code} · {item.name}（{item.base_unit}）
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={line.orderedQuantity}
                    onChange={(e) =>
                      updateLine(line.key, { orderedQuantity: e.target.value })
                    }
                    disabled={submitting}
                    className={`${inputClass} w-24`}
                    aria-label="订购数量"
                  />
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={line.unitPrice}
                    onChange={(e) =>
                      updateLine(line.key, { unitPrice: e.target.value })
                    }
                    disabled={submitting}
                    placeholder="单价"
                    className={`${inputClass} w-24`}
                    aria-label="单价"
                  />
                  <button
                    type="button"
                    onClick={() => removeLine(line.key)}
                    disabled={submitting || lines.length <= 1}
                    aria-label="删除该行"
                    className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-40"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </Field>
        )}
        {mode === "direct" ? (
          <button
            type="button"
            onClick={addLine}
            disabled={submitting}
            className="text-xs font-medium text-gray-900 underline-offset-2 hover:underline disabled:opacity-50"
          >
            + 添加物资
          </button>
        ) : null}

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
            {submitting ? "创建中…" : "创建订单"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
