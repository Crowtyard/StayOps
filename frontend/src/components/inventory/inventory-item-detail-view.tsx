"use client";

/**
 * /inventory/items/[id] 物资详情（Sprint 7 §41）：
 * - Item info / Total Stock / Minimum / Target / Recommended Replenishment
 * - Location balances（地点停用标记）
 * - Recent movements（type / quantity / location / operator / time / reference）
 * - 权限显隐：期初库存 + 编辑（inventory:item_manage，后端 403 最终权威）
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ApiError, api } from "@/lib/api";
import type {
  InventoryItemDetailOut,
  InventoryLocationOut,
  ItemCategory,
} from "@/lib/api/types";
import {
  fmtQty,
  ITEM_CATEGORIES,
  ITEM_CATEGORY_LABELS,
  MOVEMENT_TYPE_META,
  qty,
  STOCK_STATUS_META,
} from "@/lib/inventory";
import { useUser } from "@/components/app-shell";
import { ErrorView, Forbidden, Loading } from "@/components/status-views";
import { StatusBadge } from "@/components/status-badge";
import { Modal } from "@/components/modal";
import { Field, inputClass } from "@/components/booking/shared";

export default function InventoryItemDetailView({ id }: { id: string }) {
  const router = useRouter();
  const user = useUser();
  const permissions = useMemo(() => new Set(user?.permissions ?? []), [user]);
  const canRead = permissions.has("inventory:read");
  const canManage = permissions.has("inventory:item_manage");

  const [item, setItem] = useState<InventoryItemDetailOut | null>(null);
  const [locations, setLocations] = useState<InventoryLocationOut[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [showInitial, setShowInitial] = useState(false);
  const [showEdit, setShowEdit] = useState(false);

  useEffect(() => {
    if (!canRead) return;
    let cancelled = false;
    api.inventory
      .getItem(id)
      .then((detail) => {
        if (!cancelled) setItem(detail);
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

  useEffect(() => {
    if (!canManage) return;
    let cancelled = false;
    api.inventory
      .listLocations({ page: 1, page_size: 100 })
      .then((page) => {
        if (!cancelled) setLocations(page.items);
      })
      .catch(() => {
        /* 期初库存表单需要地点；失败时按钮仍可用但无地点选项 */
      });
    return () => {
      cancelled = true;
    };
  }, [canManage]);

  const refresh = useCallback(() => {
    setError(null);
    setReloadKey((k) => k + 1);
  }, []);

  if (!canRead) {
    return <Forbidden text="无权限访问库存（缺少 inventory:read）" />;
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
    return <Forbidden text="该物资不存在或已被移除" />;
  }
  if (!item) {
    return <Loading text="正在加载物资详情…" />;
  }

  return (
    <div>
      <Link
        href="/inventory"
        className="mb-4 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900"
      >
        ← 返回库存工作台
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2.5 text-xl font-semibold text-gray-900">
            {item.name}
            <StatusBadge meta={STOCK_STATUS_META[item.stock_status]} />
            {item.is_active ? null : (
              <span className="text-xs font-normal text-gray-400">已停用</span>
            )}
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            {item.item_code} · {ITEM_CATEGORY_LABELS[item.category]} · 单位{" "}
            {item.base_unit}
            {item.specification ? ` · ${item.specification}` : ""}
          </p>
        </div>
        {canManage ? (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setShowInitial(true)}
              className="rounded-md bg-gray-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-gray-700"
            >
              设置期初库存
            </button>
            <button
              type="button"
              onClick={() => setShowEdit(true)}
              className="rounded-md border border-gray-300 px-3.5 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              编辑物资
            </button>
          </div>
        ) : null}
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: "总库存", value: fmtQty(item.total_stock), unit: item.base_unit },
          { label: "最低库存", value: fmtQty(item.minimum_stock), unit: item.base_unit },
          { label: "目标库存", value: fmtQty(item.target_stock), unit: item.base_unit },
          {
            label: "建议补货",
            value: fmtQty(item.recommended_replenishment),
            unit: item.base_unit,
            accent:
              qty(item.recommended_replenishment) > 0
                ? "text-amber-600"
                : "text-gray-900",
          },
        ].map((card) => (
          <div
            key={card.label}
            className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm"
          >
            <p className="text-xs text-gray-500">{card.label}</p>
            <p
              className={`mt-1.5 text-2xl font-semibold tabular-nums ${card.accent ?? "text-gray-900"}`}
            >
              {card.value}
              <span className="ml-1 text-sm font-normal text-gray-400">
                {card.unit}
              </span>
            </p>
          </div>
        ))}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <section aria-label="地点余额">
          <h2 className="text-sm font-semibold text-gray-900">地点余额</h2>
          <div className="mt-3 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50 text-left text-xs font-medium text-gray-500">
                <tr>
                  <th className="px-4 py-2.5">地点</th>
                  <th className="px-4 py-2.5 text-right">数量</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {item.balances.length === 0 ? (
                  <tr>
                    <td colSpan={2} className="px-4 py-8 text-center text-gray-400">
                      暂无库存余额（可用「设置期初库存」建立）
                    </td>
                  </tr>
                ) : (
                  item.balances.map((balance) => (
                    <tr key={balance.id}>
                      <td className="px-4 py-2.5 text-gray-700">
                        {balance.location_name ?? `#${balance.location_id}`}
                        {balance.location_active ? null : (
                          <span className="ml-1.5 text-xs text-amber-600">
                            （已停用，库存仍计入总库存）
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-gray-900">
                        {fmtQty(balance.quantity)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section aria-label="最近流水">
          <h2 className="text-sm font-semibold text-gray-900">最近流水</h2>
          <div className="mt-3 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
            {item.recent_movements.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-gray-400">
                暂无库存流水
              </p>
            ) : (
              <ul className="divide-y divide-gray-100">
                {item.recent_movements.map((movement) => (
                  <li key={movement.id} className="flex items-center gap-3 px-4 py-2.5">
                    <StatusBadge meta={MOVEMENT_TYPE_META[movement.movement_type]} />
                    <span
                      className={`tabular-nums text-sm font-medium ${
                        qty(movement.quantity) > 0
                          ? "text-emerald-700"
                          : "text-orange-700"
                      }`}
                    >
                      {qty(movement.quantity) > 0 ? "+" : ""}
                      {fmtQty(movement.quantity)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-gray-600">
                      {movement.location_name ?? `#${movement.location_id}`}
                      {movement.reason ? ` · ${movement.reason}` : ""}
                    </span>
                    <span className="shrink-0 text-xs text-gray-400">
                      {movement.operator_name ?? "—"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>

      {showInitial ? (
        <InitialStockModal
          item={item}
          locations={locations}
          onClose={() => setShowInitial(false)}
          onSuccess={() => {
            setShowInitial(false);
            refresh();
          }}
        />
      ) : null}
      {showEdit ? (
        <EditItemModal
          item={item}
          onClose={() => setShowEdit(false)}
          onSuccess={() => {
            setShowEdit(false);
            refresh();
          }}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function InitialStockModal({
  item,
  locations,
  onClose,
  onSuccess,
}: {
  item: InventoryItemDetailOut;
  locations: InventoryLocationOut[];
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [locationId, setLocationId] = useState<number | "">("");
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    if (submitting) return;
    if (locationId === "") {
      setError("请选择库存地点");
      return;
    }
    const q = qty(quantity);
    if (quantity.trim() === "" || Number.isNaN(q) || q < 0) {
      setError("期初数量必须为不小于 0 的数字");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.inventory.setInitialStock(item.id, {
        location_id: Number(locationId),
        quantity: q,
        reason: reason.trim() || null,
      });
      onSuccess();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "设置失败，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  }, [submitting, locationId, quantity, reason, item.id, onSuccess]);

  return (
    <Modal open title="设置期初库存" onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-gray-500">
          期初库存形成 INITIAL 库存流水（{item.item_code} · {item.name}），
          为真实业务动作而非隐藏余额写入。
        </p>
        <Field label="库存地点" required error={null}>
          <select
            value={locationId === "" ? "" : String(locationId)}
            onChange={(e) =>
              setLocationId(e.target.value === "" ? "" : Number(e.target.value))
            }
            disabled={submitting}
            className={inputClass}
            aria-label="期初库存地点"
          >
            <option value="">选择地点…</option>
            {locations.map((loc) => (
              <option key={loc.id} value={loc.id}>
                {loc.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={`期初数量（${item.base_unit}）`} required error={null}>
          <input
            type="number"
            min="0"
            step="any"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            disabled={submitting}
            className={inputClass}
            aria-label="期初数量"
          />
        </Field>
        <Field label="备注" error={null}>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={submitting}
            placeholder="例如：开业盘点"
            maxLength={500}
            className={inputClass}
            aria-label="期初库存备注"
          />
        </Field>
        {error ? (
          <p role="alert" className="text-sm text-red-600">
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
            {submitting ? "提交中…" : "确认期初库存"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function EditItemModal({
  item,
  onClose,
  onSuccess,
}: {
  item: InventoryItemDetailOut;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [name, setName] = useState(item.name);
  const [category, setCategory] = useState<ItemCategory>(item.category);
  const [baseUnit, setBaseUnit] = useState(item.base_unit);
  const [specification, setSpecification] = useState(item.specification ?? "");
  const [minimumStock, setMinimumStock] = useState(fmtQty(item.minimum_stock));
  const [targetStock, setTargetStock] = useState(fmtQty(item.target_stock));
  const [isConsumable, setIsConsumable] = useState(item.is_consumable);
  const [isActive, setIsActive] = useState(item.is_active);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    if (submitting) return;
    if (name.trim() === "") {
      setError("请填写物资名称");
      return;
    }
    const min = qty(minimumStock);
    const target = qty(targetStock);
    if (Number.isNaN(min) || min < 0 || Number.isNaN(target) || target < 0) {
      setError("库存阈值必须为不小于 0 的数字");
      return;
    }
    if (target < min) {
      setError("目标库存不能小于最低库存");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.inventory.updateItem(item.id, {
        name: name.trim(),
        category,
        base_unit: baseUnit.trim(),
        specification: specification.trim() || null,
        minimum_stock: min,
        target_stock: target,
        is_consumable: isConsumable,
        is_active: isActive,
      });
      onSuccess();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "保存失败，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  }, [
    submitting,
    name,
    category,
    baseUnit,
    specification,
    minimumStock,
    targetStock,
    isConsumable,
    isActive,
    item.id,
    onSuccess,
  ]);

  return (
    <Modal open title="编辑物资" onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-gray-500">
          物资代码 {item.item_code} 创建后不可修改；已有库存流水的物资不能修改基础单位。
        </p>
        <Field label="物资名称" required error={null}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={submitting}
            maxLength={100}
            className={inputClass}
            aria-label="物资名称"
          />
        </Field>
        <Field label="分类" required error={null}>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as ItemCategory)}
            disabled={submitting}
            className={inputClass}
            aria-label="物资分类"
          >
            {ITEM_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {ITEM_CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="基础单位" required error={null}>
            <input
              value={baseUnit}
              onChange={(e) => setBaseUnit(e.target.value)}
              disabled={submitting}
              maxLength={20}
              className={inputClass}
              aria-label="基础单位"
            />
          </Field>
          <Field label="规格" error={null}>
            <input
              value={specification}
              onChange={(e) => setSpecification(e.target.value)}
              disabled={submitting}
              maxLength={200}
              className={inputClass}
              aria-label="规格"
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="最低库存" error={null}>
            <input
              type="number"
              min="0"
              step="any"
              value={minimumStock}
              onChange={(e) => setMinimumStock(e.target.value)}
              disabled={submitting}
              className={inputClass}
              aria-label="最低库存"
            />
          </Field>
          <Field label="目标库存" error={null}>
            <input
              type="number"
              min="0"
              step="any"
              value={targetStock}
              onChange={(e) => setTargetStock(e.target.value)}
              disabled={submitting}
              className={inputClass}
              aria-label="目标库存"
            />
          </Field>
        </div>
        <div className="flex items-center gap-6">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={isConsumable}
              onChange={(e) => setIsConsumable(e.target.checked)}
              disabled={submitting}
              className="size-4 rounded border-gray-300 text-gray-900 focus:ring-gray-900"
              aria-label="是否客耗品"
            />
            <span className="text-sm text-gray-700">客耗品</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              disabled={submitting}
              className="size-4 rounded border-gray-300 text-gray-900 focus:ring-gray-900"
              aria-label="是否启用"
            />
            <span className="text-sm text-gray-700">启用（停用不删除档案）</span>
          </label>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-red-600">
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
            {submitting ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
