"use client";

/**
 * 右侧 Drawer 内容（不拥有 Booking Business Logic，全部复用 Sprint 2 API）：
 * - Arrivals / Departures / In-house / Vacant Clean / Attention 列表
 * - Reservation Quick View：Room/Guest/Dates/Nights/Source/Amount/状态 +
 *   Room occupancy + cleaning + Housekeeping（按权限），
 *   Check-in / Edit / Cancel / No-show / Full Detail（按 status + 权限显隐）
 * - Room Quick View：双状态 + current active stay + active housekeeping task
 *   + next reservation；完整详情链接
 *
 * §11 未准备房间：今日到店且 cleaning != clean → 不把 Check-in 作为主操作，
 * 明确显示「房间尚未准备完成」+ Active HousekeepingTask（Task No/status/assignee）
 * + 查看保洁任务；后端 Check-in 409 仍为最终权威。
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ApiError, api } from "@/lib/api";
import type {
  HousekeepingTaskOut,
  MaintenanceWorkOrderOut,
  ReservationOut,
  RoomOut,
  StayOut,
} from "@/lib/api/types";
import {
  RESERVATION_STATUS_META,
  SOURCE_LABELS,
  formatMoney,
} from "@/lib/booking";
import {
  HK_SOURCE_LABELS,
  HK_TASK_STATUS_META,
} from "@/lib/housekeeping";
import {
  MWO_CATEGORY_LABELS,
  MWO_STATUS_META,
} from "@/lib/maintenance";
import {
  activeTaskForRoom,
  attentionRuleLabel,
  computeAttention,
  isTodayArrival,
  quickCreateHref,
  reservationNights,
} from "@/lib/front-desk";
import type { FrontDeskBundle } from "./use-front-desk-data";
import { CleaningBadge, OccupancyBadge, StatusBadge } from "@/components/status-badge";
import { ConfirmDialog } from "@/components/confirm-dialog";
import RoomMoveDialog from "@/components/booking/room-move-dialog";
import { Loading } from "@/components/status-views";
import {
  AlertBanner,
  dangerButtonClass,
  primaryButtonClass,
  secondaryButtonClass,
} from "@/components/booking/shared";

export type DrawerSelection =
  | { kind: "arrivals" }
  | { kind: "departures" }
  | { kind: "inhouse" }
  | { kind: "vacant-clean" }
  | { kind: "attention" }
  | { kind: "reservation"; reservationId: number }
  | { kind: "room"; roomId: number }
  /** Sprint 6 §25：在住换房（stay:room_move 才可进入）。 */
  | { kind: "stay-move"; stayId: number };

export const DRAWER_TITLES: Record<DrawerSelection["kind"], string> = {
  arrivals: "今日到店",
  departures: "今日离店",
  inhouse: "当前在住",
  "vacant-clean": "空净房",
  attention: "需关注",
  reservation: "预订速览",
  room: "房间速览",
  // 与换房 Modal（role=dialog name=换房）区分，避免可访问名称歧义
  "stay-move": "在住换房",
};

export interface DrawerViewProps {
  selection: DrawerSelection;
  bundle: FrontDeskBundle;
  permissions: Set<string>;
  today: string;
  /** 写操作成功后触发（父级 targeted refetch）。 */
  onChanged: () => void;
  /** 切换抽屉内容；传 null 关闭抽屉（Sprint 6 换房成功后收口）。 */
  onSelect: (next: DrawerSelection | null) => void;
}

export default function FrontDeskDrawerView({
  selection,
  bundle,
  permissions,
  today,
  onChanged,
  onSelect,
}: DrawerViewProps) {
  switch (selection.kind) {
    case "arrivals":
      return (
        <ArrivalsView
          bundle={bundle}
          permissions={permissions}
          today={today}
          onSelect={onSelect}
        />
      );
    case "departures":
      return <DeparturesView bundle={bundle} today={today} />;
    case "inhouse":
      return (
        <InHouseView
          bundle={bundle}
          permissions={permissions}
          onSelect={onSelect}
        />
      );
    case "stay-move":
      return (
        <StayMoveView
          stayId={selection.stayId}
          bundle={bundle}
          onChanged={onChanged}
          onSelect={onSelect}
        />
      );
    case "vacant-clean":
      return (
        <VacantCleanView bundle={bundle} today={today} onSelect={onSelect} />
      );
    case "attention":
      return (
        <AttentionView
          bundle={bundle}
          today={today}
          onSelect={onSelect}
        />
      );
    case "reservation":
      return (
        <ReservationQuickView
          reservationId={selection.reservationId}
          bundle={bundle}
          permissions={permissions}
          today={today}
          onChanged={onChanged}
          onSelect={onSelect}
        />
      );
    case "room":
      return (
        <RoomQuickView
          roomId={selection.roomId}
          bundle={bundle}
          permissions={permissions}
          today={today}
          onSelect={onSelect}
        />
      );
  }
}

