"use client";

/**
 * 统一搜索：房号 / Guest name / phone / reservation_no。
 * - 房号：本地匹配 Room（不产生 PII 请求）
 * - Guest name / phone / reservation_no：复用 GET /reservations?search=
 *   （后端 guest:read 裁剪 PII；前端双保险）
 * - PII 搜索约束：无 guest:read 时仅允许 预订单号（RSV*）/ 房号 搜索，
 *   不向前端以外的任何途径放宽权限（后端裁剪仍是最终边界）
 * - 结果点击：定位房间 / 打开 Reservation Drawer / 定位日期（由上层回调）
 */

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { ReservationOut, RoomOut } from "@/lib/api/types";
import {
  looksLikeReservationNo,
  matchRoomsByNumber,
} from "@/lib/front-desk";
import { SOURCE_LABELS } from "@/lib/booking";
import { IconSearch, IconX } from "@/components/icons";
import { CleaningBadge, OccupancyBadge } from "@/components/status-badge";

export type SearchResultItem =
  | { type: "room"; room: RoomOut }
  | { type: "reservation"; reservation: ReservationOut };

export interface SearchBoxProps {
  rooms: RoomOut[];
  canReadGuest: boolean;
  canSearchReservations: boolean;
  onOpenRoom: (room: RoomOut) => void;
  onOpenReservation: (reservation: ReservationOut) => void;
}

export default function SearchBox({
  rooms,
  canReadGuest,
  canSearchReservations,
  onOpenRoom,
  onOpenReservation,
}: SearchBoxProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  // 结果携带查询键（同 availability-picker 模式）：查询变化后旧结果立即失效
  const [apiResult, setApiResult] = useState<{
    key: string;
    items: ReservationOut[];
  } | null>(null);

  const trimmed = query.trim();
  const allowGuestSearch = canReadGuest || looksLikeReservationNo(trimmed);
  const fresh = apiResult !== null && apiResult.key === trimmed;
  const searching =
    trimmed !== "" && canSearchReservations && allowGuestSearch && !fresh;

  useEffect(() => {
    if (
      trimmed === "" ||
      !canSearchReservations ||
      !allowGuestSearch
    ) {
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api.reservations
        .list({ search: trimmed, page: 1, page_size: 8 })
        .then((page) => {
          if (!cancelled) setApiResult({ key: trimmed, items: page.items });
        })
        .catch(() => {
          // 搜索失败静默降级：仍可显示本地房号匹配
          if (!cancelled) setApiResult({ key: trimmed, items: [] });
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [trimmed, canSearchReservations, allowGuestSearch]);

  const roomMatches = matchRoomsByNumber(rooms, trimmed);
  const reservationItems = fresh ? apiResult.items : [];
  const showHint =
    trimmed !== "" && !allowGuestSearch && !searching;
  const hasAny = roomMatches.length > 0 || reservationItems.length > 0;

  function pick(item: SearchResultItem) {
    if (item.type === "room") {
      onOpenRoom(item.room);
    } else {
      onOpenReservation(item.reservation);
    }
    setQuery("");
    setOpen(false);
    setApiResult(null);
  }

  return (
    <div className="relative w-full max-w-md">
      <div className="relative">
        <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-gray-400">
          <IconSearch className="size-4" />
        </span>
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder="搜索房号 / 客人姓名 / 手机号 / 预订单号"
          aria-label="搜索房号、客人、预订单号"
          className="w-full rounded-md border border-gray-300 bg-white py-2 pl-9 pr-8 text-sm text-gray-900 placeholder:text-gray-400 focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
        />
        {query !== "" ? (
          <button
            type="button"
            aria-label="清空搜索"
            onClick={() => {
              setQuery("");
              setApiResult(null);
            }}
            className="absolute inset-y-0 right-2 flex items-center rounded-md p-1 text-gray-400 hover:text-gray-700"
          >
            <IconX className="size-3.5" />
          </button>
        ) : null}
      </div>

      {open && trimmed !== "" ? (
        <>
          <button
            type="button"
            aria-label="关闭搜索结果"
            className="fixed inset-0 z-30 cursor-default"
            onClick={() => setOpen(false)}
            tabIndex={-1}
          />
          <div className="absolute z-40 mt-1 max-h-80 w-full overflow-y-auto rounded-md border border-gray-200 bg-white py-1 shadow-lg">
            {roomMatches.map((room) => (
              <button
                key={`room-${room.id}`}
                type="button"
                data-search-room={room.room_number}
                onClick={() => pick({ type: "room", room })}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50"
              >
                <span className="font-semibold text-gray-900">
                  {room.room_number}
                </span>
                <span className="truncate text-xs text-gray-500">
                  {room.room_type?.name ?? `房型 #${room.room_type_id}`}
                </span>
                <span className="ml-auto flex shrink-0 gap-1">
                  <OccupancyBadge status={room.occupancy_status} />
                  <CleaningBadge status={room.cleaning_status} />
                </span>
              </button>
            ))}
            {reservationItems.map((res) => (
              <button
                key={`res-${res.id}`}
                type="button"
                data-search-reservation={res.id}
                onClick={() => pick({ type: "reservation", reservation: res })}
                className="block w-full px-3 py-2 text-left text-sm hover:bg-gray-50"
              >
                <span className="font-semibold text-gray-900">
                  {res.reservation_no}
                </span>
                <span className="text-gray-600">
                  {" "}
                  · 房间 {res.room_number ?? `#${res.room_id}`}
                  {canReadGuest && res.guest_name ? ` · ${res.guest_name}` : null}
                </span>
                <span className="block text-xs text-gray-400">
                  {res.check_in_date} → {res.check_out_date} ·{" "}
                  {SOURCE_LABELS[res.source] ?? res.source} · {res.status}
                </span>
              </button>
            ))}
            {searching ? (
              <p className="px-3 py-2 text-xs text-gray-400">
                正在搜索预订…
              </p>
            ) : null}
            {showHint ? (
              <p className="px-3 py-2 text-xs text-amber-700">
                按客人姓名 / 手机号搜索需要 guest:read 权限；可搜索房号或预订单号
              </p>
            ) : null}
            {!searching && !showHint && !hasAny ? (
              <p className="px-3 py-2 text-xs text-gray-400">无匹配结果</p>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
