"use client";

/**
 * /inventory 库存工作台（Sprint 7 §40，Desktop 与 mobile 均可用）：
 * - 首页统计：总物资数 / Low Stock 数 / Out of Stock 数 / 库存地点
 * - Item table：code / name / category / total stock / unit / minimum / status
 * - 筛选：search / category / low-stock / out-of-stock
 * - 权限显隐（后端 403 为最终权威）：新建物资（item_manage）、领用（issue）、
 *   调拨（transfer）、盘点（adjust）
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ApiError, api } from "@/lib/api";
import type {
  InventoryItemListRow,
  InventoryLocationOut,
  ItemCategory,
  RoomOut,
  StockStatus,
} from "@/lib/api/types";
import {
  fmtQty,
  ITEM_CATEGORIES,
  ITEM_CATEGORY_LABELS,
  STOCK_STATUS_META,
  qty,
} from "@/lib/inventory";
import { useUser } from "@/components/app-shell";
import { ErrorView, Forbidden, Loading } from "@/components/status-views";
import { StatusBadge } from "@/components/status-badge";
import CreateItemForm from "@/components/inventory/create-item-form";
import IssueForm from "@/components/inventory/issue-form";
import TransferForm from "@/components/inventory/transfer-form";
import StocktakeForm from "@/components/inventory/stocktake-form";

type ModalKind = "create" | "issue" | "transfer" | "stocktake" | null;

export default function InventoryWorkspaceView() {
  const router = useRouter();
  const user = useUser();
  const permissions = useMemo(() => new Set(user?.permissions ?? []), [user]);
  const canRead = permissions.has("inventory:read");
  const canManage = permissions.has("inventory:item_manage");
  const canIssue = permissions.has("inventory:issue");
  const canTransfer = permissions.has("inventory:transfer");
  const canAdjust = permissions.has("inventory:adjust");

  const [items, setItems] = useState<InventoryItemListRow[] | null>(null);
  const [locations, setLocations] = useState<InventoryLocationOut[]>([]);
  const [rooms, setRooms] = useState<RoomOut[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<ItemCategory | "">("");
  const [stockStatus, setStockStatus] = useState<StockStatus | "">("");
  const [modal, setModal] = useState<ModalKind>(null);

  useEffect(() => {
    if (!canRead) return;
    let cancelled = false;
    const load = async () => {
      try {
        const allItems: InventoryItemListRow[] = [];
        let page = 1;
        for (;;) {
          const result = await api.inventory.listItems({ page, page_size: 100 });
          allItems.push(...result.items);
          if (result.page * result.page_size >= result.total) break;
          page += 1;
        }
        if (!cancelled) setItems(allItems);
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
  }, [canRead, router, reloadKey]);

  useEffect(() => {
    if (!canRead) return;
    let cancelled = false;
    api.inventory
      .listLocations({ page: 1, page_size: 100 })
      .then((page) => {
        if (!cancelled) setLocations(page.items);
      })
      .catch(() => {
        if (!cancelled) setError(new ApiError("unknown", null, "库存地点加载失败"));
      });
    return () => {
      cancelled = true;
    };
  }, [canRead, reloadKey]);

  useEffect(() => {
    // ROOM 目的地需要房间列表（领用）；所有 issue 角色均有 room:read（种子矩阵）
    if (!canIssue) return;
    let cancelled = false;
    api.rooms
      .list({ page: 1, page_size: 100 })
      .then((page) => {
        if (!cancelled) setRooms(page.items);
      })
      .catch(() => {
        /* 房间加载失败仅影响「领用到房间」目的地选项 */
      });
    return () => {
      cancelled = true;
    };
  }, [canIssue]);

  const refresh = useCallback(() => {
    setError(null);
    setReloadKey((k) => k + 1);
  }, []);

  const stats = useMemo(() => {
    const all = items ?? [];
    return {
      total: all.length,
      low: all.filter((i) => i.stock_status === "LOW_STOCK").length,
      out: all.filter((i) => i.stock_status === "OUT_OF_STOCK").length,
      locations: locations.length,
    };
  }, [items, locations]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (items ?? []).filter((item) => {
      if (term && !`${item.item_code} ${item.name}`.toLowerCase().includes(term)) {
        return false;
      }
      if (category !== "" && item.category !== category) return false;
      if (stockStatus === "LOW_STOCK" && item.stock_status !== "LOW_STOCK") {
        return false;
      }
      if (stockStatus === "OUT_OF_STOCK" && item.stock_status !== "OUT_OF_STOCK") {
        return false;
      }
      return true;
    });
  }, [items, search, category, stockStatus]);

  const closeModal = useCallback(() => setModal(null), []);

  if (!canRead) {
    return <Forbidden text="无权限访问库存（缺少 inventory:read）" />;
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
  if (!items) {
    return <Loading text="正在加载库存数据…" />;
  }

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">库存管理</h1>
          <p className="mt-1 text-sm text-gray-500">
            物资 · 地点 · 余额 · 领用 · 调拨 · 盘点
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canManage ? (
            <button
              type="button"
              onClick={() => setModal("create")}
              className="rounded-md bg-gray-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-gray-700"
            >
              新建物资
            </button>
          ) : null}
          {canIssue ? (
            <button
              type="button"
              onClick={() => setModal("issue")}
              className="rounded-md border border-gray-300 px-3.5 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              领用
            </button>
          ) : null}
          {canTransfer ? (
            <button
              type="button"
              onClick={() => setModal("transfer")}
              className="rounded-md border border-gray-300 px-3.5 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              调拨
            </button>
          ) : null}
          {canAdjust ? (
            <button
              type="button"
              onClick={() => setModal("stocktake")}
              className="rounded-md border border-gray-300 px-3.5 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              盘点
            </button>
          ) : null}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: "总物资数", value: stats.total, title: "全部物资档案数" },
          {
            label: "低库存",
            value: stats.low,
            title: "总库存低于最低库存的物资数",
            accent: "text-amber-600",
          },
          {
            label: "缺货",
            value: stats.out,
            title: "总库存为 0 的物资数",
            accent: "text-red-600",
          },
          { label: "库存地点", value: stats.locations, title: "库存地点数" },
        ].map((card) => (
          <div
            key={card.label}
            title={card.title}
            className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm"
          >
            <p className="text-xs text-gray-500">{card.label}</p>
            <p
              className={`mt-1.5 text-2xl font-semibold tabular-nums ${
                card.accent ?? "text-gray-900"
              }`}
            >
              {card.value}
            </p>
          </div>
        ))}
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索代码 / 名称…"
          className="w-56 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm placeholder:text-gray-400 focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
          aria-label="搜索物资"
        />
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as ItemCategory | "")}
          className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
          aria-label="按分类筛选"
        >
          <option value="">全部分类</option>
          {ITEM_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {ITEM_CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={stockStatus === "LOW_STOCK"}
              onChange={(e) =>
                setStockStatus(e.target.checked ? "LOW_STOCK" : "")
              }
              className="size-4 rounded border-gray-300 text-gray-900 focus:ring-gray-900"
              aria-label="只看低库存"
            />
            低库存
          </label>
          <label className="flex items-center gap-1.5 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={stockStatus === "OUT_OF_STOCK"}
              onChange={(e) =>
                setStockStatus(e.target.checked ? "OUT_OF_STOCK" : "")
              }
              className="size-4 rounded border-gray-300 text-gray-900 focus:ring-gray-900"
              aria-label="只看缺货"
            />
            缺货
          </label>
        </div>
      </div>

      <div className="mt-4 overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50 text-left text-xs font-medium text-gray-500">
            <tr>
              <th className="px-4 py-3">代码</th>
              <th className="px-4 py-3">名称</th>
              <th className="px-4 py-3">分类</th>
              <th className="px-4 py-3 text-right">总库存</th>
              <th className="px-4 py-3">单位</th>
              <th className="px-4 py-3 text-right">最低库存</th>
              <th className="px-4 py-3">状态</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-gray-400">
                  暂无匹配的物资
                </td>
              </tr>
            ) : (
              filtered.map((item) => (
                <tr key={item.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <Link
                      href={`/inventory/items/${item.id}`}
                      className="font-medium text-gray-900 hover:underline"
                    >
                      {item.item_code}
                    </Link>
                    {item.is_active ? null : (
                      <span className="ml-1.5 text-xs text-gray-400">已停用</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-700">{item.name}</td>
                  <td className="px-4 py-3 text-gray-500">
                    {ITEM_CATEGORY_LABELS[item.category]}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-900">
                    {fmtQty(item.total_stock)}
                  </td>
                  <td className="px-4 py-3 text-gray-500">{item.base_unit}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-500">
                    {fmtQty(item.minimum_stock)}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge meta={STOCK_STATUS_META[item.stock_status]} />
                    {qty(item.recommended_replenishment) > 0 ? (
                      <span className="ml-2 text-xs text-gray-400">
                        建议补货 {fmtQty(item.recommended_replenishment)}
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <CreateItemForm
        open={modal === "create"}
        onClose={closeModal}
        onSuccess={() => {
          closeModal();
          refresh();
        }}
      />
      <IssueForm
        open={modal === "issue"}
        items={items}
        locations={locations}
        rooms={rooms}
        onClose={closeModal}
        onSuccess={refresh}
      />
      <TransferForm
        open={modal === "transfer"}
        items={items}
        locations={locations}
        onClose={closeModal}
        onSuccess={refresh}
      />
      <StocktakeForm
        open={modal === "stocktake"}
        items={items}
        locations={locations}
        onClose={closeModal}
        onSuccess={refresh}
      />
    </div>
  );
}