/* ------------------------------------------------------------------ */
/* 共享小件                                                            */
/* ------------------------------------------------------------------ */

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <dt className="shrink-0 text-xs text-gray-500">{label}</dt>
      <dd className="min-w-0 text-right text-sm text-gray-900">{children}</dd>
    </div>
  );
}

function stayHref(stay: StayOut): string {
  return `/stays/${stay.id}`;
}

function stayHrefById(stayId: number): string {
  return `/stays/${stayId}`;
}

function stayLabel(stay: StayOut, canReadGuest: boolean): string {
  return canReadGuest && stay.guest_name
    ? `${stay.stay_no} · ${stay.guest_name}`
    : stay.stay_no;
}

function reservationLabel(
  res: ReservationOut,
  canReadGuest: boolean,
): string {
  return canReadGuest && res.guest_name
    ? `${res.reservation_no} · ${res.guest_name}`
    : res.reservation_no;
}

/** 保洁任务信息块（仅 housekeeping_task:read 时渲染；数据来自 bundle）。 */
function HousekeepingInfo({
  task,
  room,
  canRead,
}: {
  task: HousekeepingTaskOut | null;
  room: RoomOut;
  canRead: boolean;
}) {
  if (!canRead) return null;
  if (task) {
    const meta = HK_TASK_STATUS_META[task.status];
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm">
        <p className="font-medium text-amber-900">保洁任务 {task.task_no}</p>
        <p className="mt-0.5 text-xs text-amber-800">
          {meta?.label ?? task.status}
          {task.assignee_name ? ` · 负责人 ${task.assignee_name}` : " · 未派单"}
          {task.source ? ` · ${HK_SOURCE_LABELS[task.source]}` : ""}
        </p>
        <Link
          href={`/housekeeping/${task.id}`}
          className="mt-1.5 inline-block text-xs font-medium text-amber-900 underline underline-offset-2 hover:text-amber-700"
        >
          查看保洁任务 →
        </Link>
      </div>
    );
  }
  if (room.cleaning_status !== "clean") {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm">
        <p className="text-xs text-amber-800">
          无进行中的保洁任务
          <Link
            href="/housekeeping"
            className="ml-1.5 font-medium underline underline-offset-2"
          >
            前往保洁工作台 →
          </Link>
        </p>
      </div>
    );
  }
  return null;
}

const MWO_ACTIVE_STATUSES = ["OPEN", "ASSIGNED", "IN_PROGRESS", "RESOLVED"];

/** 维修工单信息块（Sprint 5 §38：仅 maintenance_order:read 时渲染；
 *  展示 Active 工单 + status + blocks_room + assignee + 查看维修）。 */
