"use client";

/**
 * /stays/[id] 在住详情：
 * - 真实 GET /stays/{id}；stay:read（403 → Forbidden）
 * - Stay No / Status / Room / actual_check_in_at / planned_check_out_date / actual_check_out_at
 * - 关联 Reservation 摘要（reservation:read）与 Guest 信息（guest:read）
 * - ACTIVE + stay:check_out → 退房（确认对话框 + 防重复提交）
 * - ACTIVE + stay:room_move → 换房（Room Move Dialog，Sprint 6 §25/§26）
 * - 房间记录（Sprint 6 §27：StayRoomAssignment 历史，仅详情接口加载）
 * - 原分配房 vs 当前在住房（Sprint 6 §28：仅发生换房时展示）
 * - 退房成功后重新获取真实数据：Stay=CHECKED_OUT、Reservation=COMPLETED、Room=available+dirty
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ApiError, api } from "@/lib/api";
import type { RoomOut, StayOut } from "@/lib/api/types";
import {
  RESERVATION_STATUS_META,
  STAY_STATUS_META,
  formatDateTime,
  formatMoney,
} from "@/lib/booking";
import {
  formatAssignmentHistory,
  originalRoomNumber,
  stayHasMoved,
} from "@/lib/room-move";
import RoomMoveDialog from "@/components/booking/room-move-dialog";
import { CleaningBadge, OccupancyBadge, StatusBadge } from "@/components/status-badge";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ErrorView, Forbidden, Loading } from "@/components/status-views";
import { useUser } from "@/components/app-shell";
import {
  AlertBanner,
  SectionCard,
  dangerButtonClass,
  secondaryButtonClass,
} from "@/components/booking/shared";

export default function StayDetailView({ id }: { id: string }) {
  const router = useRouter();
  const user = useUser();
  const permissions = useMemo(() => new Set(user?.permissions ?? []), [user]);
  const canReadGuest = permissions.has("guest:read");
  const canReadReservation = permissions.has("reservation:read");
  const canCheckOut = permissions.has("stay:check_out");
  const canRoomMove = permissions.has("stay:room_move");
  const canReadRooms = permissions.has("room:read");

  const [stay, setStay] = useState<StayOut | null>(null);
  const [room, setRoom] = useState<RoomOut | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ kind: "success" | "conflict"; text: string } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api.stays
      .get(id)
      .then((data) => {
        if (cancelled) return;
        setStay(data);
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
  }, [router, id, reloadKey]);

  // 退房后展示房间现场状态（available + dirty）；无 room:read 时隐藏
  useEffect(() => {
    if (!stay || !canReadRooms) return;
    let cancelled = false;
    api.rooms
      .get(stay.room_id)
      .then((data) => {
        if (!cancelled) setRoom(data);
      })
      .catch(() => {
        if (!cancelled) setRoom(null);
      });
    return () => {
      cancelled = true;
    };
  }, [stay, canReadRooms, reloadKey]);

  const retry = useCallback(() => {
    setError(null);
    setForbidden(false);
    setStay(null);
    setReloadKey((k) => k + 1);
  }, []);

  async function runCheckOut() {
    if (!stay || busy) return;
    setBusy(true);
    setBanner(null);
    try {
      await api.stays.checkOut(stay.id);
      // 重新获取真实数据（Stay=CHECKED_OUT + Reservation=COMPLETED）
      setReloadKey((k) => k + 1);
      setBanner({ kind: "success", text: "退房完成：房间已置为可售 + 待清扫" });
    } catch (err) {
      if (err instanceof ApiError && err.kind === "unauthorized") {
        router.replace("/login");
        return;
      }
      if (err instanceof ApiError && err.kind === "conflict") {
        // 后端 409 原文（如「该入住记录已退房」）
        setBanner({ kind: "conflict", text: err.message });
        return;
      }
      setBanner({
        kind: "conflict",
        text: err instanceof ApiError ? err.message : "退房失败，请稍后重试",
      });
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  if (forbidden) {
    return <Forbidden text="无权限查看在住详情" />;
  }
  if (error) {
    return (
      <div>
        <BackLink />
        <ErrorView
          message={
            error.kind === "not_found" ? "入住记录不存在或已被删除" : error.message
          }
          offline={error.kind === "network"}
          onRetry={error.kind === "not_found" ? undefined : retry}
        />
      </div>
    );
  }
  if (!stay) {
    return (
      <div>
        <BackLink />
        <Loading text="正在加载在住详情…" />
      </div>
    );
  }

  const reservation = stay.reservation ?? null;
  const isActive = stay.status === "ACTIVE";

  const fields: { label: string; value: string }[] = [
    { label: "入住单号", value: stay.stay_no },
    {
      label: "房间",
      value: `${stay.room_number ?? `#${stay.room_id}`}`,
    },
    { label: "实际入住时间", value: formatDateTime(stay.actual_check_in_at) },
    { label: "计划退房日期", value: stay.planned_check_out_date },
    {
      label: "实际退房时间",
      value: formatDateTime(stay.actual_check_out_at),
    },
  ];

  return (
    <div className="mx-auto max-w-4xl">
      <BackLink />

      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">
            入住 {stay.stay_no}
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            预订号{" "}
            {reservation ? (
              <Link
                href={`/reservations/${stay.reservation_id}`}
                className="text-gray-700 hover:underline"
              >
                {reservation.reservation_no}
              </Link>
            ) : (
              `#${stay.reservation_id}`
            )}
          </p>
        </div>
        <StatusBadge meta={STAY_STATUS_META[stay.status]} />
      </div>

      {banner ? (
        <div className="mb-4">
          <AlertBanner kind={banner.kind}>{banner.text}</AlertBanner>
        </div>
      ) : null}

      {isActive && canCheckOut ? (
        <div className="mb-5 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={busy}
            className={dangerButtonClass}
          >
            办理退房
          </button>
          {canRoomMove ? (
            <button
              type="button"
              onClick={() => setMoveOpen(true)}
              disabled={busy}
              className={secondaryButtonClass}
            >
              换房
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="space-y-5">
        <SectionCard title="入住信息">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
            {fields.map((f) => (
              <div key={f.label}>
                <dt className="text-xs text-gray-500">{f.label}</dt>
                <dd className="mt-0.5 break-words text-sm text-gray-900">
                  {f.value}
                </dd>
              </div>
            ))}
          </dl>
        </SectionCard>

        {canReadRooms && room && room.id === stay.room_id ? (
          <SectionCard title="房间现场状态">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm text-gray-600">
                房间 {room.room_number}：
              </span>
              <OccupancyBadge status={room.occupancy_status} />
              <CleaningBadge status={room.cleaning_status} />
            </div>
          </SectionCard>
        ) : null}

        {canReadReservation && reservation ? (
          <SectionCard title="关联预订">
            <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
              <div>
                <dt className="text-xs text-gray-500">预订状态</dt>
                <dd className="mt-1">
                  <StatusBadge
                    meta={RESERVATION_STATUS_META[reservation.status]}
                  />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-gray-500">入住 / 退房日期</dt>
                <dd className="mt-1 text-sm text-gray-900">
                  {reservation.check_in_date} → {reservation.check_out_date}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-gray-500">金额</dt>
                <dd className="mt-1 text-sm text-gray-900">
                  {formatMoney(
                    reservation.agreed_total_amount,
                    reservation.currency,
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-gray-500">来源</dt>
                <dd className="mt-1 text-sm text-gray-900">
                  {reservation.source}
                </dd>
              </div>
            </dl>
          </SectionCard>
        ) : null}

        {canReadGuest && stay.guest_id != null ? (
          <SectionCard title="客人">
            <p className="text-sm text-gray-900">
              {stay.guest_name ?? `ID ${stay.guest_id}`}
            </p>
          </SectionCard>
        ) : null}

        {/* Sprint 6 §28：仅发生换房时展示原分配房 vs 当前在住房（避免噪声） */}
        {stayHasMoved(stay) && originalRoomNumber(stay) ? (
          <SectionCard title="换房信息">
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
              <div>
                <dt className="text-xs text-gray-500">原分配房</dt>
                <dd className="mt-0.5 text-sm font-medium text-gray-900">
                  {originalRoomNumber(stay)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-gray-500">当前在住房</dt>
                <dd className="mt-0.5 text-sm font-medium text-gray-900">
                  {stay.room_number ?? `#${stay.room_id}`}
                </dd>
              </div>
            </dl>
          </SectionCard>
        ) : null}

        {/* Sprint 6 §27：房间记录（StayRoomAssignment 历史） */}
        {stay.assignments && stay.assignments.length > 0 ? (
          <SectionCard title="房间记录">
            <ol className="space-y-2.5">
              {stay.assignments.map((assignment) => {
                const row = formatAssignmentHistory(assignment);
                return (
                  <li
                    key={assignment.id}
                    className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 rounded-md border border-gray-100 bg-gray-50/60 px-3 py-2"
                  >
                    <span className="text-sm font-medium text-gray-900">
                      房间 {row.roomLabel}
                    </span>
                    <span className="text-xs tabular-nums text-gray-500">
                      {row.periodLabel}
                    </span>
                    <span
                      className={`text-xs ${
                        row.isCurrent
                          ? "font-medium text-emerald-700"
                          : "text-gray-500"
                      }`}
                    >
                      {row.reasonLabel}
                      {row.isCurrent ? " · 当前" : ""}
                    </span>
                  </li>
                );
              })}
            </ol>
          </SectionCard>
        ) : null}
      </div>

      <RoomMoveDialog
        stay={stay}
        open={moveOpen}
        onClose={() => setMoveOpen(false)}
        onMoved={() => {
          setReloadKey((k) => k + 1);
          setBanner({ kind: "success", text: "换房完成" });
        }}
      />

      <ConfirmDialog
        open={confirming}
        title="确认退房"
        message="确定办理退房吗？退房后房间将变为可售 + 待清扫，预订状态变为 COMPLETED。"
        confirmLabel="确认退房"
        busy={busy}
        onConfirm={() => void runCheckOut()}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/stays"
      className="mb-4 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900"
    >
      ← 返回在住列表
    </Link>
  );
}
