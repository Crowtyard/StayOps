"use client";

/**
 * /stays 在住列表（stay:read 导航落点，消费 T1 交付的 GET /stays 查询能力）：
 * - 筛选：status / room_id / planned_check_out_date（后端查询参数）
 * - PII：Guest 列仅 guest:read 显示姓名；关联预订摘要仅 reservation:read
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ApiError, api } from "@/lib/api";
import type { RoomOut, StayOut, StayStatus } from "@/lib/api/types";
import {
  RESERVATION_STATUS_META,
  STAY_STATUS_META,
  formatDateTime,
} from "@/lib/booking";
import { StatusBadge } from "@/components/status-badge";
import { Empty, ErrorView, Forbidden, Loading } from "@/components/status-views";
import { useUser } from "@/components/app-shell";
import { inputClass } from "@/components/booking/shared";

const PAGE_SIZE = 20;

export default function StaysView() {
  const router = useRouter();
  const user = useUser();
  const permissions = useMemo(() => new Set(user?.permissions ?? []), [user]);
  const canReadGuest = permissions.has("guest:read");
  const canReadReservation = permissions.has("reservation:read");

  const [items, setItems] = useState<StayOut[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<StayStatus | "">("");
  const [roomId, setRoomId] = useState<number | "">("");
  const [plannedCheckOut, setPlannedCheckOut] = useState("");
  const [rooms, setRooms] = useState<RoomOut[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api.stays
      .list({
        page,
        page_size: PAGE_SIZE,
        status: status || undefined,
        room_id: typeof roomId === "number" ? roomId : undefined,
        planned_check_out_date: plannedCheckOut || undefined,
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
  }, [router, page, status, roomId, plannedCheckOut, reloadKey]);

  useEffect(() => {
    let cancelled = false;
    api.rooms
      .list({ page: 1, page_size: 100 })
      .then((p) => {
        if (!cancelled) setRooms(p.items);
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

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  if (forbidden) {
    return <Forbidden text="无权限查看看在住列表" />;
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
    return <Loading text="正在加载在住列表…" />;
  }

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-xl font-semibold text-gray-900">在住管理</h1>
        <p className="mt-1 text-sm text-gray-500">
          共 {total} 条入住记录 · 点击行进入详情办理退房
        </p>
      </div>

      <div className="mb-5 grid gap-3 rounded-lg border border-gray-200 bg-white p-4 shadow-sm sm:grid-cols-3">
        <label className="text-xs font-medium text-gray-600">
          状态
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as StayStatus | "");
              setPage(1);
            }}
            className={`${inputClass} mt-1`}
            aria-label="按状态筛选"
          >
            <option value="">全部状态</option>
            {(Object.keys(STAY_STATUS_META) as StayStatus[]).map((s) => (
              <option key={s} value={s}>
                {STAY_STATUS_META[s].label}（{s}）
              </option>
            ))}
          </select>
        </label>

        <label className="text-xs font-medium text-gray-600">
          房间
          <select
            value={roomId === "" ? "" : String(roomId)}
            onChange={(e) => {
              setRoomId(e.target.value === "" ? "" : Number(e.target.value));
              setPage(1);
            }}
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
          计划退房日期
          <input
            type="date"
            value={plannedCheckOut}
            onChange={(e) => {
              setPlannedCheckOut(e.target.value);
              setPage(1);
            }}
            className={`${inputClass} mt-1`}
            aria-label="按计划退房日期筛选"
          />
        </label>
      </div>

      {items.length === 0 ? (
        <Empty text="没有符合条件的入住记录" />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 text-xs text-gray-500">
                <th className="px-4 py-2.5 font-medium">入住单号</th>
                <th className="px-4 py-2.5 font-medium">房间</th>
                <th className="px-4 py-2.5 font-medium">状态</th>
                <th className="px-4 py-2.5 font-medium">实际入住</th>
                <th className="px-4 py-2.5 font-medium">计划退房</th>
                <th className="px-4 py-2.5 font-medium">实际退房</th>
                <th className="px-4 py-2.5 font-medium">客人</th>
                <th className="px-4 py-2.5 font-medium">预订状态</th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id} className="border-b border-gray-100 last:border-0">
                  <td className="px-4 py-3">
                    <Link
                      href={`/stays/${s.id}`}
                      className="font-medium text-gray-900 hover:underline"
                    >
                      {s.stay_no}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-gray-700">
                    {s.room_number ?? `#${s.room_id}`}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge meta={STAY_STATUS_META[s.status]} />
                  </td>
                  <td className="px-4 py-3 text-gray-700">
                    {formatDateTime(s.actual_check_in_at)}
                  </td>
                  <td className="px-4 py-3 text-gray-700">
                    {s.planned_check_out_date}
                  </td>
                  <td className="px-4 py-3 text-gray-700">
                    {formatDateTime(s.actual_check_out_at)}
                  </td>
                  <td className="px-4 py-3 text-gray-700">
                    {s.guest_name ??
                      (s.guest_id != null
                        ? canReadGuest
                          ? "—"
                          : `ID ${s.guest_id}`
                        : "—")}
                  </td>
                  <td className="px-4 py-3">
                    {canReadReservation && s.reservation ? (
                      <StatusBadge
                        meta={RESERVATION_STATUS_META[s.reservation.status]}
                      />
                    ) : (
                      <span className="text-xs text-gray-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

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
