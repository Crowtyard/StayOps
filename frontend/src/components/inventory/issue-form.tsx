"use client";

/**
 * 领用单表单（Sprint 7 §40，inventory:issue）：
 * - 多行领用整体原子；任一行库存不足 -> 后端 409 整体回滚（detail 原文展示）
 * - destination_type=ROOM 时 room_id 必填；其它类型不填 room_id
 * - 后端严格校验（stock 不足 409 / 房间缺失 422）为最终权威
 */

import { useCallback, useMemo, useState } from "react";
import { ApiError, api } from "@/lib/api";
import type {
  InventoryItemListRow,
  InventoryLocationOut,
  IssueDestinationType,
  RoomOut,
} from "@/lib/api/types";
import { fmtQty, ISSUE_DESTINATIONS, ISSUE_DESTINATION_LABELS, qty } from "@/lib/inventory";
import { Modal } from "@/components/modal";
import { Field, inputClass } from "@/components/booking/shared";

interface DraftLine {
  key: number;
  itemId: number | "";
  quantity: string;
}

let nextKey = 1;

export default function IssueForm({
  open,
  items,
  locations,
  rooms,
  onClose,
  onSuccess,
}: {
  open: boolean;
  items: InventoryItemListRow[];
  locations: InventoryLocationOut[];
  rooms: RoomOut[];
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [sourceLocationId, setSourceLocationId] = useState<number | "">("");
  const [destinationType, setDestinationType] =
    useState<IssueDestinationType>("HOUSEKEEPING");
  const [roomId, setRoomId] = useState<number | "">("");
  const [lines, setLines] = useState<DraftLine[]>([
    { key: nextKey++, itemId: "", quantity: "1" },
  ]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const availableItems = useMemo(
    () => items.filter((item) => item.is_active),
    [items],
  );

  const updateLine = useCallback((key: number, patch: Partial<DraftLine>) => {
    setLines((prev) =>
      prev.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    );
  }, []);

  const addLine = useCallback(() => {
    setLines((prev) => [
      ...prev,
      { key: nextKey++, itemId: "", quantity: "1" },
    ]);
  }, []);

  const removeLine = useCallback((key: number) => {
    setLines((prev) =>
      prev.length <= 1 ? prev : prev.filter((line) => line.key !== key),
    );
  }, []);

  const totalHint = useMemo(() => {
    const rows = lines.filter(
      (line) => line.itemId !== "" && qty(line.quantity) > 0,
    );
    return rows
      .map((line) => {
        const item = items.find((i) => i.id === line.itemId);
        if (!item) return null;
        return `${item.name} ×${fmtQty(line.quantity)}${item.base_unit}`;
      })
      .filter(Boolean)
      .join("；");
  }, [lines, items]);

  const submit = useCallback(async () => {
    if (submitting) return;
    if (sourceLocationId === "") {
      setError("请选择领用来源地点");
      return;
    }
    const validLines = lines.filter(
      (line) => line.itemId !== "" && qty(line.quantity) > 0,
    );
    if (validLines.length === 0) {
      setError("请至少选择一种物资并填写数量");
      return;
    }
    const itemIds = validLines.map((line) => line.itemId as number);
    if (new Set(itemIds).size !== itemIds.length) {
      setError("同一领用单不允许重复物资");
      return;
    }
    if (destinationType === "ROOM" && roomId === "") {
      setError("领用目的地为房间时必须选择房间");
      return;
    }
    setSubmitting(true);
    setError(null);
    setSuccessMessage(null);
    try {
      const result = await api.inventory.issue({
        source_location_id: Number(sourceLocationId),
        destination_type: destinationType,
        room_id: destinationType === "ROOM" ? Number(roomId) : null,
        lines: validLines.map((line) => ({
          item_id: line.itemId as number,
          quantity: qty(line.quantity),
        })),
      });
      setSuccessMessage(`领用成功：${result.issue_no}`);
      setLines([{ key: nextKey++, itemId: "", quantity: "1" }]);
      onSuccess();
    } catch (err) {
      // 409 库存不足 / 422 参数错误原文展示（后端最终权威）
      setError(err instanceof ApiError ? err.message : "领用失败，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  }, [submitting, sourceLocationId, destinationType, roomId, lines, onSuccess]);

  return (
    <Modal open={open} title="物资领用" onClose={onClose}>
      <div className="space-y-4">
        <Field label="来源地点" required error={null}>
          <select
            value={sourceLocationId === "" ? "" : String(sourceLocationId)}
            onChange={(e) =>
              setSourceLocationId(
                e.target.value === "" ? "" : Number(e.target.value),
              )
            }
            disabled={submitting}
            className={inputClass}
            aria-label="领用来源地点"
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

        <Field label="领用目的地" required error={null}>
          <select
            value={destinationType}
            onChange={(e) => {
              setDestinationType(e.target.value as IssueDestinationType);
              setRoomId("");
            }}
            disabled={submitting}
            className={inputClass}
            aria-label="领用目的地"
          >
            {ISSUE_DESTINATIONS.map((d) => (
              <option key={d} value={d}>
                {ISSUE_DESTINATION_LABELS[d]}
              </option>
            ))}
          </select>
        </Field>

        {destinationType === "ROOM" ? (
          <Field label="房间" required error={null}>
            <select
              value={roomId === "" ? "" : String(roomId)}
              onChange={(e) =>
                setRoomId(e.target.value === "" ? "" : Number(e.target.value))
              }
              disabled={submitting}
              className={inputClass}
              aria-label="领用房间"
            >
              <option value="">选择房间…</option>
              {rooms.map((room) => (
                <option key={room.id} value={room.id}>
                  {room.room_number}
                </option>
              ))}
            </select>
          </Field>
        ) : null}

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-xs font-medium text-gray-600">
              领用明细<span className="ml-0.5 text-red-500">*</span>
            </span>
            <button
              type="button"
              onClick={addLine}
              disabled={submitting}
              className="text-xs font-medium text-gray-900 underline-offset-2 hover:underline disabled:opacity-50"
            >
              + 添加物资
            </button>
          </div>
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
                  aria-label="领用物资"
                >
                  <option value="">选择物资…</option>
                  {availableItems.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.item_code} · {item.name}（现 {fmtQty(item.total_stock)}
                      {item.base_unit}）
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={line.quantity}
                  onChange={(e) => updateLine(line.key, { quantity: e.target.value })}
                  disabled={submitting}
                  className={`${inputClass} w-24`}
                  aria-label="领用数量"
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
          {totalHint ? (
            <p className="mt-1.5 text-xs text-gray-400">将领用：{totalHint}</p>
          ) : null}
        </div>

        {successMessage ? (
          <p role="status" className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 ring-1 ring-inset ring-emerald-200">
            {successMessage}
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
            {submitting ? "领用中…" : "确认领用"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
