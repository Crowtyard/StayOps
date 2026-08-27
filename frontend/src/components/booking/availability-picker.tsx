"use client";

/**
 * AvailabilityPicker：可售房间选择器（新建预订与编辑表单共用）。
 * - 真实 GET /availability；日期/房型变化时重新查询
 * - 仅可选择 available 房间；不可用房间展示原因（后端计算）
 * - 无可用房间 → Empty 态（不允许提交由表单层保证）
 * - 选择房间自动带出房型（Room / Room Type 联动，最终校验仍在后端）
 */

import { useEffect, useState } from "react";
import { ApiError, api } from "@/lib/api";
import type {
  AvailabilityItem,
  AvailabilityOut,
  RoomTypeOut,
} from "@/lib/api/types";
import { Field, inputClass } from "@/components/booking/shared";

export interface AvailabilityPickerProps {
  checkIn: string;
  checkOut: string;
  roomTypeId: number | null;
  /** 已选房间（room_id），null = 未选择 */
  value: number | null;
  /** 选择房间（带出房型联动） */
  onChange: (item: AvailabilityItem) => void;
  /** 手动修改房型筛选 */
  onRoomTypeChange: (roomTypeId: number | null) => void;
  roomTypes: RoomTypeOut[];
  /** 日期无效时不查询 */
  datesValid: boolean;
  disabled?: boolean;
}

export default function AvailabilityPicker({
  checkIn,
  checkOut,
  roomTypeId,
  value,
  onChange,
  onRoomTypeChange,
  roomTypes,
  datesValid,
  disabled,
}: AvailabilityPickerProps) {
  // 结果携带其查询键：查询参数变化后旧结果立即失效（渲染期由 state 派生判断）
  const [result, setResult] = useState<{
    key: string;
    data: AvailabilityOut;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const queryKey = `${checkIn}|${checkOut}|${roomTypeId ?? ""}`;
  const fresh = result !== null && result.key === queryKey;

  useEffect(() => {
    if (!datesValid) return;
    let cancelled = false;
    api.availability
      .query({
        check_in_date: checkIn,
        check_out_date: checkOut,
        room_type_id: roomTypeId ?? undefined,
      })
      .then((data) => {
        if (cancelled) return;
        setResult({ key: queryKey, data });
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setResult(null);
        setError(
          err instanceof ApiError ? err.message : "可售性查询失败，请稍后重试",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [checkIn, checkOut, roomTypeId, datesValid, queryKey]);

  const items = fresh ? result.data.items : null;
  const available = (items ?? []).filter((i) => i.available);
  const selectedRoom = (items ?? []).find((i) => i.room_id === value) ?? null;

  return (
    <div className="space-y-2">
      <Field label="房型筛选" error={null}>
        <select
          value={roomTypeId === null ? "" : String(roomTypeId)}
          onChange={(e) =>
            onRoomTypeChange(
              e.target.value === "" ? null : Number(e.target.value),
            )
          }
          disabled={disabled}
          className={inputClass}
          aria-label="按房型筛选可售房间"
        >
          <option value="">全部房型</option>
          {roomTypes.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </Field>

      {!datesValid ? (
        <p className="rounded-md bg-gray-50 px-3 py-2 text-sm text-gray-500">
          请先选择有效的入住与退房日期
        </p>
      ) : error ? (
        <p
          role="alert"
          className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {error}
        </p>
      ) : items === null ? (
        <p className="text-sm text-gray-400">正在查询可售房间…</p>
      ) : available.length === 0 ? (
        <div
          role="status"
          className="rounded-md border border-dashed border-gray-300 py-8 text-center text-sm text-gray-500"
        >
          所选日期无可用房间
        </div>
      ) : (
        <div>
          <p className="mb-1.5 text-xs text-gray-500">
            共 {available.length} 间可用 / {items.length} 间
          </p>
          <ul className="grid list-none grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {items.map((item) => {
              const active = item.room_id === value;
              const disabledItem = !item.available || disabled;
              return (
                <li key={item.room_id}>
                  <button
                    type="button"
                    disabled={disabledItem}
                    aria-pressed={active}
                    title={item.available ? undefined : (item.reason ?? "不可用")}
                    onClick={() => onChange(item)}
                    className={`w-full rounded-md border px-3 py-2.5 text-left text-sm transition-colors ${
                      active
                        ? "border-gray-900 bg-gray-900 text-white"
                        : item.available
                          ? "border-gray-300 bg-white text-gray-800 hover:border-gray-500"
                          : "cursor-not-allowed border-gray-200 bg-gray-50 text-gray-400"
                    }`}
                  >
                    <span className="font-semibold">{item.room_number}</span>
                    <span className="block truncate text-xs opacity-80">
                      {item.room_type_name ?? `房型 #${item.room_type_id}`}
                    </span>
                    {!item.available ? (
                      <span className="mt-0.5 block truncate text-xs text-red-500">
                        {item.reason ?? "不可用"}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {value !== null && selectedRoom ? (
        <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 ring-1 ring-inset ring-emerald-200">
          已选择房间 {selectedRoom.room_number}（
          {selectedRoom.room_type_name ?? `房型 #${selectedRoom.room_type_id}`}）
        </p>
      ) : null}
    </div>
  );
}
