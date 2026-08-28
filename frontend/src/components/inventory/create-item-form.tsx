"use client";

/**
 * 新建物资表单（Sprint 7 §40，inventory:item_manage）：
 * item_code 唯一且创建后不可变；minimum/target 满足 target >= minimum。
 * 后端 strict schema（extra=forbid）与唯一约束为最终权威。
 */

import { useCallback, useState } from "react";
import { ApiError, api } from "@/lib/api";
import type { ItemCategory } from "@/lib/api/types";
import { ITEM_CATEGORIES, ITEM_CATEGORY_LABELS } from "@/lib/inventory";
import { Modal } from "@/components/modal";
import { Field, inputClass } from "@/components/booking/shared";

export default function CreateItemForm({
  open,
  onClose,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [itemCode, setItemCode] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState<ItemCategory>("GUEST_AMENITY");
  const [baseUnit, setBaseUnit] = useState("个");
  const [minimumStock, setMinimumStock] = useState("0");
  const [targetStock, setTargetStock] = useState("0");
  const [isConsumable, setIsConsumable] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    if (submitting) return;
    if (itemCode.trim() === "") {
      setError("请填写物资代码");
      return;
    }
    if (name.trim() === "") {
      setError("请填写物资名称");
      return;
    }
    if (baseUnit.trim() === "") {
      setError("请填写基础单位");
      return;
    }
    const min = parseFloat(minimumStock);
    const target = parseFloat(targetStock);
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
      await api.inventory.createItem({
        item_code: itemCode.trim(),
        name: name.trim(),
        category,
        base_unit: baseUnit.trim(),
        minimum_stock: min,
        target_stock: target,
        is_consumable: isConsumable,
      });
      onSuccess();
    } catch (err) {
      // 409（代码重复）/ 422 原文展示（后端最终权威）
      setError(err instanceof ApiError ? err.message : "创建失败，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  }, [submitting, itemCode, name, category, baseUnit, minimumStock, targetStock, isConsumable, onSuccess]);

  return (
    <Modal open={open} title="新建物资" onClose={onClose}>
      <div className="space-y-4">
        <Field label="物资代码" required error={null} hint="唯一，创建后不可修改">
          <input
            value={itemCode}
            onChange={(e) => setItemCode(e.target.value)}
            disabled={submitting}
            placeholder="例如：AMEN-WATER-500"
            maxLength={50}
            className={inputClass}
            aria-label="物资代码"
          />
        </Field>
        <Field label="物资名称" required error={null}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={submitting}
            placeholder="例如：矿泉水"
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
        <Field label="基础单位" required error={null} hint="采购/领用/调拨/盘点统一使用该单位">
          <input
            value={baseUnit}
            onChange={(e) => setBaseUnit(e.target.value)}
            disabled={submitting}
            placeholder="例如：瓶 / 双 / 个 / 条"
            maxLength={20}
            className={inputClass}
            aria-label="基础单位"
          />
        </Field>
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
        <Field
          label="是否客耗品"
          error={null}
          hint="客耗品 = 住客直接消耗（客用品/清洁品等）；设备工具类可关闭"
        >
          <label className="flex items-center gap-2.5">
            <input
              type="checkbox"
              checked={isConsumable}
              onChange={(e) => setIsConsumable(e.target.checked)}
              disabled={submitting}
              className="size-4 rounded border-gray-300 text-gray-900 focus:ring-gray-900"
              aria-label="是否客耗品"
            />
            <span className="text-sm text-gray-700">是，该物资为客耗品</span>
          </label>
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
            {submitting ? "创建中…" : "创建物资"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
