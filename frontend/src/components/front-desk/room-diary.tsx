"use client";

/**
 * Room Diary：28 间房 × 未来 1/7/14/30 天时间线（Room Diary 为页面主体）。
 * - 时间语义严格 [check_in_date, check_out_date)：只覆盖入住日晚至退房日前一晚，
 *   退房日可接下一笔预订；日期宽度、跨日长度、首尾相邻必须准确（无 off-by-one）
 * - 房间按楼层分组；左侧房间栏固定（sticky）；日期区域允许横向滚动（键盘可聚焦）
 * - 房间双状态必须同时体现（occupancy + cleaning，不合并成单状态）
 * - CANCELLED / NO_SHOW 不作为占用条；COMPLETED 不作未来主条（TIMELINE_STATUSES）
 * - 点击空白日期格：新建预订（预填复用 /reservations/new）或查看房间
 * - 预订条点击：打开 Reservation Drawer（由上层回调）
 */

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { ReservationOut, RoomOut, StayOut } from "@/lib/api/types";
import {
  DAY_CELL_WIDTH,
  RESERVATION_BAR_CLASS,
  STAY_BAR_CLASS,
  barPlacement,
  isTimelineReservation,
  quickCreateHref,
  reservationBarText,
  reservationBarTitle,
  shortDateLabel,
  stayBarText,
  stayBarTitle,
  stayCheckInDate,
  weekdayLabel,
  windowDates,
  type DiaryWindowKey,
} from "@/lib/front-desk";
import { DIARY_WINDOWS } from "@/lib/front-desk";
import { addDays } from "@/lib/booking";
import { reservationChannelLabel } from "@/lib/channels";
import { CleaningBadge, OccupancyBadge } from "@/components/status-badge";
import { IconCleaning } from "@/components/icons";
import { inputClass } from "@/components/booking/shared";

const ROOM_COL_WIDTH = 176;
const TRACK_HEIGHT = 40;

export interface RoomDiaryProps {
  rooms: RoomOut[];
  reservations: ReservationOut[];
  /** Sprint 6 §24：ACTIVE Stay = 当前实际占用（按 stay.room_id 渲染）。 */
  stays: StayOut[];
  /** 有进行中保洁任务的房间 id（housekeeping_task:read 时提供）。 */
  activeTaskRoomIds: Set<number>;
  winStart: string;
  days: number;
  windowKey: DiaryWindowKey;
  onWindowChange: (key: DiaryWindowKey) => void;
  floors: number[];
  roomTypes: { id: number; name: string }[];
  floorFilter: "all" | number;
  roomTypeFilter: "all" | number;
  onFloorChange: (v: "all" | number) => void;
  onRoomTypeChange: (v: "all" | number) => void;
  canReadGuest: boolean;
  canCreateReservation: boolean;
  /** 定位日期（搜索结果落地）：token 变化触发横向滚动。 */
  focusDate: string | null;
  focusToken: number;
  onOpenReservation: (reservation: ReservationOut) => void;
  onOpenRoom: (room: RoomOut) => void;
}

interface QuickMenuState {
  room: RoomOut;
  date: string;
  x: number;
  y: number;
}

