"use client";

/**
 * FrontDeskTodayBoard（<768px，不渲染完整 Room Diary）：
 * Today Summary → Search → Attention → Today's Arrivals → Today's Departures
 * → Current Stays。
 * 手机主要完成：查客人 / 查房间 / Check-in / Check-out / 查看 Reservation /
 * 查看 Housekeeping 状态；不要求手机完成复杂排房。
 * PII 与权限边界与桌面端一致（guest:read / stay:read 门控）。
 */

import type {
  ReservationOut,
  RoomOut,
  StayOut,
} from "@/lib/api/types";
import {
  RESERVATION_STATUS_META,
  SOURCE_LABELS,
} from "@/lib/booking";
import {
  attentionRuleLabel,
  type AttentionItem,
  type TodaySummary as TodaySummaryData,
} from "@/lib/front-desk";
import TodaySummary, { type SummaryKind } from "./today-summary";
import SearchBox from "./search-box";
import { StatusBadge } from "@/components/status-badge";

export interface FrontDeskTodayBoardProps {
  rooms: RoomOut[];
  reservations: ReservationOut[];
  stays: StayOut[];
  attention: AttentionItem[];
  summary: TodaySummaryData;
  permissions: Set<string>;
  today: string;
  canReadGuest: boolean;
  onOpenReservation: (res: ReservationOut) => void;
  onOpenRoom: (room: RoomOut) => void;
  onSelectSummary: (kind: SummaryKind) => void;
  /** Sprint 6 §25：在住换房入口（stay:room_move 才渲染按钮）。 */
  onOpenStayMove: (stayId: number) => void;
}

function AttentionReservationButton({
  item,
  reservations,
  onOpenReservation,
}: {
  item: AttentionItem;
  reservations: ReservationOut[];
  onOpenReservation: (res: ReservationOut) => void;
}) {
  const res = reservations.find((r) => r.id === item.reservationId);
  if (!res) return null;
  return (
    <button
      type="button"
      onClick={() => onOpenReservation(res)}
      className="mt-2 rounded-md bg-gray-900 px-2.5 py-1.5 text-xs font-medium text-white"
    >
      查看预订
    </button>
  );
}

