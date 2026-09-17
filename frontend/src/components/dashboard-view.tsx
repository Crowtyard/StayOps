"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ApiError, api } from "@/lib/api";
import type {
  DailyRoomStatus,
  ReservationOut,
  RoomStatusItemOut,
  RoomStatusOut,
  StayOut,
} from "@/lib/api/types";
import { addDays, businessDate } from "@/lib/booking";
import {
  DAILY_ROOM_STATUS_META,
} from "@/lib/channels";
import { ErrorView, Loading } from "@/components/status-views";
import { useUser } from "@/components/app-shell";

/**
 * 首页房态概览（alpha.9.6 F2：按日期显示）。
 *
 * 核心语义（后端权威，见 app/services/room_status.py）：
 * - 展示的是**所选日期的房态**（可售 / 已预订 / 在住 / 维修停用），
 *   不是 rooms.occupancy_status 的当前值。
 * - 未来日期 physical_status_authoritative=false：物理房态不具权威性，
 *   页面必须显式提示，禁止把当前房态冒充未来房态。
 * - 「预计到店」在到店日为 RESERVED 且 arriving=true，绝不谎报成「在住」。
 * - 清洁维度只在业务日期当天有意义，其它日期不显示（不推断未来 CLEANING）。
 */

interface StatusCard {
  key: DailyRoomStatus | "enabled" | "disabled";
  label: string;
  value: number;
  accent: string;
  title: string;
}

