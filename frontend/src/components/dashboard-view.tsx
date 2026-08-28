"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ApiError, api } from "@/lib/api";
import type { ReservationOut, RoomOut, StayOut } from "@/lib/api/types";
import { addDays, businessDate } from "@/lib/booking";
import { ErrorView, Loading } from "@/components/status-views";
import { useUser } from "@/components/app-shell";

interface Stats {
  total: number;
  available: number;
  reserved: number;
  occupied: number;
  blocked: number;
  outOfService: number;
  clean: number;
  dirty: number;
  cleaning: number;
  inspection: number;
  rework: number;
}

const EMPTY_STATS: Stats = {
  total: 0,
  available: 0,
  reserved: 0,
  occupied: 0,
  blocked: 0,
  outOfService: 0,
  clean: 0,
  dirty: 0,
  cleaning: 0,
  inspection: 0,
  rework: 0,
};

function computeStats(rooms: RoomOut[]): Stats {
  const stats: Stats = { ...EMPTY_STATS };
  for (const room of rooms) {
    stats.total += 1;
    switch (room.occupancy_status) {
      case "available":
        stats.available += 1;
        break;
      case "reserved":
        stats.reserved += 1;
        break;
      case "occupied":
        stats.occupied += 1;
        break;
      case "blocked":
        stats.blocked += 1;
        break;
      case "out_of_service":
        stats.outOfService += 1;
        break;
    }
    switch (room.cleaning_status) {
      case "clean":
        stats.clean += 1;
        break;
      case "dirty":
        stats.dirty += 1;
        break;
      case "cleaning":
        stats.cleaning += 1;
        break;
      case "inspection":
        stats.inspection += 1;
        break;
      case "rework":
        stats.rework += 1;
        break;
    }
  }
  return stats;
}

interface StatCard {
  key: string;
  label: string;
  value: number;
  accent: string;
  title: string;
}

export default function DashboardView() {
  const router = useRouter();
  const user = useUser();
  const permissions = useMemo(() => new Set(user?.permissions ?? []), [user]);
  const [rooms, setRooms] = useState<RoomOut[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api.rooms
      .list({ page: 1, page_size: 100 })
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
  }, [router, reloadKey]);

  const retry = useCallback(() => {
    setError(null);
    setRooms(null);
    setReloadKey((k) => k + 1);
  }, []);

  if (error) {
    return (
      <ErrorView
        message={error.message}
        offline={error.kind === "network"}
        onRetry={retry}
      />
    );
  }
  if (!rooms) {
    return <Loading text="正在加载房态数据…" />;
  }

  const stats = computeStats(rooms);

  const cards: StatCard[] = [
    { key: "total", label: "总房", value: stats.total, accent: "text-gray-900", title: "全部房间数" },
    { key: "available", label: "可售", value: stats.available, accent: "text-emerald-600", title: "占用状态为可售" },
    { key: "reserved", label: "已预订", value: stats.reserved, accent: "text-amber-600", title: "占用状态为已预订" },
    { key: "occupied", label: "在住", value: stats.occupied, accent: "text-blue-600", title: "占用状态为在住" },
    { key: "blocked", label: "锁房", value: stats.blocked, accent: "text-slate-600", title: "占用状态为锁房" },
    { key: "outOfService", label: "停用", value: stats.outOfService, accent: "text-red-600", title: "占用状态为停用" },
    { key: "dirty", label: "待清扫", value: stats.dirty, accent: "text-amber-600", title: "清洁状态为待清扫" },
    { key: "cleaning", label: "清扫中", value: stats.cleaning, accent: "text-blue-600", title: "清洁状态为清扫中" },
    { key: "inspection", label: "待检查", value: stats.inspection, accent: "text-violet-600", title: "清洁状态为待检查" },
  ];

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">当前房态概览</h1>
          <p className="mt-1 text-sm text-gray-500">
            基于实时房态数据计算 · 数据更新于最近一次加载
          </p>
        </div>
        <Link
          href="/rooms"
          className="rounded-md bg-gray-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-gray-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900"
        >
          查看房态棋盘 →
        </Link>
      </div>

      {rooms.length === 0 ? (
        <p className="rounded-md border border-dashed border-gray-300 py-16 text-center text-sm text-gray-500">
          暂无房间数据，请先创建房间
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-9">
          {cards.map((card) => (
            <div
              key={card.key}
              title={card.title}
              className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm"
            >
              <p className="text-xs text-gray-500">{card.label}</p>
              <p className={`mt-1.5 text-2xl font-semibold tabular-nums ${card.accent}`}>
                {card.value}
              </p>
            </div>
          ))}
        </div>
      )}

      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
          <h2 className="text-sm font-semibold text-gray-900">占用维度</h2>
          <p className="mt-2 text-sm leading-relaxed text-gray-600">
            可售 {stats.available} · 已预订 {stats.reserved} · 在住 {stats.occupied} ·
            锁房 {stats.blocked} · 停用 {stats.outOfService}
          </p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
          <h2 className="text-sm font-semibold text-gray-900">清洁维度</h2>
          <p className="mt-2 text-sm leading-relaxed text-gray-600">
            干净 {stats.clean} · 待清扫 {stats.dirty} · 清扫中 {stats.cleaning} ·
            待检查 {stats.inspection} · 返工 {stats.rework}
          </p>
        </div>
      </div>

      <BookingOverview permissions={permissions} />
      <HousekeepingOverview permissions={permissions} />
    </div>
  );
}