export default function FrontDeskTodayBoard({
  rooms,
  reservations,
  stays,
  attention,
  summary,
  permissions,
  today,
  canReadGuest,
  onOpenReservation,
  onOpenRoom,
  onSelectSummary,
  onOpenStayMove,
}: FrontDeskTodayBoardProps) {
  const canStay = permissions.has("stay:read");
  const canRoomMove = permissions.has("stay:room_move");

  return (
    <div className="space-y-5 pb-8">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">前台指挥台</h1>
        <p className="mt-0.5 text-xs text-gray-500">
          业务日期 {today}（Asia/Shanghai）
        </p>
      </div>

      <SearchBox
        rooms={rooms}
        canReadGuest={canReadGuest}
        canSearchReservations={permissions.has("reservation:read")}
        onOpenRoom={onOpenRoom}
        onOpenReservation={onOpenReservation}
      />

      <TodaySummary
        counts={{
          arrivals: summary.arrivals.length,
          departures: summary.departures.length,
          inhouse: summary.inHouse.length,
          vacantClean: summary.vacantClean.length,
          attention: attention.length,
        }}
        showStayCards={canStay}
        onSelect={onSelectSummary}
      />

      <section aria-label="需关注">
        <h2 className="mb-2 text-sm font-semibold text-gray-900">需关注</h2>
        {attention.length === 0 ? (
          <p className="text-sm text-gray-400">暂无需要关注的事项</p>
        ) : (
          <ul className="space-y-2">
            {attention.slice(0, 5).map((item, idx) => (
              <li
                key={`${item.rule}-${item.reservationId ?? item.stayId ?? idx}`}
                className="rounded-md border border-red-200 bg-red-50/60 px-3 py-2.5"
              >
                <p className="text-xs font-semibold text-red-700">
                  {attentionRuleLabel(item.rule)} · 房间 {item.roomNumber}
                </p>
                <p className="mt-1 text-sm text-gray-800">{item.problem}</p>
                {item.nextStep === "reservation" ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <AttentionReservationButton
                      item={item}
                      reservations={reservations}
                      onOpenReservation={onOpenReservation}
                    />
                    {/* Sprint 5 修复：预订存在维修风险 → 直达首张阻断工单 */}
                    {item.maintenance ? (
                      <a
                        href={`/maintenance/${item.maintenance.workOrderId}`}
                        className="rounded-md border border-red-300 px-2.5 py-1.5 text-xs font-medium text-red-700"
                      >
                        查看维修 →
                      </a>
                    ) : null}
                  </div>
                ) : null}
                {item.nextStep === "stay" && item.stayId ? (
                  <a
                    href={`/stays/${item.stayId}`}
                    className="mt-2 inline-block rounded-md bg-gray-900 px-2.5 py-1.5 text-xs font-medium text-white"
                  >
                    查看在住
                  </a>
                ) : null}
                {item.nextStep === "room" ? (
                  <button
                    type="button"
                    onClick={() =>
                      onOpenRoom(
                        rooms.find((r) => r.id === item.roomId) ??
                          ({ id: item.roomId } as RoomOut),
                      )
                    }
                    className="mt-2 rounded-md border border-gray-300 px-2.5 py-1.5 text-xs font-medium text-gray-700"
                  >
                    查看房间
                  </button>
                ) : null}
              </li>
            ))}
            {attention.length > 5 ? (
              <li>
                <button
                  type="button"
                  onClick={() => onSelectSummary("attention")}
                  className="text-xs text-gray-500 underline underline-offset-2"
                >
                  查看全部 {attention.length} 条 →
                </button>
              </li>
            ) : null}
          </ul>
        )}
      </section>

      <section aria-label="今日到店">
        <h2 className="mb-2 text-sm font-semibold text-gray-900">今日到店</h2>
        {summary.arrivals.length === 0 ? (
          <p className="text-sm text-gray-400">今日无到店预订</p>
        ) : (
          <ul className="space-y-1.5">
            {summary.arrivals.map((res) => (
              <li key={res.id}>
                <button
                  type="button"
                  onClick={() => onOpenReservation(res)}
                  className="flex w-full items-center gap-2 rounded-md border border-gray-200 px-3 py-2.5 text-left text-sm"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-gray-900">
                      {canReadGuest && res.guest_name
                        ? res.guest_name
                        : res.reservation_no}
                    </span>
                    <span className="block text-xs text-gray-500">
                      房间 {res.room_number ?? `#${res.room_id}`} ·{" "}
                      {SOURCE_LABELS[res.source] ?? res.source}
                    </span>
                  </span>
                  <StatusBadge meta={RESERVATION_STATUS_META[res.status]} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {canStay ? (
        <section aria-label="今日离店">
          <h2 className="mb-2 text-sm font-semibold text-gray-900">今日离店</h2>
          {summary.departures.length === 0 ? (
            <p className="text-sm text-gray-400">今日无计划离店</p>
          ) : (
            <ul className="space-y-1.5">
              {summary.departures.map((stay) => (
                <li key={stay.id}>
                  <a
                    href={`/stays/${stay.id}`}
                    className="block rounded-md border border-gray-200 px-3 py-2.5 text-sm"
                  >
                    <span className="block font-medium text-gray-900">
                      {stay.stay_no}
                    </span>
                    <span className="block text-xs text-gray-500">
                      房间 {stay.room_number ?? `#${stay.room_id}`} · 计划离店{" "}
                      {stay.planned_check_out_date}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {canStay ? (
        <section aria-label="当前在住">
          <h2 className="mb-2 text-sm font-semibold text-gray-900">
            当前在住（{stays.length}）
          </h2>
          {stays.length === 0 ? (
            <p className="text-sm text-gray-400">当前无在住</p>
          ) : (
            <ul className="space-y-1.5">
              {stays.slice(0, 8).map((stay) => (
                <li key={stay.id}>
                  <div className="flex items-center gap-2 rounded-md border border-gray-200 px-3 py-2.5 text-sm">
                    <a href={`/stays/${stay.id}`} className="min-w-0 flex-1">
                      <span className="block font-medium text-gray-900">
                        {stay.stay_no}
                      </span>
                      <span className="block text-xs text-gray-500">
                        房间 {stay.room_number ?? `#${stay.room_id}`} · 计划离店{" "}
                        {stay.planned_check_out_date}
                      </span>
                    </a>
                    {canRoomMove ? (
                      <button
                        type="button"
                        onClick={() => onOpenStayMove(stay.id)}
                        className="shrink-0 rounded-md border border-gray-300 px-2.5 py-1.5 text-xs font-medium text-gray-700"
                      >
                        换房
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}