export default function DashboardView() {
  const router = useRouter();
  const user = useUser();
  const permissions = useMemo(() => new Set(user?.permissions ?? []), [user]);
  const today = businessDate();
  const [selectedDate, setSelectedDate] = useState<string>(today);
  // 按请求键缓存（key = 查询日期），避免在 effect 内同步 setState 造成级联渲染
  const [fetched, setFetched] = useState<{
    key: string;
    data: RoomStatusOut;
  } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [drill, setDrill] = useState<DailyRoomStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.dashboard
      .roomStatus({ date: selectedDate })
      .then((data) => {
        if (!cancelled) setFetched({ key: selectedDate, data });
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
  }, [router, selectedDate, reloadKey]);

  const retry = useCallback(() => {
    setError(null);
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

  const status = fetched?.key === selectedDate ? fetched.data : null;

  const counts = status?.counts;
  const cards: StatusCard[] = [
    {
      key: "enabled",
      label: "启用房间",
      value: status?.enabled_room_count ?? 0,
      accent: "text-gray-900",
      title: "投入经营的房间数（停用房间不计入）",
    },
    {
      key: "AVAILABLE",
      label: "可售",
      value: counts?.available ?? 0,
      accent: "text-emerald-600",
      title: `${selectedDate} 当日可售房间`,
    },
    {
      key: "RESERVED",
      label: "已预订",
      value: counts?.reserved ?? 0,
      accent: "text-amber-600",
      title: `${selectedDate} 当日已确认预订（尚未入住）`,
    },
    {
      key: "OCCUPIED",
      label: "在住",
      value: counts?.occupied ?? 0,
      accent: "text-blue-600",
      title: `${selectedDate} 当日在住房间`,
    },
    {
      key: "OUT_OF_SERVICE",
      label: "维修停用",
      value: counts?.out_of_service ?? 0,
      accent: "text-red-600",
      title: "维修 / 锁房 / 停用（含长期停用）",
    },
    {
      key: "disabled",
      label: "停用房间",
      value: status?.disabled_room_count ?? 0,
      accent: "text-gray-400",
      title: "已停用房间（不参与可售与分母）",
    },
  ];

  const drilled: RoomStatusItemOut[] =
    drill === null
      ? []
      : (status?.rooms ?? []).filter((r) => r.status === drill && r.is_active);

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">
            房态概览 · {selectedDate}
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            {status?.is_today
              ? "业务日期当天：物理房态与当日占用一致"
              : status?.is_past
                ? "历史日期：按当时已落库的物理状态与占用事实显示"
                : "未来日期：物理房态仅供参考，以预订占用为准"}
          </p>
        </div>
        <Link
          href="/rooms"
          className="rounded-md bg-gray-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-gray-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900"
        >
          查看房态棋盘 →
        </Link>
      </div>

      {/* 日期选择（前一天 / 日期 / 后一天 / 今天 / 日期选择器） */}
      <div className="mb-5 flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
        <button
          type="button"
          aria-label="前一天"
          onClick={() => setSelectedDate((d) => addDays(d, -1))}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
        >
          ‹
        </button>
        <input
          type="date"
          aria-label="房态日期"
          value={selectedDate}
          onChange={(e) => {
            if (e.target.value) setSelectedDate(e.target.value);
          }}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
        />
        <button
          type="button"
          aria-label="后一天"
          onClick={() => setSelectedDate((d) => addDays(d, 1))}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
        >
          ›
        </button>
        <button
          type="button"
          onClick={() => setSelectedDate(today)}
          disabled={selectedDate === today}
          className="rounded-md bg-gray-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-40"
        >
          今天
        </button>
        {status && !status.physical_status_authoritative ? (
          <span className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700 ring-1 ring-inset ring-amber-200">
            未来日期：不显示当前物理/清洁状态，仅显示预订占用
          </span>
        ) : null}
      </div>

      {!status || !counts ? (
        <Loading text="正在加载房态数据…" />
      ) : status.rooms.length === 0 ? (
        <p className="rounded-md border border-dashed border-gray-300 py-16 text-center text-sm text-gray-500">
          暂无房间数据，请先创建房间
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {cards.map((card) => {
              const clickable =
                card.key !== "enabled" && card.key !== "disabled" && card.value > 0;
              const active = drill === card.key;
              return (
                <button
                  key={card.key}
                  type="button"
                  title={card.title}
                  disabled={!clickable}
                  onClick={() =>
                    setDrill((prev) =>
                      prev === (card.key as DailyRoomStatus)
                        ? null
                        : (card.key as DailyRoomStatus),
                    )
                  }
                  className={`rounded-lg border bg-white p-4 text-left shadow-sm ${
                    active ? "border-gray-900 ring-1 ring-gray-900" : "border-gray-200"
                  } ${clickable ? "hover:border-gray-400" : "cursor-default"}`}
                >
                  <p className="text-xs text-gray-500">{card.label}</p>
                  <p
                    className={`mt-1.5 text-2xl font-semibold tabular-nums ${card.accent}`}
                  >
                    {card.value}
                  </p>
                  {clickable ? (
                    <p className="mt-1 text-[11px] text-gray-400">
                      {active ? "收起房间列表" : "点击查看房间 →"}
                    </p>
                  ) : null}
                </button>
              );
            })}
          </div>

          {/* 点击分类钻取：对应房间列表 */}
          {drill !== null ? (
            <div className="mt-4 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-gray-900">
                  {DAILY_ROOM_STATUS_META[drill].label}（{drilled.length} 间）
                </h2>
                <button
                  type="button"
                  onClick={() => setDrill(null)}
                  className="text-xs text-gray-500 hover:underline"
                >
                  收起
                </button>
              </div>
              {drilled.length === 0 ? (
                <p className="text-sm text-gray-400">该分类下暂无房间</p>
              ) : (
                <ul className="flex list-none flex-wrap gap-2">
                  {drilled.map((room) => (
                    <li key={room.room_id}>
                      <Link
                        href={`/rooms/${room.room_id}`}
                        className="inline-flex items-center gap-2 rounded-md border border-gray-200 px-2.5 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
                      >
                        <span className="font-medium">{room.room_number}</span>
                        {room.room_name ? (
                          <span className="text-xs text-gray-500">
                            {room.room_name}
                          </span>
                        ) : null}
                        {room.arriving ? (
                          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800">
                            今日到店
                          </span>
                        ) : null}
                        {room.unavailability_source === "MAINTENANCE" ? (
                          <span className="rounded bg-red-50 px-1.5 py-0.5 text-[11px] text-red-700">
                            维修
                          </span>
                        ) : null}
                        {room.status === "OCCUPIED" && room.stay_no ? (
                          <span className="text-[11px] text-gray-400">
                            {room.stay_no}
                          </span>
                        ) : null}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
              <h2 className="text-sm font-semibold text-gray-900">
                {selectedDate} 占用维度
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-gray-600">
                可售 {counts.available} · 已预订 {counts.reserved} · 在住{" "}
                {counts.occupied} · 维修停用 {counts.out_of_service}
              </p>
              <p className="mt-1 text-xs text-gray-400">
                合计 {counts.total_enabled_rooms} 间（启用房间）= 总数{" "}
                {status.total_room_count} − 停用 {status.disabled_room_count}
              </p>
            </div>
            <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
              <h2 className="text-sm font-semibold text-gray-900">清洁维度</h2>
              {status.is_today ? (
                <p className="mt-2 text-sm leading-relaxed text-gray-600">
                  {cleanSummary(status.rooms)}
                </p>
              ) : (
                <p className="mt-2 text-sm text-gray-400">
                  清洁状态仅表示当天实况，历史 / 未来日期不推断
                </p>
              )}
            </div>
          </div>
        </>
      )}

      <BookingOverview permissions={permissions} />
      <HousekeepingOverview permissions={permissions} />
      <InventoryAlertsOverview permissions={permissions} />
    </div>
  );
}

/** 当日清洁维度汇总（仅在业务日期当天有意义）。 */
function cleanSummary(rooms: RoomStatusItemOut[]): string {
  const order: { key: string; label: string }[] = [
    { key: "clean", label: "干净" },
    { key: "dirty", label: "待清扫" },
    { key: "cleaning", label: "清扫中" },
    { key: "inspection", label: "待检查" },
    { key: "rework", label: "返工" },
  ];
  const counts: Record<string, number> = {};
  for (const room of rooms) {
    const key = room.current_cleaning_status;
    if (key) counts[key] = (counts[key] ?? 0) + 1;
  }
  return order.map((o) => `${o.label} ${counts[o.key] ?? 0}`).join(" · ");
}

/**
 * 库存预警概览（Sprint 7 §45，轻量）：低库存数 / 缺货数（inventory:read）+
 * 待审批申请数 / 待收货订单数（procurement:read）。
 * 无对应权限不请求、不显示（不产生无权限错误）；不做 S8 Analytics 图表。
 */
function InventoryAlertsOverview({ permissions }: { permissions: Set<string> }) {
  const canReadInventory = permissions.has("inventory:read");
  const canReadProcurement = permissions.has("procurement:read");

  const [stockCounts, setStockCounts] = useState<{
    low: number;
    out: number;
  } | null>(null);
  const [procurementCounts, setProcurementCounts] = useState<{
    pendingApproval: number;
    pendingReceipt: number;
  } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!canReadInventory && !canReadProcurement) return;
    let cancelled = false;
    const jobs: Promise<void>[] = [];

    if (canReadInventory) {
      jobs.push(
        (async () => {
          const all: import("@/lib/api/types").InventoryItemListRow[] = [];
          let page = 1;
          for (;;) {
            const result = await api.inventory.listItems({
              page,
              page_size: 100,
            });
            all.push(...result.items);
            if (result.page * result.page_size >= result.total) break;
            page += 1;
          }
          if (!cancelled) {
            setStockCounts({
              low: all.filter((i) => i.stock_status === "LOW_STOCK").length,
              out: all.filter((i) => i.stock_status === "OUT_OF_STOCK").length,
            });
          }
        })(),
      );
    }
    if (canReadProcurement) {
      jobs.push(
        (async () => {
          const submitted = await api.procurement.listRequests({
            status: "SUBMITTED",
            page: 1,
            page_size: 100,
          });
          if (cancelled) return;
          const ordered = await api.procurement.listOrders({
            status: "ORDERED",
            page: 1,
            page_size: 100,
          });
          if (cancelled) return;
          const partial = await api.procurement.listOrders({
            status: "PARTIALLY_RECEIVED",
            page: 1,
            page_size: 100,
          });
          if (!cancelled) {
            setProcurementCounts({
              pendingApproval: submitted.total,
              pendingReceipt: ordered.total + partial.total,
            });
          }
        })(),
      );
    }
    Promise.all(jobs).catch(() => {
      if (!cancelled) setLoadError("库存/采购预警加载失败");
    });
    return () => {
      cancelled = true;
    };
  }, [canReadInventory, canReadProcurement]);

  if (!canReadInventory && !canReadProcurement) return null;

  const cards: { label: string; value: number | null; accent: string }[] = [];
  if (canReadInventory) {
    cards.push({
      label: "低库存",
      value: stockCounts?.low ?? null,
      accent: "text-amber-600",
    });
    cards.push({
      label: "缺货",
      value: stockCounts?.out ?? null,
      accent: "text-red-600",
    });
  }
  if (canReadProcurement) {
    cards.push({
      label: "待审批申请",
      value: procurementCounts?.pendingApproval ?? null,
      accent: "text-gray-900",
    });
    cards.push({
      label: "待收货订单",
      value: procurementCounts?.pendingReceipt ?? null,
      accent: "text-gray-900",
    });
  }

  return (
    <div className="mt-6">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-900">库存与采购预警</h2>
        <span className="flex gap-3 text-xs text-gray-500">
          {canReadInventory ? (
            <Link href="/inventory" className="hover:underline">
              库存 →
            </Link>
          ) : null}
          {canReadProcurement ? (
            <Link href="/procurement" className="hover:underline">
              采购 →
            </Link>
          ) : null}
        </span>
      </div>

      {loadError ? (
        <p
          role="alert"
          className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-inset ring-red-200"
        >
          {loadError}
        </p>
      ) : cards.every((c) => c.value === null) ? (
        <p className="text-sm text-gray-400">正在加载库存与采购数据…</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {cards.map((card) => (
            <div
              key={card.label}
              className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm"
            >
              <p className="text-xs text-gray-500">{card.label}</p>
              <p
                className={`mt-1.5 text-2xl font-semibold tabular-nums ${card.accent}`}
              >
                {card.value ?? "…"}
              </p>
            </div>
          ))}
        </div>
      )}
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
