"use client";

/**
 * 盘点表单（Sprint 7 §40，inventory:adjust）：
 * - expected = 系统锁定余额；actual = 用户盘点输入；差异自动生成
 *   ADJUSTMENT_IN / ADJUSTMENT_OUT（相同为 no-op）
 * - 必须填写盘点原因（后端 422 最终权威）
 */

import { useCallback, useMemo, useState } from "react";
import { ApiError, api } from "@/lib/api";
import type {
  InventoryItemListRow,
  InventoryLocationOut,
} from "@/lib/api/types";
import { fmtQty, qty } from "@/lib/inventory";
import { Modal } from "@/components/modal";
import { Field, inputClass } from "@/components/booking/shared";

export default function StocktakeForm({
  open,
  items,
  locations,
  onClose,
  onSuccess,
}: {
  open: boolean;
  items: InventoryItemListRow[];
  locations: InventoryLocationOut[];
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [itemId, setItemId] = useState<number | "">("");
  const [locationId, setLocationId] = useState<number | "">("");
  const [actualQuantity, setActualQuantity] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultMessage, setResultMessage] = useState<string | null>(null);

  const selectedItem = useMemo(
    () => items.find((item) => item.id === itemId) ?? null,
    [items, itemId],
  );

  const expectedHint = useMemo(() => {
    if (!selectedItem || locationId === "") return null;
    // 具体地点余额由后端权威计算；这里仅提示总库存供参考
    return null;
  }, [selectedItem, locationId]);

  const submit = useCallback(async () => {
    if (submitting) return;
    if (itemId === "") {
      setError("请选择盘点物资");
      return;
    }
    if (locationId === "") {
      setError("请选择盘点地点");
      return;
    }
    const actual = qty(actualQuantity);
    if (actualQuantity.trim() === "" || Number.isNaN(actual) || actual < 0) {
      setError("实盘数量必须为不小于 0 的数字");
      return;
    }
    if (reason.trim() === "") {
      setError("请填写盘点原因");
      return;
    }
    setSubmitting(true);
    setError(null);
    setResultMessage(null);
    try {
      const result = await api.inventory.stocktake({
        item_id: Number(itemId),
        location_id: Number(locationId),
        actual_quantity: actual,
        reason: reason.trim(),
      });
      const diff = qty(result.difference);
      if (result.movement_type) {
        setResultMessage(
          `盘点完成：账面 ${fmtQty(result.expected_quantity)} → 实盘 ${fmtQty(result.actual_quantity)}，差异 ${
            diff > 0 ? "+" : ""
          }${fmtQty(result.difference)}（已生成${
            result.movement_type === "ADJUSTMENT_IN" ? "盘盈" : "盘亏"
          }调整）`,
        );
      } else {
        setResultMessage(
          `盘点完成：账面与实盘一致（${fmtQty(result.actual_quantity)}），无需调整`,
        );
      }
      setActualQuantity("");
      setReason("");
      onSuccess();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "盘点失败，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  }, [submitting, itemId, locationId, actualQuantity, reason, onSuccess]);

  return (
    <Modal open={open} title="库存盘点" onClose={onClose}>
      <div className="space-y-4">
        <Field label="盘点物资" required error={null}>
          <select
            value={itemId === "" ? "" : String(itemId)}
            onChange={(e) => {
              setItemId(e.target.value === "" ? "" : Number(e.target.value));
              setActualQuantity("");
              setResultMessage(null);
            }}
            disabled={submitting}
            className={inputClass}
            aria-label="盘点物资"
          >
            <option value="">选择物资…</option>
            {items
              .filter((item) => item.is_active)
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.item_code} · {item.name}（总 {fmtQty(item.total_stock)}
                  {item.base_unit}）
                </option>
              ))}
          </select>
        </Field>

        <Field label="盘点地点" required error={null}>
          <select
            value={locationId === "" ? "" : String(locationId)}
            onChange={(e) =>
              setLocationId(e.target.value === "" ? "" : Number(e.target.value))
            }
            disabled={submitting}
            className={inputClass}
            aria-label="盘点地点"
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

        <Field
          label="实盘数量"
          required
          error={null}
          hint={expectedHint ?? "系统以当前锁定余额为账面数，与实盘数比较生成差异调整"}
        >
          <input
            type="number"
            min="0"
            step="any"
            value={actualQuantity}
            onChange={(e) => setActualQuantity(e.target.value)}
            disabled={submitting}
            placeholder="实际清点数量"
            className={inputClass}
            aria-label="实盘数量"
          />
        </Field>

        <Field label="盘点原因" required error={null} hint="差异将作为调整流水的原因记录">
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={submitting}
            placeholder="例如：月度盘点 / 破损报损"
            maxLength={500}
            className={inputClass}
            aria-label="盘点原因"
          />
        </Field>

        {resultMessage ? (
          <p role="status" className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 ring-1 ring-inset ring-emerald-200">
            {resultMessage}
          </p>
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
            关闭
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={submitting}
            className="rounded-md bg-gray-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
          >
            {submitting ? "盘点中…" : "提交盘点"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