export default function RoomDiary({
  rooms,
  reservations,
  stays,
  activeTaskRoomIds,
  winStart,
  days,
  windowKey,
  onWindowChange,
  floors,
  roomTypes,
  floorFilter,
  roomTypeFilter,
  onFloorChange,
  onRoomTypeChange,
  canReadGuest,
  canCreateReservation,
  focusDate,
  focusToken,
  onOpenReservation,
  onOpenRoom,
}: RoomDiaryProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [menu, setMenu] = useState<QuickMenuState | null>(null);

  const dates = useMemo(() => windowDates(winStart, days), [winStart, days]);
  const today = winStart; // 窗口始终从业务日期今天开始

  const byRoom = useMemo(() => {
    const map = new Map<number, ReservationOut[]>();
    for (const r of reservations) {
      if (!isTimelineReservation(r)) continue;
      const list = map.get(r.room_id);
      if (list) list.push(r);
      else map.set(r.room_id, [r]);
    }
    for (const list of map.values()) {
      list.sort((a, b) =>
        a.check_in_date === b.check_in_date
          ? a.id - b.id
          : a.check_in_date.localeCompare(b.check_in_date),
      );
    }
    return map;
  }, [reservations]);

  // Sprint 6 §24：ACTIVE Stay = 当前实际占用，按 stay.room_id（当前实际房间）
  // 渲染 [actual check-in 日, planned_check_out_date)；换房后旧房不画占用条。
  const staysByRoom = useMemo(() => {
    const map = new Map<number, StayOut[]>();
    for (const stay of stays) {
      if (stay.status !== "ACTIVE") continue;
      const list = map.get(stay.room_id);
      if (list) list.push(stay);
      else map.set(stay.room_id, [stay]);
    }
    return map;
  }, [stays]);

  const floorGroups = useMemo(() => {
    return floors.map((floor) => ({
      floor,
      rooms: rooms
        .filter((r) => r.floor === floor)
        .sort((a, b) => a.room_number.localeCompare(b.room_number, "zh-CN")),
    }));
  }, [rooms, floors]);

  // 定位日期：搜索结果点击后横向滚动到对应列
  useEffect(() => {
    if (!focusDate || focusToken === 0 || !scrollRef.current) return;
    const offset = barPlacement(focusDate, addDays(focusDate, 1), winStart, days);
    if (!offset) return;
    const el = scrollRef.current;
    const left = Math.max(0, offset.left - DAY_CELL_WIDTH);
    if (typeof el.scrollTo === "function") {
      el.scrollTo({ left, behavior: "smooth" });
    } else {
      el.scrollLeft = left; // jsdom / 旧环境回退
    }
  }, [focusDate, focusToken, winStart, days]);

  function handleTrackClick(room: RoomOut) {
    return (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      if (target.closest("[data-reservation-bar], [data-stay-bar]")) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const idx = Math.floor((e.clientX - rect.left) / DAY_CELL_WIDTH);
      if (idx < 0 || idx >= days) return;
      const date = dates[idx];
      setMenu({ room, date, x: e.clientX, y: e.clientY });
    };
  }

  return (
    <section aria-label="房态日历">
      {/* 窗口 + 筛选 */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div
          role="group"
          aria-label="时间范围"
          className="flex rounded-md border border-gray-300 bg-white p-0.5"
        >
          {DIARY_WINDOWS.map((w) => (
            <button
              key={w.key}
              type="button"
              aria-pressed={windowKey === w.key}
              onClick={() => onWindowChange(w.key)}
              className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                windowKey === w.key
                  ? "bg-gray-900 text-white"
                  : "text-gray-600 hover:bg-gray-100"
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
        <select
          aria-label="按楼层筛选"
          value={floorFilter === "all" ? "all" : String(floorFilter)}
          onChange={(e) =>
            onFloorChange(
              e.target.value === "all" ? "all" : Number(e.target.value),
            )
          }
          className={`${inputClass} w-auto`}
        >
          <option value="all">全部楼层</option>
          {floors.map((f) => (
            <option key={f} value={f}>
              {f} 层
            </option>
          ))}
        </select>
        <select
          aria-label="按房型筛选"
          value={roomTypeFilter === "all" ? "all" : String(roomTypeFilter)}
          onChange={(e) =>
            onRoomTypeChange(
              e.target.value === "all" ? "all" : Number(e.target.value),
            )
          }
          className={`${inputClass} w-auto`}
        >
          <option value="all">全部房型</option>
          {roomTypes.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <span className="ml-auto text-xs text-gray-400">
          日期区域可横向滚动 →
        </span>
      </div>

      {/* 时间线（横向滚动 + 键盘可聚焦） */}
      <div
        ref={scrollRef}
        tabIndex={0}
        role="region"
        aria-label="房态日历（可横向滚动）"
        className="overflow-x-auto rounded-lg border border-gray-200 bg-white"
      >
        <div
          className="grid"
          style={{
            gridTemplateColumns: `${ROOM_COL_WIDTH}px repeat(${days}, ${DAY_CELL_WIDTH}px)`,
          }}
        >
          {/* 日列表头（sticky top；角格 sticky left+top） */}
          <div className="sticky left-0 top-0 z-30 flex items-center border-b border-r border-gray-200 bg-gray-50 px-3 py-2">
            <span className="text-xs font-medium text-gray-500">
              房间 / 占用 · 清洁
            </span>
          </div>
          {dates.map((d) => (
            <div
              key={d}
              data-day-header={d}
              aria-current={d === today ? "date" : undefined}
              className={`sticky top-0 z-20 border-b border-r border-gray-200 px-1 py-1.5 text-center ${
                d === today ? "bg-blue-50" : "bg-gray-50"
              }`}
            >
              <p
                className={`max-lg:hidden text-[11px] leading-tight ${
                  d === today ? "font-semibold text-blue-700" : "text-gray-500"
                }`}
              >
                周{weekdayLabel(d)}
              </p>
              <p
                className={`text-[11px] leading-tight tabular-nums ${
                  d === today ? "font-semibold text-blue-700" : "text-gray-600"
                }`}
              >
                {shortDateLabel(d)}
              </p>
            </div>
          ))}

          {/* 按楼层分组 */}
          {floorGroups.map((group) => (
            <Fragment key={group.floor}>
              <div className="col-span-full border-b border-gray-200 bg-gray-100/70 py-0.5">
                <span className="sticky left-0 inline-block bg-inherit px-3 text-xs font-semibold text-gray-600">
                  {group.floor} 层
                </span>
              </div>
              {group.rooms.map((room) => {
                const bars = (byRoom.get(room.id) ?? []).map((res) => ({
                  res,
                  placement: barPlacement(
                    res.check_in_date,
                    res.check_out_date,
                    winStart,
                    days,
                  ),
                }));
                // Sprint 6 §24：ACTIVE Stay 占用条（[ci, planned_check_out)）
                const stayBars = (staysByRoom.get(room.id) ?? [])
                  .map((stay) => ({
                    stay,
                    placement: barPlacement(
                      stayCheckInDate(stay) ?? winStart,
                      stay.planned_check_out_date,
                      winStart,
                      days,
                    ),
                  }))
                  .filter(
                    (
                      item,
                    ): item is {
                      stay: StayOut;
                      placement: NonNullable<ReturnType<typeof barPlacement>>;
                    } => item.placement !== null,
                  );
                const hasTask = activeTaskRoomIds.has(room.id);
                return (
                  <Fragment key={room.id}>
                    {/* 房间栏（sticky left，双状态必须同时体现） */}
                    <div
                      data-room-cell={room.room_number}
                      className="sticky left-0 z-10 flex items-center border-b border-r border-gray-200 bg-white px-3 py-1.5"
                    >
                      <button
                        type="button"
                        onClick={() => onOpenRoom(room)}
                        title={`查看房间 ${room.room_number}`}
                        className="w-full min-w-0 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900"
                      >
                        <span className="flex items-center gap-1.5">
                          <span className="text-sm font-semibold text-gray-900">
                            {room.room_number}
                          </span>
                          {hasTask ? (
                            <span
                              title="保洁任务进行中"
                              className="flex items-center text-amber-600"
                            >
                              <IconCleaning className="size-3.5" />
                            </span>
                          ) : null}
                        </span>
                        <span className="block max-lg:hidden truncate text-[11px] text-gray-500">
                          {room.room_type?.name ?? `房型 #${room.room_type_id}`}
                        </span>
                        <span className="mt-0.5 flex flex-wrap gap-1">
                          <OccupancyBadge status={room.occupancy_status} />
                          <CleaningBadge status={room.cleaning_status} />
                        </span>
                      </button>
                    </div>

                    {/* 时间线轨道（点击空白格 → 快速新建 / 查看房间） */}
                    <div
                      data-room-track={room.room_number}
                      onClick={handleTrackClick(room)}
                      className="relative cursor-pointer border-b border-r border-gray-100 hover:bg-blue-50/40"
                      style={{
                        gridColumn: "2 / -1",
                        height: TRACK_HEIGHT,
                        backgroundImage:
                          days > 1
                            ? `linear-gradient(to right, rgba(17,24,39,0.07) 1px, transparent 1px)`
                            : "none",
                        backgroundSize: `${DAY_CELL_WIDTH}px 100%`,
                      }}
                    >
                      {/* 今日列底色（窗口始终从业务日期今天开始 → 首列） */}
                      <div
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-y-0 left-0 bg-blue-50"
                        style={{ width: DAY_CELL_WIDTH }}
                      />
                      {bars.map(({ res, placement }) =>
                        placement === null ? null : (
                          <button
                            key={res.id}
                            type="button"
                            data-reservation-bar={res.reservation_no}
                            aria-label={reservationBarTitle(res, canReadGuest)}
                            title={reservationBarTitle(res, canReadGuest)}
                            onClick={(e) => {
                              e.stopPropagation();
                              onOpenReservation(res);
                            }}
                            className={`absolute inset-y-1 overflow-hidden rounded-sm px-1.5 text-left ring-1 ring-white/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white ${
                              RESERVATION_BAR_CLASS[res.status] ??
                              "bg-gray-400 text-white"
                            }`}
                            style={{ left: placement.left, width: placement.width }}
                          >
                            <span className="block truncate text-[11px] font-semibold leading-tight">
                              {reservationBarText(res, canReadGuest)}
                            </span>
                            {placement.width >= 130 ? (
                              <span className="block truncate text-[10px] leading-tight opacity-90">
                                {res.status} ·{" "}
                                {reservationChannelLabel(res.source_channel, res.source)}
                              </span>
                            ) : null}
                          </button>
                        ),
                      )}
                      {/* Sprint 6 §24：当前实际占用 = ACTIVE Stay（换房后画在新房） */}
                      {stayBars.map(({ stay, placement }) => (
                        <Link
                          key={stay.id}
                          href={`/stays/${stay.id}`}
                          data-stay-bar={stay.stay_no}
                          aria-label={stayBarTitle(stay, canReadGuest)}
                          title={stayBarTitle(stay, canReadGuest)}
                          onClick={(e) => e.stopPropagation()}
                          className={`${STAY_BAR_CLASS} absolute inset-y-1 overflow-hidden rounded-sm px-1.5 text-left ring-1 ring-white/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white`}
                          style={{ left: placement.left, width: placement.width }}
                        >
                          <span className="block truncate text-[11px] font-semibold leading-tight">
                            {stayBarText(stay, canReadGuest)}
                          </span>
                          {placement.width >= 130 ? (
                            <span className="block truncate text-[10px] leading-tight opacity-90">
                              在住 · 计划离店 {stay.planned_check_out_date}
                            </span>
                          ) : null}
                        </Link>
                      ))}
                    </div>
                  </Fragment>
                );
              })}
            </Fragment>
          ))}
        </div>
      </div>

      {/* 空白日期格快捷菜单（不离开 /front-desk；新建预订复用现有表单） */}
      {menu ? (
        <>
          <button
            type="button"
            aria-label="关闭快捷菜单"
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setMenu(null)}
            tabIndex={-1}
          />
          <div
            role="menu"
            aria-label={`房间 ${menu.room.room_number} · ${menu.date}`}
            className="fixed z-50 w-44 rounded-md border border-gray-200 bg-white py-1 shadow-lg"
            style={{ left: menu.x, top: menu.y }}
          >
            <p className="px-3 py-1 text-xs text-gray-400">
              房间 {menu.room.room_number} · {menu.date}
            </p>
            {canCreateReservation ? (
              <Link
                href={quickCreateHref(
                  menu.room.id,
                  menu.room.room_type_id,
                  menu.date,
                )}
                role="menuitem"
                className="block px-3 py-2 text-sm text-gray-800 hover:bg-gray-50"
              >
                新建预订
              </Link>
            ) : null}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const room = menu.room;
                setMenu(null);
                onOpenRoom(room);
              }}
              className="block w-full px-3 py-2 text-left text-sm text-gray-800 hover:bg-gray-50"
            >
              查看房间
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}
