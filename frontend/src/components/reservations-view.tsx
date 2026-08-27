"use client";

/**
 * /reservations 预订列表：
 * - 真实 GET /reservations（分页 + 筛选，全部走后端查询参数）
 * - 筛选：status / room / room type / source / guest（GuestPicker）/ 入住日 / 退房日 / search
 * - PII：Guest 列仅 guest:read 显示姓名，否则仅 guest_id；金额仅 reservation:read
 * - 页面级权限：reservation:read（403 → Forbidden 视图，不跳登录）
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ApiError, api } from "@/lib/api";
import type {
  GuestOut,
  ReservationOut,
  ReservationSource,
  ReservationStatus,
  RoomOut,
  RoomTypeOut,
} from "@/lib/api/types";
import {
  RESERVATION_SOURCES,
  RESERVATION_STATUS_META,
  SOURCE_LABELS,
  formatMoney,
} from "@/lib/booking";
import { StatusBadge } from "@/components/status-badge";
import { Empty, ErrorView, Forbidden, Loading } from "@/components/status-views";
import { useUser } from "@/components/app-shell";
import GuestPicker from "@/components/booking/guest-picker";
import { inputClass, primaryButtonClass } from "@/components/booking/shared";
import { IconSearch } from "@/components/icons";

const PAGE_SIZE = 20;

interface Filters {
  status: ReservationStatus | "";
  roomId: number | "";
  roomTypeId: number | "";
  source: ReservationSource | "";
  checkIn: string;
  checkOut: string;
  search: string;
}

const EMPTY_FILTERS: Filters = {
  status: "",
  roomId: "",
  roomTypeId: "",
  source: "",
  checkIn: "",
  checkOut: "",
  search: "",
};

export default function ReservationsView() {
  const router = useRouter();
  const user = useUser();
  const permissions = useMemo(() => new Set(user?.permissions ?? []), [user]);
  const canReadGuest = permissions.has("guest:read");
  const canWriteReservation = permissions.has("reservation:write");

  const [items, setItems] = useState<ReservationOut[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [guestFilter, setGuestFilter] = useState<GuestOut | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [rooms, setRooms] = useState<RoomOut[]>([]);
  const [roomTypes, setRoomTypes] = useState<RoomTypeOut[]>([]);

  useEffect(() => {
    let cancelled = false;
    api.reservations
      .list({
        page,
        page_size: PAGE_SIZE,
        status: filters.status || undefined,
        room_id: typeof filters.roomId === "number" ? filters.roomId : undefined,
        room_type_id:
          typeof filters.roomTypeId === "number" ? filters.roomTypeId : undefined,
        source: filters.source || undefined,
        check_in_date: filters.checkIn || undefined,
        check_out_date: filters.checkOut || undefined,
        search: filters.search.trim() || undefined,
        guest_id: guestFilter?.id,
      })
      .then((result) => {
        if (cancelled) return;
        setItems(result.items);
        setTotal(result.total);
        if (result.page !== page) setPage(result.page);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.kind === "unauthorized") {
          router.replace("/login");
          return;
        }
        if (err instanceof ApiError && err.kind === "forbidden") {
          setForbidden(true);
          return;
        }
        setError(
          err instanceof ApiError ? err : new ApiError("unknown", null, "加载失败"),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [
    router,
    page,
    filters.status,
    filters.roomId,
    filters.roomTypeId,
    filters.source,
    filters.checkIn,
    filters.checkOut,
    filters.search,
    guestFilter,
    reloadKey,
  ]);

  // 房间 / 房型下拉（仅加载一次；失败不阻塞）
  useEffect(() => {
    let cancelled = false;
    api.rooms
      .list({ page: 1, page_size: 100 })
      .then((p) => {
        if (!cancelled) setRooms(p.items);
      })
      .catch(() => {});
    api.roomTypes
      .list({ page: 1, page_size: 100 })
      .then((p) => {
        if (!cancelled) setRoomTypes(p.items);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const retry = useCallback(() => {
    setError(null);
    setItems(null);
    setReloadKey((k) => k + 1);
  }, []);

  function setFilter<K extends keyof Filters>(key: K, value: Filters[K]) {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setPage(1);
  }

  const filterActive =
    filters.status !== "" ||
    filters.roomId !== "" ||
    filters.roomTypeId !== "" ||
    filters.source !== "" ||
    filters.checkIn !== "" ||
    filters.checkOut !== "" ||
    filters.search !== "" ||
    guestFilter !== null;

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  if (forbidden) {
    return <Forbidden text="无权限查看预订列表" />;
  }
  if (error) {
    return (
      <ErrorView
        message={error.message}
        offline={error.kind === "network"}
        onRetry={retry}
      />
    );
  }
  if (!items) {
    return <Loading text="正在加载预订列表…" />;
  }

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">预订管理</h1>
          <p className="mt-1 text-sm text-gray-500">
            共 {total} 条预订 · 点击行进入详情（入住 / 取消 / 未到店 / 编辑）
          </p>
        </div>
        {canWriteReservation ? (
          <Link href="/reservations/new" className={primaryButtonClass}>
            新建预订
          </Link>
        ) : null}
      </div>

      {/* 筛选区（全部为后端查询参数，无客户端伪造） */}
      <div className="mb-5 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-xs font-medium text-gray-600">
            状态
            <select
              value={filters.status}
              onChange={(e) =>
                setFilter("status", e.target.value as ReservationStatus | "")
              }
              className={`${inputClass} mt-1`}
              aria-label="按状态筛选"
            >
              <option value="">全部状态</option>
              {(Object.keys(RESERVATION_STATUS_META) as ReservationStatus[]).map(
                (s) => (
                  <option key={s} value={s}>
                    {RESERVATION_STATUS_META[s].label}（{s}）
                  </option>
                ),
              )}
            </select>
          </label>

          <label className="text-xs font-medium text-gray-600">
            房间
            <select
              value={filters.roomId === "" ? "" : String(filters.roomId)}
              onChange={(e) =>
                setFilter(
                  "roomId",
                  e.target.value === "" ? "" : Number(e.target.value),
                )
              }
              className={`${inputClass} mt-1`}
              aria-label="按房间筛选"
            >
              <option value="">全部房间</option>
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.room_number}
                </option>
              ))}
            </select>
          </label>

          <label className="text-xs font-medium text-gray-600">
            房型
            <select
              value={filters.roomTypeId === "" ? "" : String(filters.roomTypeId)}
              onChange={(e) =>
                setFilter(
                  "roomTypeId",
                  e.target.value === "" ? "" : Number(e.target.value),
                )
              }
              className={`${inputClass} mt-1`}
              aria-label="按房型筛选"
            >
              <option value="">全部房型</option>
              {roomTypes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>

          <label className="text-xs font-medium text-gray-600">
            来源
            <select
              value={filters.source}
              onChange={(e) =>
                setFilter("source", e.target.value as ReservationSource | "")
              }
              className={`${inputClass} mt-1`}
              aria-label="按来源筛选"
            >
              <option value="">全部来源</option>
              {RESERVATION_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {SOURCE_LABELS[s]}（{s}）
                </option>
              ))}
            </select>
          </label>

          <label className="text-xs font-medium text-gray-600">
            入住日期
            <input
              type="date"
              value={filters.checkIn}
              onChange={(e) => setFilter("checkIn", e.target.value)}
              className={`${inputClass} mt-1`}
              aria-label="按入住日期筛选"
            />
          </label>

          <label className="text-xs font-medium text-gray-600">
            退房日期
            <input
              type="date"
              value={filters.checkOut}
              onChange={(e) => setFilter("checkOut", e.target.value)}
              className={`${inputClass} mt-1`}
              aria-label="按退房日期筛选"
            />
          </label>

          <div className="sm:col-span-2">
            <label className="text-xs font-medium text-gray-600">
              搜索（预订号 / 客人姓名 / 手机号）
              <div className="relative mt-1">
                <IconSearch className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-gray-400" />
                <input
                  type="search"
                  value={filters.search}
                  onChange={(e) => setFilter("search", e.target.value)}
                  className={`${inputClass} pl-9`}
                  aria-label="搜索预订"
                />
              </div>
            </label>
          </div>
        </div>

        {canReadGuest ? (
          <div className="mt-3 border-t border-gray-100 pt-3">
            <GuestPicker
              value={guestFilter?.id ?? null}
              selected={guestFilter}
              onChange={(g) => {
                setGuestFilter(g);
                setPage(1);
              }}
              canSearch
              canCreate={permissions.has("guest:write")}
            />
          </div>
        ) : null}

        {filterActive ? (
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={() => {
                setFilters(EMPTY_FILTERS);
                setGuestFilter(null);
                setPage(1);
              }}
              className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50"
            >
              清除筛选
            </button>
          </div>
        ) : null}
      </div>

      {items.length === 0 ? (
        <Empty text="没有符合条件的预订" />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 text-xs text-gray-500">
                <th className="px-4 py-2.5 font-medium">预订号</th>
                <th className="px-4 py-2.5 font-medium">客人</th>
                <th className="px-4 py-2.5 font-medium">房间</th>
                <th className="px-4 py-2.5 font-medium">房型</th>
                <th className="px-4 py-2.5 font-medium">入住</th>
                <th className="px-4 py-2.5 font-medium">退房</th>
                <th className="px-4 py-2.5 font-medium">来源</th>
                <th className="px-4 py-2.5 font-medium">状态</th>
                <th className="px-4 py-2.5 font-medium">金额</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id} className="border-b border-gray-100 last:border-0">
                  <td className="px-4 py-3">
                    <Link
                      href={`/reservations/${r.id}`}
                      className="font-medium text-gray-900 hover:underline"
                    >
                      {r.reservation_no}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-gray-700">
                    {r.guest_name ??
                      (canReadGuest ? "—" : `ID ${r.guest_id}`)}
                  </td>
                  <td className="px-4 py-3 text-gray-700">
                    {r.room_number ?? `#${r.room_id}`}
                  </td>
                  <td className="px-4 py-3 text-gray-700">
                    {r.room_type_name ?? `#${r.room_type_id}`}
                  </td>
                  <td className="px-4 py-3 text-gray-700">{r.check_in_date}</td>
                  <td className="px-4 py-3 text-gray-700">{r.check_out_date}</td>
                  <td className="px-4 py-3 text-gray-700">
                    {SOURCE_LABELS[r.source] ?? r.source}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge meta={RESERVATION_STATUS_META[r.status]} />
                  </td>
                  <td className="px-4 py-3 tabular-nums text-gray-700">
                    {formatMoney(r.agreed_total_amount, r.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 分页：真实后端分页，不假设数据规模 */}
      <div className="mt-4 flex items-center justify-between gap-3">
        <p className="text-sm text-gray-500">
          第 {page} / {totalPages} 页 · 每页 {PAGE_SIZE} 条
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            上一页
          </button>
          <button
            type="button"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            下一页
          </button>
        </div>
      </div>
    </div>
  );
}
