"use client";

/**
 * /procurement 采购工作台（Sprint 7 §42，面向 Manager）：
 * - Low Stock Suggestions（建议补货，仅建议，不自动创建申请/订单）
 * - Pending Purchase Requests（待审批）
 * - Approved / Awaiting Order（已批准待转单）
 * - Ordered / Awaiting Receipt（已下达待收货）
 * - Partially Received（部分收货）
 * 不做复杂图表（§42）。无权限区块不请求、不显示。
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ApiError, api } from "@/lib/api";
import type {
  InventoryItemListRow,
  PurchaseOrderOut,
  PurchaseRequestOut,
} from "@/lib/api/types";
import { fmtQty, qty, STOCK_STATUS_META } from "@/lib/inventory";
import { PR_STATUS_META } from "@/lib/procurement";
import { useUser } from "@/components/app-shell";
import { Forbidden } from "@/components/status-views";
import { StatusBadge } from "@/components/status-badge";

export default function ProcurementWorkbenchView() {
  const router = useRouter();
  const user = useUser();
  const permissions = useMemo(() => new Set(user?.permissions ?? []), [user]);
  const canReadProcurement = permissions.has("procurement:read");
  const canReadInventory = permissions.has("inventory:read");
  const canManageSupplier = permissions.has("procurement:supplier_manage");
  const canRequest = permissions.has("procurement:request");
  const canOrder = permissions.has("procurement:order");

  const [items, setItems] = useState<InventoryItemListRow[] | null>(null);
  const [pending, setPending] = useState<PurchaseRequestOut[] | null>(null);
  const [approved, setApproved] = useState<PurchaseRequestOut[] | null>(null);
  const [awaitingReceipt, setAwaitingReceipt] = useState<
    PurchaseOrderOut[] | null
  >(null);
  const [partial, setPartial] = useState<PurchaseOrderOut[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!canReadProcurement && !canReadInventory) return;
    let cancelled = false;
    const jobs: Promise<void>[] = [];

    if (canReadInventory) {
      jobs.push(
        (async () => {
          const all: InventoryItemListRow[] = [];
          let page = 1;
          for (;;) {
            const result = await api.inventory.listItems({
              page,
              page_size: 100,
            });
            all.push(...result.items);
            if (result.page * result.page_size >= result.total) break;
            page += 1;
          }
          if (!cancelled) setItems(all);
        })(),
      );
    }
    if (canReadProcurement) {
      jobs.push(
        (async () => {
          const page = await api.procurement.listRequests({
            status: "SUBMITTED",
            page: 1,
            page_size: 100,
          });
          if (!cancelled) setPending(page.items);
        })(),
        (async () => {
          const page = await api.procurement.listRequests({
            status: "APPROVED",
            page: 1,
            page_size: 100,
          });
          if (!cancelled) setApproved(page.items);
        })(),
        (async () => {
          const page = await api.procurement.listOrders({
            status: "ORDERED",
            page: 1,
            page_size: 100,
          });
          if (!cancelled) setAwaitingReceipt(page.items);
        })(),
        (async () => {
          const page = await api.procurement.listOrders({
            status: "PARTIALLY_RECEIVED",
            page: 1,
            page_size: 100,
          });
          if (!cancelled) setPartial(page.items);
        })(),
      );
    }
    Promise.all(jobs).catch((err: unknown) => {
      if (cancelled) return;
      if (err instanceof ApiError && err.kind === "unauthorized") {
        router.replace("/login");
        return;
      }
      setError(err instanceof ApiError ? err.message : "采购数据加载失败");
    });
    return () => {
      cancelled = true;
    };
  }, [canReadProcurement, canReadInventory, router]);

  if (!canReadProcurement) {
    return <Forbidden text="无权限访问采购（缺少 procurement:read）" />;
  }

  const lowStockItems = (items ?? []).filter(
    (item) =>
      item.stock_status === "LOW_STOCK" ||
      item.stock_status === "OUT_OF_STOCK",
  );

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">采购工作台</h1>
          <p className="mt-1 text-sm text-gray-500">
            低库存建议 → 采购申请 → 审批 → 订单 → 收货入库
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canManageSupplier ? (
            <Link
              href="/procurement/suppliers"
              className="rounded-md border border-gray-300 px-3.5 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              供应商管理
            </Link>
          ) : null}
          {canRequest ? (
            <Link
              href="/procurement/requests"
              className="rounded-md bg-gray-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-gray-700"
            >
              采购申请
            </Link>
          ) : null}
          {canOrder ? (
            <Link
              href="/procurement/orders"
              className="rounded-md border border-gray-300 px-3.5 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              采购订单
            </Link>
          ) : null}
        </div>
      </div>

      {error ? (
        <p
          role="alert"
          className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-inset ring-red-200"
        >
          {error}
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        {canReadInventory ? (
          <section aria-label="低库存建议">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-900">
                低库存建议
              </h2>
              <Link
                href="/inventory"
                className="text-xs text-gray-500 hover:underline"
              >
                库存工作台 →
              </Link>
            </div>
            <div className="mt-3 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
              {items === null ? (
                <p className="px-4 py-8 text-center text-sm text-gray-400">
                  正在加载…
                </p>
              ) : lowStockItems.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-gray-400">
                  当前无低库存 / 缺货物资
                </p>
              ) : (
                <ul className="divide-y divide-gray-100">
                  {lowStockItems.slice(0, 10).map((item) => (
                    <li key={item.id} className="flex items-center gap-3 px-4 py-2.5">
                      <StatusBadge meta={STOCK_STATUS_META[item.stock_status]} />
                      <Link
                        href={`/inventory/items/${item.id}`}
                        className="min-w-0 flex-1 truncate text-sm text-gray-900 hover:underline"
                      >
                        {item.name}
                        <span className="ml-1.5 text-xs text-gray-400">
                          {item.item_code}
                        </span>
                      </Link>
                      <span className="text-xs text-gray-500">
                        现 {fmtQty(item.total_stock)}
                        {item.base_unit} · 建议补货{" "}
                        {fmtQty(item.recommended_replenishment)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        ) : null}

        <section aria-label="待审批申请">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-900">
              待审批采购申请
            </h2>
            <Link
              href="/procurement/requests"
              className="text-xs text-gray-500 hover:underline"
            >
              全部申请 →
            </Link>
          </div>
          <div className="mt-3 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
            {pending === null ? (
              <p className="px-4 py-8 text-center text-sm text-gray-400">
                正在加载…
              </p>
            ) : pending.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-gray-400">
                当前无待审批申请
              </p>
            ) : (
              <ul className="divide-y divide-gray-100">
                {pending.map((pr) => (
                  <li key={pr.id} className="flex items-center gap-3 px-4 py-2.5">
                    <Link
                      href={`/procurement/requests/${pr.id}`}
                      className="min-w-0 flex-1 truncate text-sm font-medium text-gray-900 hover:underline"
                    >
                      {pr.request_no}
                    </Link>
                    <span className="text-xs text-gray-500">
                      {pr.requester_name ?? "—"} · {pr.lines.length} 行
                    </span>
                    <StatusBadge meta={PR_STATUS_META[pr.status]} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <section aria-label="已批准待转单">
          <h2 className="text-sm font-semibold text-gray-900">
            已批准 · 待转采购订单
          </h2>
          <div className="mt-3 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
            {approved === null ? (
              <p className="px-4 py-8 text-center text-sm text-gray-400">
                正在加载…
              </p>
            ) : approved.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-gray-400">
                当前无已批准申请
              </p>
            ) : (
              <ul className="divide-y divide-gray-100">
                {approved.map((pr) => (
                  <li key={pr.id} className="flex items-center gap-3 px-4 py-2.5">
                    <Link
                      href={`/procurement/requests/${pr.id}`}
                      className="min-w-0 flex-1 truncate text-sm font-medium text-gray-900 hover:underline"
                    >
                      {pr.request_no}
                    </Link>
                    <span className="text-xs text-gray-500">
                      {pr.lines.length} 行
                    </span>
                    <StatusBadge meta={PR_STATUS_META[pr.status]} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <section aria-label="已下达待收货">
          <h2 className="text-sm font-semibold text-gray-900">
            已下达 · 待收货
          </h2>
          <div className="mt-3 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
            {awaitingReceipt === null ? (
              <p className="px-4 py-8 text-center text-sm text-gray-400">
                正在加载…
              </p>
            ) : awaitingReceipt.length === 0 && partial?.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-gray-400">
                当前无待收货订单
              </p>
            ) : (
              <ul className="divide-y divide-gray-100">
                {[...(awaitingReceipt ?? []), ...(partial ?? [])].map((po) => (
                  <li key={po.id} className="flex items-center gap-3 px-4 py-2.5">
                    <Link
                      href={`/procurement/orders/${po.id}`}
                      className="min-w-0 flex-1 truncate text-sm font-medium text-gray-900 hover:underline"
                    >
                      {po.order_no}
                    </Link>
                    <span className="text-xs text-gray-500">
                      {po.supplier_name ?? `#${po.supplier_id}`}
                    </span>
                    {po.status === "PARTIALLY_RECEIVED" ? (
                      <span className="text-xs text-amber-600">部分收货</span>
                    ) : null}
                    <span className="text-xs text-gray-400">
                      {po.lines.reduce(
                        (sum, line) =>
                          sum + (qty(line.ordered_quantity) - qty(line.received_quantity)),
                        0,
                      ) > 0
                        ? "待收"
                        : "已收"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