function MaintenanceInfo({
  workOrders,
  canRead,
}: {
  workOrders: MaintenanceWorkOrderOut[];
  canRead: boolean;
}) {
  if (!canRead) return null;
  const active = workOrders.filter((o) =>
    MWO_ACTIVE_STATUSES.includes(o.status),
  );
  if (active.length === 0) return null;
  return (
    <div className="space-y-2">
      {active.map((order) => {
        const meta = MWO_STATUS_META[order.status];
        const blocking =
          order.blocks_room && MWO_ACTIVE_STATUSES.includes(order.status);
        return (
          <div
            key={order.id}
            className={`rounded-md border px-3 py-2 text-sm ${
              blocking
                ? "border-red-200 bg-red-50"
                : "border-gray-200 bg-gray-50"
            }`}
          >
            <p
              className={`font-medium ${
                blocking ? "text-red-900" : "text-gray-900"
              }`}
            >
              维修工单 {order.work_order_no}
              {blocking ? " · 阻断客房" : ""}
            </p>
            <p
              className={`mt-0.5 text-xs ${
                blocking ? "text-red-800" : "text-gray-600"
              }`}
            >
              {MWO_CATEGORY_LABELS[order.category]} · {meta?.label ?? order.status}
              {order.assignee_name
                ? ` · 负责人 ${order.assignee_name}`
                : " · 未派单"}
            </p>
            <Link
              href={`/maintenance/${order.id}`}
              className={`mt-1.5 inline-block text-xs font-medium underline underline-offset-2 ${
                blocking
                  ? "text-red-900 hover:text-red-700"
                  : "text-gray-900 hover:text-gray-700"
              }`}
            >
              查看维修 →
            </Link>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 列表类抽屉                                                           */
/* ------------------------------------------------------------------ */

function ArrivalsView({
  bundle,
  permissions,
  today,
  onSelect,
}: {
  bundle: FrontDeskBundle;
  permissions: Set<string>;
  today: string;
  onSelect: (next: DrawerSelection) => void;
}) {
  const canReadGuest = permissions.has("guest:read");
  const arrivals = (bundle.reservations ?? []).filter((r) =>
    isTodayArrival(r, today),
  );
  if (arrivals.length === 0) {
    return <p className="text-sm text-gray-400">今日无到店预订</p>;
  }
  return (
    <ul className="space-y-1.5">
      {arrivals.map((res) => (
        <li key={res.id}>
          <button
            type="button"
            onClick={() =>
              onSelect({ kind: "reservation", reservationId: res.id })
            }
            className="flex w-full items-center gap-2 rounded-md border border-gray-200 px-3 py-2 text-left text-sm hover:border-gray-400"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-gray-900">
                {reservationLabel(res, canReadGuest)}
              </span>
              <span className="block text-xs text-gray-500">
                房间 {res.room_number ?? `#${res.room_id}`} ·{" "}
                {SOURCE_LABELS[res.source] ?? res.source} · 共{" "}
                {reservationNights(res)} 晚
              </span>
            </span>
            <StatusBadge meta={RESERVATION_STATUS_META[res.status]} />
          </button>
        </li>
      ))}
    </ul>
  );
}

function DeparturesView({
  bundle,
  today,
}: {
  bundle: FrontDeskBundle;
  today: string;
}) {
  const departures = (bundle.stays ?? []).filter(
    (s) => s.planned_check_out_date === today,
  );
  if (departures.length === 0) {
    return <p className="text-sm text-gray-400">今日无计划离店</p>;
  }
  return (
    <ul className="space-y-1.5">
      {departures.map((stay) => (
        <li key={stay.id}>
          <Link
            href={stayHref(stay)}
            className="block rounded-md border border-gray-200 px-3 py-2 text-sm hover:border-gray-400"
          >
            <span className="block font-medium text-gray-900">
              {stay.stay_no}
            </span>
            <span className="block text-xs text-gray-500">
              房间 {stay.room_number ?? `#${stay.room_id}`} · 计划离店{" "}
              {stay.planned_check_out_date}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function InHouseView({
  bundle,
  permissions,
  onSelect,
}: {
  bundle: FrontDeskBundle;
  permissions: Set<string>;
  onSelect: (next: DrawerSelection | null) => void;
}) {
  const canRoomMove = permissions.has("stay:room_move");
  const stays = (bundle.stays ?? []).slice().sort((a, b) =>
    String(a.room_number ?? "").localeCompare(String(b.room_number ?? "")),
  );
  if (stays.length === 0) {
    return <p className="text-sm text-gray-400">当前无在住</p>;
  }
  return (
    <ul className="space-y-1.5">
      {stays.map((stay) => (
        <li key={stay.id}>
          <div className="flex items-center gap-2 rounded-md border border-gray-200 px-3 py-2 text-sm hover:border-gray-400">
            <Link href={stayHref(stay)} className="min-w-0 flex-1">
              <span className="block font-medium text-gray-900">
                {stay.stay_no}
              </span>
              <span className="block text-xs text-gray-500">
                房间 {stay.room_number ?? `#${stay.room_id}`} · 计划离店{" "}
                {stay.planned_check_out_date}
              </span>
            </Link>
            {/* Sprint 6 §25：有 stay:room_move 权限时显示 [换房]，无权限 hidden；
                后端仍 403 防护 */}
            {canRoomMove ? (
              <button
                type="button"
                onClick={() =>
                  onSelect({ kind: "stay-move", stayId: stay.id })
                }
                className="shrink-0 rounded-md border border-gray-300 px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
              >
                换房
              </button>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Sprint 6 §25：在住换房抽屉视图（复用 RoomMoveDialog，后端权威候选）。 */
function StayMoveView({
  stayId,
  bundle,
  onChanged,
  onSelect,
}: {
  stayId: number;
  bundle: FrontDeskBundle;
  onChanged: () => void;
  onSelect: (next: DrawerSelection | null) => void;
}) {
  const bundleStay = (bundle.stays ?? []).find((s) => s.id === stayId);
  const [fetched, setFetched] = useState<StayOut | null>(null);
  const [fetchError, setFetchError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (bundleStay) return;
    let cancelled = false;
    api.stays
      .get(stayId)
      .then((data) => {
        if (!cancelled) setFetched(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setFetchError(
            err instanceof ApiError
              ? err
              : new ApiError("unknown", null, "加载在住信息失败"),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [stayId, bundleStay]);

  const stay = bundleStay ?? fetched;
  if (fetchError) {
    return (
      <p role="alert" className="text-sm text-red-600">
        {fetchError.message}
      </p>
    );
  }
  if (!stay) {
    return <Loading text="正在加载在住信息…" />;
  }
  return (
    <RoomMoveDialog
      stay={stay}
      open
      onClose={() => onSelect(null)}
      onMoved={() => {
        onChanged();
      }}
    />
  );
}

function VacantCleanView({
  bundle,
  today,
  onSelect,
}: {
  bundle: FrontDeskBundle;
  today: string;
  onSelect: (next: DrawerSelection) => void;
}) {
  const rooms = (bundle.rooms ?? [])
    .filter((r) => r.occupancy_status === "available" && r.cleaning_status === "clean")
    .sort((a, b) => a.room_number.localeCompare(b.room_number, "zh-CN"));
  if (rooms.length === 0) {
    return <p className="text-sm text-gray-400">当前无空净房</p>;
  }
  return (
    <ul className="space-y-1.5">
      {rooms.map((room) => (
        <li key={room.id}>
          <button
            type="button"
            onClick={() => onSelect({ kind: "room", roomId: room.id })}
            className="flex w-full items-center justify-between gap-2 rounded-md border border-gray-200 px-3 py-2 text-left text-sm hover:border-gray-400"
          >
            <span>
              <span className="font-semibold text-gray-900">
                {room.room_number}
              </span>
              <span className="ml-2 text-xs text-gray-500">
                {room.room_type?.name ?? `房型 #${room.room_type_id}`}
              </span>
            </span>
            <Link
              href={quickCreateHref(room.id, room.room_type_id, today)}
              onClick={(e) => e.stopPropagation()}
              className="rounded-md bg-gray-900 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-gray-700"
            >
              新建预订
            </Link>
          </button>
        </li>
      ))}
    </ul>
  );
}

function AttentionView({
  bundle,
  today,
  onSelect,
}: {
  bundle: FrontDeskBundle;
  today: string;
  onSelect: (next: DrawerSelection) => void;
}) {
  const items = useMemo(
    () =>
      computeAttention(
        bundle.reservations ?? [],
        bundle.stays ?? [],
        bundle.rooms ?? [],
        today,
        bundle.workOrders ?? [],
      ),
    [bundle, today],
  );
  if (items.length === 0) {
    return <p className="text-sm text-gray-400">暂无需要关注的事项</p>;
  }
  return (
    <ul className="space-y-2">
      {items.map((item, idx) => (
        <li
          key={`${item.rule}-${item.reservationId ?? item.stayId ?? item.roomId}-${idx}`}
          className="rounded-md border border-red-200 bg-red-50/60 px-3 py-2.5"
        >
          <p className="text-xs font-semibold text-red-700">
            {attentionRuleLabel(item.rule)} · 房间 {item.roomNumber}
          </p>
          <p className="mt-1 text-sm text-gray-800">{item.problem}</p>
          {item.reservationNo ? (
            <p className="mt-0.5 text-xs text-gray-500">
              预订 {item.reservationNo}
            </p>
          ) : null}
          {item.stayNo ? (
            <p className="mt-0.5 text-xs text-gray-500">在住 {item.stayNo}</p>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-2">
            {item.nextStep === "reservation" && item.reservationId ? (
              <button
                type="button"
                onClick={() =>
                  onSelect({
                    kind: "reservation",
                    reservationId: item.reservationId as number,
                  })
                }
                className="rounded-md bg-gray-900 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-gray-700"
              >
                查看预订
              </button>
            ) : null}
            {item.nextStep === "stay" && item.stayId ? (
              <Link
                href={stayHrefById(item.stayId)}
                className="rounded-md bg-gray-900 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-gray-700"
              >
                查看在住
              </Link>
            ) : null}
            {/* Sprint 5 修复：预订存在维修风险 → 直达首张阻断工单 */}
            {item.maintenance ? (
              <Link
                href={`/maintenance/${item.maintenance.workOrderId}`}
                className="rounded-md border border-red-300 px-2.5 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50"
              >
                查看维修 →
              </Link>
            ) : null}
            {item.nextStep === "room" ? (
              <button
                type="button"
                onClick={() => onSelect({ kind: "room", roomId: item.roomId })}
                className="rounded-md border border-gray-300 px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
              >
                查看房间
              </button>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ */
/* Reservation Quick View                                               */
/* ------------------------------------------------------------------ */

type ReservationAction = "cancel" | "no_show" | "check_in";

function ReservationQuickView({
  reservationId,
  bundle,
  permissions,
  today,
  onChanged,
  onSelect,
}: {
  reservationId: number;
  bundle: FrontDeskBundle;
  permissions: Set<string>;
  today: string;
  onChanged: () => void;
  onSelect: (next: DrawerSelection) => void;
}) {
  const canReadGuest = permissions.has("guest:read");
  const canCheckIn = permissions.has("stay:check_in");
  const canEdit = permissions.has("reservation:write");
  const canCancel = permissions.has("reservation:cancel");
  const canNoShow = permissions.has("reservation:no_show");
  const canReadStay = permissions.has("stay:read");
  const canReadHousekeeping = permissions.has("housekeeping_task:read");
  const canReadMaintenance = permissions.has("maintenance_order:read");

  // 抽屉内目标预订：优先窗口 bundle，缺失时（搜索命中窗口外）定向拉取
  const [fetched, setFetched] = useState<ReservationOut | null>(null);
  const [fetchError, setFetchError] = useState<ApiError | null>(null);
  const [override, setOverride] = useState<ReservationOut | null>(null);
  const [action, setAction] = useState<ReservationAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<
    { kind: "success" | "conflict"; text: string } | null
  >(null);

  const bundleRes = (bundle.reservations ?? []).find(
    (r) => r.id === reservationId,
  );
  const reservation = override ?? bundleRes ?? fetched;

  useEffect(() => {
    if (bundleRes) return;
    let cancelled = false;
    api.reservations
      .get(reservationId)
      .then((data) => {
        if (!cancelled) setFetched(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setFetchError(
            err instanceof ApiError
              ? err
              : new ApiError("unknown", null, "加载预订失败"),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [reservationId, bundleRes]);

  const room = (bundle.rooms ?? []).find((r) => r.id === reservation?.room_id);
  const task =
    room && canReadHousekeeping
      ? activeTaskForRoom(bundle.tasks ?? [], room.id)
      : null;
  const roomWorkOrders =
    room && canReadMaintenance
      ? (bundle.workOrders ?? []).filter((o) => o.room_id === room.id)
      : [];

  if (fetchError) {
    return (
      <p role="alert" className="text-sm text-red-600">
        {fetchError.message}
      </p>
    );
  }
  if (!reservation) {
    return <Loading text="正在加载预订…" />;
  }

  const isConfirmed = reservation.status === "CONFIRMED";
  const arrivalToday = isTodayArrival(reservation, today);
  const roomClean = room ? room.cleaning_status === "clean" : true;
  const nights = reservationNights(reservation);
  const currentId = reservation.id;
  // Sprint 6 §28：已入住且换过房 → 展示「原分配房 vs 当前在住房」
  const movedStay =
    reservation.status === "CHECKED_IN" && canReadStay
      ? (bundle.stays ?? []).find(
          (s) =>
            s.id === reservation.stay_id &&
            s.room_id !== reservation.room_id,
        )
      : null;

  async function runAction(kind: ReservationAction) {
    if (busy) return;
    setBusy(true);
    setBanner(null);
    try {
      if (kind === "check_in") {
        const result = await api.reservations.checkIn(currentId);
        setOverride(result.reservation);
        setBanner({ kind: "success", text: "入住办理成功" });
      } else if (kind === "cancel") {
        const updated = await api.reservations.cancel(currentId);
        setOverride(updated);
        setBanner({ kind: "success", text: "预订已取消（CANCELLED）" });
      } else {
        const updated = await api.reservations.noShow(currentId);
        setOverride(updated);
        setBanner({ kind: "success", text: "已标记未到店（NO_SHOW）" });
      }
      onChanged();
    } catch (err) {
      if (err instanceof ApiError) {
        setBanner({ kind: "conflict", text: err.message });
      } else {
        setBanner({ kind: "conflict", text: "操作失败，请稍后重试" });
      }
    } finally {
      setBusy(false);
      setAction(null);
    }
  }

  const showCheckIn = isConfirmed && arrivalToday && canCheckIn && roomClean;
  const showNotReady = isConfirmed && arrivalToday && room && !roomClean;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-base font-semibold text-gray-900">
            {reservation.reservation_no}
          </p>
          <p className="text-xs text-gray-500">
            {SOURCE_LABELS[reservation.source] ?? reservation.source}
          </p>
        </div>
        <StatusBadge meta={RESERVATION_STATUS_META[reservation.status]} />
      </div>

      {banner ? (
        <AlertBanner kind={banner.kind}>{banner.text}</AlertBanner>
      ) : null}

      {/* §11：未准备房间 —— Check-in 不作为正常主操作 */}
      {showNotReady ? (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-sm"
        >
          <p className="font-medium text-red-800">房间尚未准备完成</p>
          <p className="mt-0.5 text-xs text-red-700">
            房间 {room?.room_number} 清洁状态为 {room?.cleaning_status}，
            办理入住前请先完成清洁
          </p>
          <div className="mt-2">
            <HousekeepingInfo task={task} room={room as RoomOut} canRead={canReadHousekeeping} />
          </div>
        </div>
      ) : null}

      <dl>
        <FieldRow label="房间">
          <span className="font-medium">
            {reservation.room_number ?? `#${reservation.room_id}`}
          </span>
          {room ? (
            <span className="ml-2 text-xs text-gray-500">
              {room.room_type?.name ?? ""}
            </span>
          ) : null}
        </FieldRow>
        {/* Sprint 6 §28：换房后明确展示原分配房（上）与当前在住房（本行） */}
        {movedStay ? (
          <FieldRow label="当前在住房">
            <span className="font-medium">
              {movedStay.room_number ?? `#${movedStay.room_id}`}
            </span>
          </FieldRow>
        ) : null}
        <FieldRow label="客人">
          {canReadGuest && reservation.guest_name
            ? reservation.guest_name
            : `ID ${reservation.guest_id}`}
        </FieldRow>
        <FieldRow label="日期">
          {reservation.check_in_date} → {reservation.check_out_date}
        </FieldRow>
        <FieldRow label="晚数">{nights} 晚</FieldRow>
        <FieldRow label="来源">
          {SOURCE_LABELS[reservation.source] ?? reservation.source}
        </FieldRow>
        <FieldRow label="金额">
          {formatMoney(
            reservation.agreed_total_amount,
            reservation.currency,
          )}
        </FieldRow>
        <FieldRow label="预订状态">
          <StatusBadge meta={RESERVATION_STATUS_META[reservation.status]} />
        </FieldRow>
        {room ? (
          <>
            <FieldRow label="房间占用">
              <OccupancyBadge status={room.occupancy_status} />
            </FieldRow>
            <FieldRow label="房间清洁">
              <CleaningBadge status={room.cleaning_status} />
            </FieldRow>
          </>
        ) : null}
      </dl>

      {canReadHousekeeping &&
      room &&
      room.cleaning_status !== "clean" &&
      !showNotReady ? (
        <HousekeepingInfo task={task} room={room} canRead={canReadHousekeeping} />
      ) : null}

      {/* Sprint 5 §38：Active Maintenance Work Order（含阻断）感知 */}
      {room && roomWorkOrders.length > 0 ? (
        <MaintenanceInfo
          workOrders={roomWorkOrders}
          canRead={canReadMaintenance}
        />
      ) : null}

      {isConfirmed && !arrivalToday ? (
        <p className="text-xs text-gray-500">
          入住日期 {reservation.check_in_date}，未到入住日
        </p>
      ) : null}

      {reservation.status === "CHECKED_IN" && reservation.stay_id != null ? (
        canReadStay ? (
          <Link
            href={`/stays/${reservation.stay_id}`}
            className={primaryButtonClass + " inline-block"}
          >
            查看入住记录 →
          </Link>
        ) : null
      ) : null}

      <div className="flex flex-wrap gap-2 border-t border-gray-100 pt-3">
        {showCheckIn ? (
          <button
            type="button"
            onClick={() => setAction("check_in")}
            disabled={busy}
            className={primaryButtonClass}
          >
            办理入住
          </button>
        ) : null}
        {isConfirmed && canEdit ? (
          <Link
            href={`/reservations/${reservation.id}`}
            className={secondaryButtonClass}
          >
            编辑预订
          </Link>
        ) : null}
        {isConfirmed && canCancel ? (
          <button
            type="button"
            onClick={() => setAction("cancel")}
            disabled={busy}
            className={dangerButtonClass}
          >
            取消预订
          </button>
        ) : null}
        {isConfirmed && canNoShow ? (
          <button
            type="button"
            onClick={() => setAction("no_show")}
            disabled={busy}
            className={secondaryButtonClass}
          >
            标记未到店
          </button>
        ) : null}
        <Link
          href={`/reservations/${reservation.id}`}
          className={secondaryButtonClass}
        >
          完整预订详情 →
        </Link>
        {room ? (
          <button
            type="button"
            onClick={() => onSelect({ kind: "room", roomId: room.id })}
            className={secondaryButtonClass}
          >
            查看房间
          </button>
        ) : null}
      </div>

      <ConfirmDialog
        open={action !== null}
        title={
          action === "check_in"
            ? "办理入住"
            : action === "cancel"
              ? "取消预订"
              : "标记未到店"
        }
        message={
          action === "check_in"
            ? "确定为该预订办理入住吗？将创建在住记录并把房间置为在住。"
            : action === "cancel"
              ? "确定取消该预订吗？取消后预订状态将变为 CANCELLED（不可恢复）。"
              : "确定将客人标记为未到店吗？状态将变为 NO_SHOW（不可恢复）。"
        }
        confirmLabel={
          action === "check_in"
            ? "办理入住"
            : action === "cancel"
              ? "取消预订"
              : "标记未到店"
        }
        busy={busy}
        onConfirm={() => {
          if (action) void runAction(action);
        }}
        onCancel={() => setAction(null)}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Room Quick View                                                      */
/* ------------------------------------------------------------------ */

function RoomQuickView({
  roomId,
  bundle,
  permissions,
  today,
  onSelect,
}: {
  roomId: number;
  bundle: FrontDeskBundle;
  permissions: Set<string>;
  today: string;
  onSelect: (next: DrawerSelection) => void;
}) {
  const canReadGuest = permissions.has("guest:read");
  const canReadStay = permissions.has("stay:read");
  const canReadHousekeeping = permissions.has("housekeeping_task:read");
  const canReadMaintenance = permissions.has("maintenance_order:read");
  const canCreateReservation = permissions.has("reservation:write");

  const room = (bundle.rooms ?? []).find((r) => r.id === roomId);
  const activeStay =
    canReadStay && room
      ? (bundle.stays ?? []).find((s) => s.room_id === room.id && s.status === "ACTIVE")
      : null;
  const task =
    canReadHousekeeping && room
      ? activeTaskForRoom(bundle.tasks ?? [], room.id)
      : null;
  const roomWorkOrders =
    canReadMaintenance && room
      ? (bundle.workOrders ?? []).filter((o) => o.room_id === room.id)
      : [];

  // next reservation：抽屉打开时定向查询该房间（单次请求，不构成 N+1 页面级请求）
  const [nextReservations, setNextReservations] = useState<
    ReservationOut[] | null
  >(null);
  useEffect(() => {
    let cancelled = false;
    api.reservations
      .list({ room_id: roomId, page: 1, page_size: 20 })
      .then((page) => {
        if (!cancelled) setNextReservations(page.items);
      })
      .catch(() => {
        if (!cancelled) setNextReservations([]);
      });
    return () => {
      cancelled = true;
    };
  }, [roomId]);

  if (!room) {
    return <Loading text="正在加载房间…" />;
  }

  const nextReservation = (nextReservations ?? [])
    .filter(
      (r) =>
        (r.status === "CONFIRMED" || r.status === "CHECKED_IN") &&
        r.check_in_date >= today,
    )
    .sort((a, b) => a.check_in_date.localeCompare(b.check_in_date))[0];

  return (
    <div className="space-y-4">
      <div>
        <p className="text-base font-semibold text-gray-900">
          房间 {room.room_number}
        </p>
        <p className="text-xs text-gray-500">
          {room.room_type?.name ?? `房型 #${room.room_type_id}`}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <OccupancyBadge status={room.occupancy_status} />
        <CleaningBadge status={room.cleaning_status} />
      </div>

      {canReadHousekeeping && room.cleaning_status !== "clean" ? (
        <HousekeepingInfo task={task} room={room} canRead={canReadHousekeeping} />
      ) : null}

      {/* Sprint 5 §38：Active Maintenance Work Order + status + blocks_room + assignee */}
      {roomWorkOrders.length > 0 ? (
        <MaintenanceInfo
          workOrders={roomWorkOrders}
          canRead={canReadMaintenance}
        />
      ) : null}

      {canReadStay ? (
        <div className="rounded-md border border-gray-200 px-3 py-2.5">
          <p className="text-xs font-semibold text-gray-500">当前在住</p>
          {activeStay ? (
            <div className="mt-1.5">
              <p className="text-sm font-medium text-gray-900">
                {stayLabel(activeStay, canReadGuest)}
              </p>
              <p className="text-xs text-gray-500">
                计划离店 {activeStay.planned_check_out_date}
                {activeStay.planned_check_out_date < today ? (
                  <span className="ml-1.5 font-medium text-red-600">
                    已超期
                  </span>
                ) : null}
              </p>
              <Link
                href={stayHref(activeStay)}
                className="mt-1.5 inline-block text-xs font-medium text-gray-900 underline underline-offset-2"
              >
                查看在住详情 →
              </Link>
            </div>
          ) : (
            <p className="mt-1 text-sm text-gray-400">无在住记录</p>
          )}
        </div>
      ) : null}

      <div className="rounded-md border border-gray-200 px-3 py-2.5">
        <p className="text-xs font-semibold text-gray-500">下一笔预订</p>
        {nextReservation ? (
          <div className="mt-1.5">
            <p className="text-sm font-medium text-gray-900">
              {reservationLabel(nextReservation, canReadGuest)}
            </p>
            <p className="text-xs text-gray-500">
              {nextReservation.check_in_date} → {nextReservation.check_out_date}
              {" · "}
              {SOURCE_LABELS[nextReservation.source] ?? nextReservation.source}
            </p>
            <button
              type="button"
              onClick={() =>
                onSelect({
                  kind: "reservation",
                  reservationId: nextReservation.id,
                })
              }
              className="mt-1.5 text-xs font-medium text-gray-900 underline underline-offset-2"
            >
              打开预订速览 →
            </button>
          </div>
        ) : (
          <p className="mt-1 text-sm text-gray-400">
            {nextReservations === null ? "正在查询…" : "暂无未来预订"}
          </p>
        )}
      </div>

      <div className="flex flex-wrap gap-2 border-t border-gray-100 pt-3">
        <Link href={`/rooms/${room.id}`} className={secondaryButtonClass}>
          完整房间详情 →
        </Link>
        {canCreateReservation ? (
          <Link
            href={quickCreateHref(room.id, room.room_type_id, today)}
            className={primaryButtonClass}
          >
            新建预订
          </Link>
        ) : null}
      </div>
    </div>
  );
}
