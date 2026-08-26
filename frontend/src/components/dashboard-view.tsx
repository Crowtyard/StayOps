"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ApiError, api } from "@/lib/api";
import type { RoomOut } from "@/lib/api/types";
import { ErrorView, Loading } from "@/components/status-views";

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
    </div>
  );
}
