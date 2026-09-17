"use client";

/**
 * /reservations/[id] 预订详情：
 * - 状态徽标 + 字段展示（PII 按 guest:read / reservation:read 裁剪，后端已裁剪，前端双保险）
 * - CONFIRMED：编辑（完整表单，改日期/房间/房型触发重新 Availability）+ Cancel / No-show / Check-in
 * - CHECKED_IN / CANCELLED / NO_SHOW / COMPLETED：不提供核心字段编辑
 * - Check-in 前展示房间 occupancy / cleaning 状态；后端 409 原文展示（dirty/occupied/日期资格等）
 * - 状态机不在前端复制：按钮显隐仅依据 status 值 + 权限，409 冲突以文本呈现
 * - 所有 action 经确认对话框 + 防重复提交；成功后重新拉取真实数据
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ApiError, api } from "@/lib/api";
import type {
  ReservationOut,
  ReservationUpdate,
  RoomOut,
} from "@/lib/api/types";
import {
  RESERVATION_STATUS_META,
  formatDateTime,
  formatMoney,
} from "@/lib/booking";
import { reservationChannelLabel } from "@/lib/channels";
import { CleaningBadge, OccupancyBadge, StatusBadge } from "@/components/status-badge";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ErrorView, Forbidden, Loading } from "@/components/status-views";
import { useUser } from "@/components/app-shell";
import ReservationForm from "@/components/booking/reservation-form";
import {
  AlertBanner,
  SectionCard,
  dangerButtonClass,
  primaryButtonClass,
  secondaryButtonClass,
} from "@/components/booking/shared";

type ActionKind = "cancel" | "no_show" | "check_in";

const ACTION_LABELS: Record<ActionKind, string> = {
  cancel: "取消预订",
  no_show: "标记未到店",
  check_in: "办理入住",
};

const ACTION_CONFIRMS: Record<ActionKind, string> = {
  cancel: "确定取消该预订吗？取消后预订状态将变为 CANCELLED（不可恢复）。",
  no_show: "确定将客人标记为未到店吗？状态将变为 NO_SHOW（不可恢复）。",
  check_in: "确定为该预订办理入住吗？将创建在住记录并把房间置为在住。",
};

export default function ReservationDetailView({ id }: { id: string }) {
  const router = useRouter();
  const user = useUser();
  const permissions = useMemo(() => new Set(user?.permissions ?? []), [user]);
  const canReadGuest = permissions.has("guest:read");
  const canWriteReservation = permissions.has("reservation:write");
  const canCancel = permissions.has("reservation:cancel");
  const canNoShow = permissions.has("reservation:no_show");
  const canCheckIn = permissions.has("stay:check_in");
  const canReadRooms = permissions.has("room:read");

  const [reservation, setReservation] = useState<ReservationOut | null>(null);
  const [room, setRoom] = useState<RoomOut | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [editing, setEditing] = useState(false);
  const [action, setAction] = useState<ActionKind | null>(null);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ kind: "success" | "conflict"; text: string } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api.reservations
      .get(id)
      .then((data) => {
        if (cancelled) return;
        setReservation(data);
        setEditing(false);
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

  // 房间现场状态（Check-in 前置展示；无 room:read 时隐藏）
  useEffect(() => {
    if (!reservation || !canReadRooms) return;
    let cancelled = false;
    api.rooms
      .get(reservation.room_id)
      .then((data) => {
        if (!cancelled) setRoom(data);
      })
      .catch(() => {
        if (!cancelled) setRoom(null);
      });
    return () => {
      cancelled = true;
    };
  }, [reservation, canReadRooms, reloadKey]);

  const retry = useCallback(() => {
    setError(null);
    setForbidden(false);
    setReservation(null);
    setReloadKey((k) => k + 1);
  }, []);

  async function runAction(kind: ActionKind) {
    if (!reservation || busy) return;
    setBusy(true);
    setBanner(null);
    try {
      if (kind === "check_in") {
        const result = await api.reservations.checkIn(reservation.id);
        const stay = result.stay;
        setReservation(result.reservation);
        setReloadKey((k) => k + 1);
        // 跳转在住详情（展示 Stay 与退房入口）
        router.push(`/stays/${stay.id}`);
        return;
      }
      const updated =
        kind === "cancel"
          ? await api.reservations.cancel(reservation.id)
          : await api.reservations.noShow(reservation.id);
      setReservation(updated);
      setReloadKey((k) => k + 1);
      setBanner({
        kind: "success",
        text:
          kind === "cancel"
            ? "预订已取消（CANCELLED）"
            : "已标记未到店（NO_SHOW）",
      });
    } catch (err) {
      if (err instanceof ApiError && err.kind === "unauthorized") {
        router.replace("/login");
        return;
      }
      // 409 业务冲突：原样展示后端 detail（dirty/occupied/日期资格/已终态等）
      if (err instanceof ApiError && err.kind === "conflict") {
        setBanner({ kind: "conflict", text: err.message });
        return;
      }
      setBanner({
        kind: "conflict",
        text: err instanceof ApiError ? err.message : "操作失败，请稍后重试",
      });
    } finally {
      setBusy(false);
      setAction(null);
    }
  }

  async function handleEditSubmit(payload: ReservationUpdate) {
    if (!reservation) return;
    try {
      const updated = await api.reservations.update(reservation.id, payload);
      setReservation(updated);
      setEditing(false);
      setReloadKey((k) => k + 1);
      setBanner({ kind: "success", text: "预订已更新" });
    } catch (err) {
      if (err instanceof ApiError && err.kind === "forbidden") {
        setForbidden(true);
        return;
      }
      throw err; // 由表单展示 409/422
    }
  }

  if (forbidden) {
    return <Forbidden text="无权限查看预订详情" />;
  }
  if (error) {
    return (
      <div>
        <BackLink />
        <ErrorView
          message={
            error.kind === "not_found" ? "预订不存在或已被删除" : error.message
          }
          offline={error.kind === "network"}
          onRetry={error.kind === "not_found" ? undefined : retry}
        />
      </div>
    );
  }
  if (!reservation) {
    return (
      <div>
        <BackLink />
        <Loading text="正在加载预订详情…" />
      </div>
    );
  }

  const isConfirmed = reservation.status === "CONFIRMED";
  const canEdit = isConfirmed && canWriteReservation;

  const fields: { label: string; value: string }[] = [
    { label: "预订号", value: reservation.reservation_no },
    {
      label: "客人",
      // PII 双保险：无 guest:read 即使字段存在也不渲染姓名
      value:
        canReadGuest && reservation.guest_name
          ? reservation.guest_name
          : `ID ${reservation.guest_id}`,
    },
    {
      label: "房间",
      value: `${reservation.room_number ?? `#${reservation.room_id}`}`,
    },
    {
      label: "房型",
      value: reservation.room_type_name ?? `#${reservation.room_type_id}`,
    },
    { label: "入住日期", value: reservation.check_in_date },
    { label: "退房日期", value: reservation.check_out_date },
    {
      label: "来源渠道",
      value: reservationChannelLabel(reservation.source_channel, reservation.source),
    },
    {
      label: "金额",
      value: formatMoney(
        reservation.agreed_total_amount,
        reservation.currency,
      ),
    },
    {
      label: "外部订单号",
      value: reservation.external_reference || "—",
    },
    { label: "备注", value: reservation.notes || "—" },
    { label: "创建时间", value: formatDateTime(reservation.created_at) },
    { label: "更新时间", value: formatDateTime(reservation.updated_at) },
  ];

  return (
    <div className="mx-auto max-w-4xl">
      <BackLink />

      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">
            预订 {reservation.reservation_no}
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            创建于 {formatDateTime(reservation.created_at)}
          </p>
        </div>
        <StatusBadge meta={RESERVATION_STATUS_META[reservation.status]} />
      </div>

      {banner ? (
        <div className="mb-4">
          <AlertBanner kind={banner.kind}>{banner.text}</AlertBanner>
        </div>
      ) : null}

      {/* 操作区：仅按 status 值 + 权限显隐；状态机校验在后端 */}
      <div className="mb-5 flex flex-wrap gap-2.5">
        {isConfirmed && canEdit && !editing ? (
          <button
            type="button"
            onClick={() => {
              setEditing(true);
              setBanner(null);
            }}
            className={secondaryButtonClass}
          >
            编辑预订
          </button>
        ) : null}
        {isConfirmed && canCheckIn ? (
          <button
            type="button"
            onClick={() => setAction("check_in")}
            disabled={busy}
            className={primaryButtonClass}
          >
            办理入住
          </button>
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
        {reservation.stay_id != null ? (
          <Link href={`/stays/${reservation.stay_id}`} className={secondaryButtonClass}>
            查看入住记录 →
          </Link>
        ) : null}
      </div>

      {/* Check-in 前置信息：房间现场状态 */}
      {canReadRooms && room && room.id === reservation.room_id ? (
        <div className="mb-5 flex flex-wrap items-center gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3 shadow-sm">
          <span className="text-sm text-gray-600">
            房间 {room.room_number} 当前状态：
          </span>
          <OccupancyBadge status={room.occupancy_status} />
          <CleaningBadge status={room.cleaning_status} />
          {isConfirmed && canCheckIn && room.cleaning_status !== "clean" ? (
            <span className="text-xs text-amber-700">
              房间未清洁，办理入住前请先安排保洁
            </span>
          ) : null}
        </div>
      ) : null}

      {editing ? (
        <SectionCard title="编辑预订（CONFIRMED）">
          <ReservationForm
            mode="edit"
            initial={reservation}
            permissions={permissions}
            submitLabel="保存修改"
            onSubmit={handleEditSubmit}
            onCancel={() => {
              setEditing(false);
              setBanner(null);
            }}
          />
        </SectionCard>
      ) : (
        <div className="rounded-lg border border-gray-200 bg-white shadow-sm">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-4 px-5 py-4 sm:grid-cols-2">
            {fields.map((f) => (
              <div key={f.label}>
                <dt className="text-xs text-gray-500">{f.label}</dt>
                <dd className="mt-0.5 break-words text-sm text-gray-900">
                  {f.value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      <ConfirmDialog
        open={action !== null}
        title={action ? ACTION_LABELS[action] : ""}
        message={action ? ACTION_CONFIRMS[action] : ""}
        confirmLabel={action ? ACTION_LABELS[action] : "确认"}
        busy={busy}
        onConfirm={() => {
          if (action) void runAction(action);
        }}
        onCancel={() => setAction(null)}
      />
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/reservations"
      className="mb-4 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900"
    >
      ← 返回预订列表
    </Link>
  );
}