/**
 * 保洁运营概览（Sprint 3）：组合既有 List API（GET /housekeeping/tasks），
 * 不新增聚合接口。无 housekeeping_task:read 不请求、不显示。
 * 显示：待清扫 / 清扫中 / 待验房 / 返工（进行中任务按状态计数）。
 */
function HousekeepingOverview({ permissions }: { permissions: Set<string> }) {
  const canRead = permissions.has("housekeeping_task:read");

  const [tasks, setTasks] = useState<import("@/lib/api/types").HousekeepingTaskOut[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!canRead) return;
    let cancelled = false;
    api.housekeeping
      .list({ page: 1, page_size: 100 })
      .then((result) => {
        if (!cancelled) setTasks(result.items);
      })
      .catch(() => {
        if (!cancelled) setLoadError("保洁任务概览加载失败");
      });
    return () => {
      cancelled = true;
    };
  }, [canRead]);

  if (!canRead) return null;

  const counts = {
    PENDING: 0,
    IN_PROGRESS: 0,
    INSPECTION: 0,
    REWORK: 0,
  };
  for (const task of tasks ?? []) {
    if (task.status in counts) counts[task.status as keyof typeof counts] += 1;
  }

  const cards = [
    { label: "待清扫", value: counts.PENDING },
    { label: "清扫中", value: counts.IN_PROGRESS },
    { label: "待验房", value: counts.INSPECTION },
    { label: "返工", value: counts.REWORK },
  ];

  return (
    <div className="mt-6">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-900">保洁运营概览</h2>
        {/* aria-label 不含「保洁」子串：与侧边导航链接的 accessible name 消歧
            （避免 getByRole('link', { name: '保洁' }) 子串匹配的 strict-mode 歧义） */}
        <Link
          href="/housekeeping"
          aria-label="打开 Housekeeping 工作台"
          className="text-xs text-gray-500 hover:underline"
        >
          进入保洁工作台 →
        </Link>
      </div>

      {loadError ? (
        <p
          role="alert"
          className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-inset ring-red-200"
        >
          {loadError}
        </p>
      ) : tasks === null ? (
        <p className="text-sm text-gray-400">正在加载保洁任务…</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {cards.map((card) => (
            <div
              key={card.label}
              className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm"
            >
              <p className="text-xs text-gray-500">{card.label}</p>
              <p className="mt-1.5 text-2xl font-semibold tabular-nums text-gray-900">
                {card.value}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 预订运营概览（S2-T2）：组合既有 List API，不新增聚合接口。
 * - reservation:read → 今日到店 / 未来 7 天预订（GET /reservations?status=CONFIRMED）
 * - stay:read → 今日离店 / 当前在住（GET /stays?status=ACTIVE）
 * - 无权限不渲染区块；PII 按 guest:read 裁剪（后端已裁剪，前端双保险）
 */
function BookingOverview({ permissions }: { permissions: Set<string> }) {
  const canReadReservation = permissions.has("reservation:read");
  const canReadStay = permissions.has("stay:read");
  const canReadGuest = permissions.has("guest:read");

  const [confirmed, setConfirmed] = useState<ReservationOut[] | null>(null);
  const [activeStays, setActiveStays] = useState<StayOut[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!canReadReservation && !canReadStay) return;
    let cancelled = false;

    const jobs: Promise<void>[] = [];
    if (canReadReservation) {
      jobs.push(
        (async () => {
          // 分页拉全 CONFIRMED（本物业规模分页有限；循环翻页不假设数据量）
          const all: ReservationOut[] = [];
          let page = 1;
          for (;;) {
            const result = await api.reservations.list({
              status: "CONFIRMED",
              page,
              page_size: 100,
            });
            all.push(...result.items);
            if (result.page * result.page_size >= result.total) break;
            page += 1;
          }
          if (!cancelled) setConfirmed(all);
        })(),
      );
    }
    if (canReadStay) {
      jobs.push(
        (async () => {
          const all: StayOut[] = [];
          let page = 1;
          for (;;) {
            const result = await api.stays.list({
              status: "ACTIVE",
              page,
              page_size: 100,
            });
            all.push(...result.items);
            if (result.page * result.page_size >= result.total) break;
            page += 1;
          }
          if (!cancelled) setActiveStays(all);
        })(),
      );
    }
    Promise.all(jobs).catch(() => {
      if (!cancelled) setLoadError("预订/在住概览加载失败");
    });
    return () => {
      cancelled = true;
    };
  }, [canReadReservation, canReadStay]);

  if (!canReadReservation && !canReadStay) return null;

  const today = businessDate();
  const horizon = addDays(today, 7);
  const arriving =
    confirmed?.filter((r) => r.check_in_date === today) ?? [];
  const nextSevenDays =
    confirmed?.filter(
      (r) => r.check_in_date >= today && r.check_in_date < horizon,
    ) ?? [];
  const departing =
    activeStays?.filter((s) => s.planned_check_out_date === today) ?? [];
  const inHouse = activeStays ?? [];

  const cards = [
    canReadReservation
      ? { label: "今日到店", value: arriving.length }
      : null,
    canReadStay ? { label: "今日离店", value: departing.length } : null,
    canReadStay ? { label: "当前在住", value: inHouse.length } : null,
    canReadReservation
      ? { label: "未来 7 天预订", value: nextSevenDays.length }
      : null,
  ].filter((c): c is { label: string; value: number } => c !== null);

  const loading = confirmed === null && activeStays === null;

  return (
    <div className="mt-6">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-900">预订运营概览</h2>
        <span className="text-xs text-gray-400">
          业务日期 {today}（Asia/Shanghai）
        </span>
      </div>

      {loadError ? (
        <p
          role="alert"
          className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-inset ring-red-200"
        >
          {loadError}
        </p>
      ) : loading ? (
        <p className="text-sm text-gray-400">正在加载预订与在住数据…</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {cards.map((card) => (
            <div
              key={card.label}
              className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm"
            >
              <p className="text-xs text-gray-500">{card.label}</p>
              <p className="mt-1.5 text-2xl font-semibold tabular-nums text-gray-900">
                {card.value}
              </p>
            </div>
          ))}
        </div>
      )}

      {!loading && !loadError ? (
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          {canReadReservation ? (
            <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
              <h3 className="text-sm font-semibold text-gray-900">今日到店</h3>
              {arriving.length === 0 ? (
                <p className="mt-2 text-sm text-gray-400">今日无到店预订</p>
              ) : (
                <ul className="mt-2 list-none space-y-1.5">
                  {arriving.slice(0, 5).map((r) => (
                    <li key={r.id} className="text-sm">
                      <Link
                        href={`/reservations/${r.id}`}
                        className="text-gray-700 hover:underline"
                      >
                        {r.reservation_no} · 房间{" "}
                        {r.room_number ?? `#${r.room_id}`}
                      </Link>
                      {canReadGuest && r.guest_name ? (
                        <span className="text-gray-500"> · {r.guest_name}</span>
                      ) : null}
                    </li>
                  ))}
                  {arriving.length > 5 ? (
                    <li className="text-xs text-gray-400">
                      还有 {arriving.length - 5} 条…
                    </li>
                  ) : null}
                </ul>
              )}
            </div>
          ) : null}
          {canReadStay ? (
            <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
              <h3 className="text-sm font-semibold text-gray-900">今日离店</h3>
              {departing.length === 0 ? (
                <p className="mt-2 text-sm text-gray-400">今日无离店入住</p>
              ) : (
                <ul className="mt-2 list-none space-y-1.5">
                  {departing.slice(0, 5).map((s) => (
                    <li key={s.id} className="text-sm">
                      <Link
                        href={`/stays/${s.id}`}
                        className="text-gray-700 hover:underline"
                      >
                        {s.stay_no} · 房间 {s.room_number ?? `#${s.room_id}`}
                      </Link>
                    </li>
                  ))}
                  {departing.length > 5 ? (
                    <li className="text-xs text-gray-400">
                      还有 {departing.length - 5} 条…
                    </li>
                  ) : null}
                </ul>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
