"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ApiError, api } from "@/lib/api";
import type { CleaningStatus, OccupancyStatus, RoomOut, RoomTypeOut } from "@/lib/api/types";
import { CLEANING_META, CLEANING_STATUSES, OCCUPANCY_META, OCCUPANCY_STATUSES } from "@/lib/status";
import { CleaningBadge, OccupancyBadge } from "@/components/status-badge";
import { Empty, ErrorView, Loading } from "@/components/status-views";

interface Filters {
  occupancy: OccupancyStatus | "";
  cleaning: CleaningStatus | "";
  roomTypeId: number | "";
  floor: number | "";
}

const EMPTY_FILTERS: Filters = {
  occupancy: "",
  cleaning: "",
  roomTypeId: "",
  floor: "",
};

function selectClass(active: boolean): string {
  return `rounded-md border px-3 py-2 text-sm ${
    active
      ? "border-gray-900 bg-gray-900 text-white"
      : "border-gray-300 bg-white text-gray-700 hover:border-gray-400"
  } focus:outline-none focus:ring-2 focus:ring-gray-900/30`;
}

export default function RoomsView() {
  const router = useRouter();
  const [rooms, setRooms] = useState<RoomOut[] | null>(null);
  const [roomTypes, setRoomTypes] = useState<RoomTypeOut[]>([]);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [error, setError] = useState<ApiError | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // 占用/清洁/房型走真实后端筛选；楼层后端不支持，客户端过滤
    api.rooms
      .list({
        page: 1,
        page_size: 100,
        occupancy_status: filters.occupancy || undefined,
        cleaning_status: filters.cleaning || undefined,
        room_type_id:
          typeof filters.roomTypeId === "number" ? filters.roomTypeId : undefined,
      })
      .then((page) => {
        if (!cancelled) setRooms(page.items);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.kind === "unauthorized") {
          router.replace("/login");
          return;
        }
        setError(err instanceof ApiError ? err : new ApiError("unknown", null, "加载失败"));
      });
    return () => {
      cancelled = true;
    };
  }, [router, filters.occupancy, filters.cleaning, filters.roomTypeId, reloadKey]);

  // 房型下拉选项（仅加载一次）
  useEffect(() => {
    let cancelled = false;
    api.roomTypes
      .list({ page: 1, page_size: 100 })
      .then((page) => {
        if (!cancelled) setRoomTypes(page.items);
      })
      .catch(() => {
        // 房型列表失败不阻塞房态展示
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const retry = useCallback(() => {
    setError(null);
    setRooms(null);
    setReloadKey((k) => k + 1);
  }, []);

  const floors = useMemo(() => {
    const set = new Set<number>();
    for (const room of rooms ?? []) set.add(room.floor);
    return [...set].sort((a, b) => a - b);
  }, [rooms]);

  const visibleRooms = useMemo(() => {
    let list = rooms ?? [];
    if (typeof filters.floor === "number") {
      list = list.filter((r) => r.floor === filters.floor);
    }
    return list;
  }, [rooms, filters.floor]);

  const setFilter = <K extends keyof Filters>(key: K, value: Filters[K]) => {
    setError(null);
    setRooms(null);
    setFilters((prev) => ({ ...prev, [key]: value }));
  };

  const filterActive =
    filters.occupancy !== "" ||
    filters.cleaning !== "" ||
    filters.roomTypeId !== "" ||
    filters.floor !== "";

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-xl font-semibold text-gray-900">房态棋盘</h1>
        <p className="mt-1 text-sm text-gray-500">
          每间客房展示占用与清洁双状态（文字 + 颜色），点击卡片进入详情
        </p>
      </div>

      {/* 筛选区 */}
      <div className="mb-5 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <FilterField label="占用状态">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setFilter("occupancy", "")}
                className={selectClass(filters.occupancy === "")}
              >
                全部
              </button>
              {OCCUPANCY_STATUSES.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setFilter("occupancy", s)}
                  className={selectClass(filters.occupancy === s)}
                >
                  {OCCUPANCY_META[s].label}
                </button>
              ))}
            </div>
          </FilterField>

          <FilterField label="清洁状态">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setFilter("cleaning", "")}
                className={selectClass(filters.cleaning === "")}
              >
                全部
              </button>
              {CLEANING_STATUSES.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setFilter("cleaning", s)}
                  className={selectClass(filters.cleaning === s)}
                >
                  {CLEANING_META[s].label}
                </button>
              ))}
            </div>
          </FilterField>

          <FilterField label="房型">
            <select
              value={filters.roomTypeId === "" ? "" : String(filters.roomTypeId)}
              onChange={(e) =>
                setFilter(
                  "roomTypeId",
                  e.target.value === "" ? "" : Number(e.target.value),
                )
              }
              className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
            >
              <option value="">全部房型</option>
              {roomTypes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </FilterField>

          <FilterField label="楼层">
            <select
              value={filters.floor === "" ? "" : String(filters.floor)}
              onChange={(e) =>
                setFilter("floor", e.target.value === "" ? "" : Number(e.target.value))
              }
              className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
            >
              <option value="">全部楼层</option>
              {floors.map((f) => (
                <option key={f} value={f}>
                  {f} 楼
                </option>
              ))}
            </select>
          </FilterField>

          {filterActive ? (
            <button
              type="button"
              onClick={() => {
                setError(null);
                setRooms(null);
                setFilters(EMPTY_FILTERS);
              }}
              className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50"
            >
              清除筛选
            </button>
          ) : null}
        </div>
      </div>

      {error ? (
        <ErrorView
          message={error.message}
          offline={error.kind === "network"}
          onRetry={retry}
        />
      ) : !rooms ? (
        <Loading text="正在加载房态棋盘…" />
      ) : rooms.length === 0 ? (
        <Empty text="暂无房间数据" />
      ) : visibleRooms.length === 0 ? (
        <Empty text="当前筛选条件下没有房间" />
      ) : (
        <>
          <p className="mb-3 text-sm text-gray-500">
            显示 {visibleRooms.length} / {rooms.length} 间
          </p>
          <ul className="grid list-none grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {visibleRooms.map((room) => (
              <li key={room.id}>
                <Link
                  href={`/rooms/${room.id}`}
                  className="flex h-full flex-col gap-2.5 rounded-lg border border-gray-200 bg-white p-4 shadow-sm transition-shadow hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-base font-semibold text-gray-900">
                      {room.room_number}
                    </span>
                    <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">
                      {room.floor} 楼
                    </span>
                  </div>
                  <p className="truncate text-sm text-gray-500">
                    {room.room_type?.name ?? `房型 #${room.room_type_id}`}
                  </p>
                  <div className="mt-auto flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-gray-400">占用</span>
                    <OccupancyBadge status={room.occupancy_status} />
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-gray-400">清洁</span>
                    <CleaningBadge status={room.cleaning_status} />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function FilterField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset>
      <legend className="mb-1.5 text-xs font-medium text-gray-500">{label}</legend>
      {children}
    </fieldset>
  );
}
