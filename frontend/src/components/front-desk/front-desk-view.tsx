"use client";

/**
 * Front Desk Command Center（/front-desk，桌面端 >= 768px）：
 * 结构固定为 Today Summary / Search+Filters / Room Diary / Right-side Drawer
 * （Arrivals / Departures / Attention / Reservation / Room Quick View）。
 * - 数据：批量组合既有 List API（见 use-front-desk-data），无 N+1
 * - 写操作后 targeted refetch；轻量轮询 60s（Drawer 打开时暂停，
 *   不覆盖编辑输入、不关闭 Drawer）
 * - 响应式：<768px 渲染 FrontDeskTodayBoard，不渲染完整 Room Diary
 *   （useSyncExternalStore + matchMedia，水合安全，见 lib/media-query.ts）
 * - 最低权限 room:read + reservation:read；其余操作按各自权限显隐
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { ReservationOut, RoomOut } from "@/lib/api/types";
import { businessDate } from "@/lib/booking";
import { useMediaQuery } from "@/lib/media-query";
import {
  computeAttention,
  computeTodaySummary,
  isTimelineReservation,
  windowDays,
  windowEnd,
  type DiaryWindowKey,
} from "@/lib/front-desk";
import { useFrontDeskData } from "./use-front-desk-data";
import TodaySummary, { type SummaryKind } from "./today-summary";
import SearchBox from "./search-box";
import RoomDiary from "./room-diary";
import Drawer from "./drawer";
import FrontDeskDrawerView, {
  DRAWER_TITLES,
  type DrawerSelection,
} from "./drawer-views";
import FrontDeskTodayBoard from "./front-desk-today-board";
import { useUser } from "@/components/app-shell";
import { ErrorView, Forbidden, Loading } from "@/components/status-views";

export default function FrontDeskView() {
  const router = useRouter();
  const user = useUser();
  const permissions = useMemo(() => new Set(user?.permissions ?? []), [user]);

  // <768px：FrontDeskTodayBoard（不渲染完整 Room Diary，见 lib/media-query.ts）
  // 置于所有早期 return 之前（Rules of Hooks）
  const isMobile = useMediaQuery("(max-width: 767px)");

  const canRoom = permissions.has("room:read");
  const canReservation = permissions.has("reservation:read");
  const canStay = permissions.has("stay:read");
  const canReadGuest = permissions.has("guest:read");
  const canCreateReservation = permissions.has("reservation:write");
  const canReadHousekeeping = permissions.has("housekeeping_task:read");

  const today = useMemo(() => businessDate(), []);
  const [reloadKey, setReloadKey] = useState(0);
  const [windowKey, setWindowKey] = useState<DiaryWindowKey>("7");
  const days = windowDays(windowKey);
  const winEndDate = windowEnd(today, days);

  const bundle = useFrontDeskData(
    permissions,
    reloadKey,
    today,
    winEndDate,
  );

  const [selection, setSelection] = useState<DrawerSelection | null>(null);
  const [floorFilter, setFloorFilter] = useState<"all" | number>("all");
  const [roomTypeFilter, setRoomTypeFilter] = useState<"all" | number>("all");
  const [focus, setFocus] = useState<{ date: string | null; token: number }>({
    date: null,
    token: 0,
  });

  // 401 → 登录失效跳转
  useEffect(() => {
    if (bundle.error?.kind === "unauthorized") {
      router.replace("/login");
    }
  }, [bundle.error, router]);

  const triggerReload = useCallback(() => {
    setReloadKey((k) => k + 1);
  }, []);

  // 轻量轮询（60s）：Drawer 打开时暂停；页面隐藏时跳过；不覆盖用户输入
  useEffect(() => {
    if (selection !== null) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") {
        setReloadKey((k) => k + 1);
      }
    }, 60_000);
    return () => clearInterval(timer);
  }, [selection]);

  const rooms = useMemo(() => bundle.rooms ?? [], [bundle.rooms]);
  const reservations = useMemo(
    () => bundle.reservations ?? [],
    [bundle.reservations],
  );
  const stays = useMemo(() => bundle.stays ?? [], [bundle.stays]);
  const tasks = useMemo(() => bundle.tasks ?? [], [bundle.tasks]);

  const timelineReservations = useMemo(
    () => reservations.filter(isTimelineReservation),
    [reservations],
  );
  const summary = useMemo(
    () => computeTodaySummary(rooms, reservations, stays, today),
    [rooms, reservations, stays, today],
  );
  const attention = useMemo(
    () =>
      computeAttention(
        reservations,
        stays,
        rooms,
        today,
        bundle.workOrders,
      ),
    [reservations, stays, rooms, today, bundle.workOrders],
  );
  const activeTaskRoomIds = useMemo(() => {
    const set = new Set<number>();
    for (const t of tasks) {
      if (
        t.status === "PENDING" ||
        t.status === "IN_PROGRESS" ||
        t.status === "INSPECTION" ||
        t.status === "REWORK"
      ) {
        set.add(t.room_id);
      }
    }
    return set;
  }, [tasks]);

  const floors = useMemo(
    () => [...new Set(rooms.map((r) => r.floor))].sort((a, b) => a - b),
    [rooms],
  );
  const roomTypes = useMemo(() => {
    const map = new Map<number, string>();
    for (const r of rooms) {
      if (r.room_type && !map.has(r.room_type_id)) {
        map.set(r.room_type_id, r.room_type.name);
      }
    }
    return [...map.entries()].map(([id, name]) => ({ id, name }));
  }, [rooms]);

  const filteredRooms = useMemo(
    () =>
      rooms.filter(
        (r) =>
          (floorFilter === "all" || r.floor === floorFilter) &&
          (roomTypeFilter === "all" || r.room_type_id === roomTypeFilter),
      ),
    [rooms, floorFilter, roomTypeFilter],
  );

  const openReservation = useCallback(
    (res: ReservationOut) => {
      setSelection({ kind: "reservation", reservationId: res.id });
      // 定位日期：预订与当前窗口重叠时横向滚动到入住日列
      const offsetStart = res.check_in_date;
      if (offsetStart >= today && offsetStart < winEndDate) {
        setFocus((f) => ({ date: offsetStart, token: f.token + 1 }));
      }
    },
    [today, winEndDate],
  );

  const openRoom = useCallback((room: RoomOut) => {
    setSelection({ kind: "room", roomId: room.id });
  }, []);

  const openSummary = useCallback((kind: SummaryKind) => {
    switch (kind) {
      case "arrivals":
        setSelection({ kind: "arrivals" });
        break;
      case "departures":
        setSelection({ kind: "departures" });
        break;
      case "inhouse":
        setSelection({ kind: "inhouse" });
        break;
      case "vacantClean":
        setSelection({ kind: "vacant-clean" });
        break;
      case "attention":
        setSelection({ kind: "attention" });
        break;
    }
  }, []);

  if (!canRoom || !canReservation) {
    return <Forbidden text="无权限访问前台工作台（需要 room:read 与 reservation:read）" />;
  }

  if (bundle.forbidden) {
    return <Forbidden text="无权限访问前台工作台" />;
  }
  if (bundle.error) {
    return (
      <ErrorView
        message={bundle.error.message}
        offline={bundle.error.kind === "network"}
        onRetry={triggerReload}
      />
    );
  }
  if (!bundle.ready) {
    return <Loading text="正在加载前台工作台数据…" />;
  }

  const summaryCounts = {
    arrivals: summary.arrivals.length,
    departures: summary.departures.length,
    inhouse: summary.inHouse.length,
    vacantClean: summary.vacantClean.length,
    attention: attention.length,
  };

  const drawerTitle = selection ? DRAWER_TITLES[selection.kind] : "";

  return (
    <div>
      {!isMobile ? (
        /* 桌面端（>= 768px）：完整 Command Center + Room Diary */
        <div>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <div>
              <h1 className="text-xl font-semibold text-gray-900">前台指挥台</h1>
              <p className="mt-0.5 text-xs text-gray-500">
                业务日期 {today}（Asia/Shanghai）· 共 {rooms.length} 间房
              </p>
            </div>
            <div className="ml-auto">
              <SearchBox
                rooms={rooms}
                canReadGuest={canReadGuest}
                canSearchReservations={canReservation}
                onOpenRoom={openRoom}
                onOpenReservation={openReservation}
              />
            </div>
          </div>

          <div className="mb-4">
            <TodaySummary
              counts={summaryCounts}
              showStayCards={canStay}
              onSelect={openSummary}
            />
          </div>

          <RoomDiary
            rooms={filteredRooms}
            reservations={timelineReservations}
            stays={stays}
            activeTaskRoomIds={canReadHousekeeping ? activeTaskRoomIds : new Set()}
            winStart={today}
            days={days}
            windowKey={windowKey}
            onWindowChange={setWindowKey}
            floors={floors}
            roomTypes={roomTypes}
            floorFilter={floorFilter}
            roomTypeFilter={roomTypeFilter}
            onFloorChange={setFloorFilter}
            onRoomTypeChange={setRoomTypeFilter}
            canReadGuest={canReadGuest}
            canCreateReservation={canCreateReservation}
            focusDate={focus.date}
            focusToken={focus.token}
            onOpenReservation={openReservation}
            onOpenRoom={openRoom}
          />
        </div>
      ) : (
        /* 移动端（<768px）：FrontDeskTodayBoard，不渲染完整 Room Diary */
        <FrontDeskTodayBoard
          rooms={rooms}
          reservations={reservations}
          stays={stays}
          attention={attention}
          summary={summary}
          permissions={permissions}
          today={today}
          canReadGuest={canReadGuest}
          onOpenReservation={openReservation}
          onOpenRoom={openRoom}
          onSelectSummary={openSummary}
          onOpenStayMove={(stayId) =>
            setSelection({ kind: "stay-move", stayId })
          }
        />
      )}

      <Drawer
        open={selection !== null}
        title={drawerTitle}
        onClose={() => setSelection(null)}
      >
        {selection ? (
          <FrontDeskDrawerView
            selection={selection}
            bundle={bundle}
            permissions={permissions}
            today={today}
            onChanged={triggerReload}
            onSelect={setSelection}
          />
        ) : null}
      </Drawer>
    </div>
  );
}
