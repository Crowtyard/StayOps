"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ApiError, api } from "@/lib/api";
import type {
  CleaningStatus,
  HousekeepingTaskOut,
  OccupancyStatus,
  ReservationOut,
  RoomOut,
  StayOut,
} from "@/lib/api/types";
import { businessDate } from "@/lib/booking";
import {
  HK_PRIORITY_META,
  HK_TASK_STATUS_META,
} from "@/lib/housekeeping";
import {
  CLEANING_DIMENSION_LABEL,
  CLEANING_META,
  CLEANING_STATUSES,
  OCCUPANCY_DIMENSION_LABEL,
  OCCUPANCY_META,
  OCCUPANCY_STATUSES,
} from "@/lib/status";
import { CleaningBadge, OccupancyBadge, StatusBadge } from "@/components/status-badge";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ErrorView, Loading } from "@/components/status-views";
import { useUser } from "@/components/app-shell";

interface ConfirmTarget {
  kind: "occupancy" | "cleaning";
  to: OccupancyStatus | CleaningStatus;
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

export default function RoomDetailView({ id }: { id: string }) {
  const router = useRouter();
  const user = useUser();
  const permissions = useMemo(() => new Set(user?.permissions ?? []), [user]);

  const [room, setRoom] = useState<RoomOut | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [occupancyValue, setOccupancyValue] = useState<OccupancyStatus | "">("");
  const [cleaningValue, setCleaningValue] = useState<CleaningStatus | "">("");
  const [busyDimension, setBusyDimension] = useState<"occupancy" | "cleaning" | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<ConfirmTarget | null>(null);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Booking 关联（S2-T2）：当前 Stay / 下一笔 Reservation（PII 按权限）
  const [activeStay, setActiveStay] = useState<StayOut | null>(null);
  const [nextReservation, setNextReservation] = useState<ReservationOut | null>(null);

  // Housekeeping 关联（S3）：进行中保洁任务（无 housekeeping_task:read 不请求）
  const [activeTask, setActiveTask] = useState<HousekeepingTaskOut | null>(null);

  const canWrite = permissions.has("room:write");
  const canClean = permissions.has("room:status_cleaning");
  const canMaintain = permissions.has("room:status_maintenance");
  const canReadStay = permissions.has("stay:read");
  const canReadReservation = permissions.has("reservation:read");
  const canReadGuest = permissions.has("guest:read");
  const canReadHousekeepingTask = permissions.has("housekeeping_task:read");

  const occupancyOptions = useMemo<OccupancyStatus[]>(() => {
    if (canWrite) return OCCUPANCY_STATUSES;
    if (canMaintain) return ["out_of_service"];
    return [];
  }, [canWrite, canMaintain]);

  const cleaningOptions = useMemo<CleaningStatus[]>(() => {
    if (canWrite || canClean) return CLEANING_STATUSES;
    return [];
  }, [canWrite, canClean]);

  useEffect(() => {
    let cancelled = false;
    api.rooms
      .get(id)
      .then((data) => {
        if (cancelled) return;
        setRoom(data);
        setOccupancyValue(data.occupancy_status);
        setCleaningValue(data.cleaning_status);
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
  }, [router, id, reloadKey]);

  const retry = useCallback(() => {
    setError(null);
    setRoom(null);
    setMessage(null);
    setReloadKey((k) => k + 1);
  }, []);

  // 当前 Stay（stay:read）与下一笔 Reservation（reservation:read）摘要；
  // 调用失败（403/网络）静默隐藏区块，不阻塞房间详情主体
  useEffect(() => {
    if (!room || (!canReadStay && !canReadReservation)) return;
    let cancelled = false;
    if (canReadStay) {
      api.stays
        .list({ room_id: room.id, status: "ACTIVE", page: 1, page_size: 10 })
        .then((page) => {
          if (!cancelled) setActiveStay(page.items[0] ?? null);
        })
        .catch(() => {
          if (!cancelled) setActiveStay(null);
        });
    }
    if (canReadReservation) {
      api.reservations
        .list({
          room_id: room.id,
          status: "CONFIRMED",
          page: 1,
          page_size: 100,
        })
        .then((page) => {
          if (cancelled) return;
          const today = businessDate();
          const upcoming = page.items
            .filter((r) => r.check_in_date >= today)
            .sort((a, b) => a.check_in_date.localeCompare(b.check_in_date));
          setNextReservation(upcoming[0] ?? null);
        })
        .catch(() => {
          if (!cancelled) setNextReservation(null);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [room, canReadStay, canReadReservation, reloadKey]);

  // 进行中保洁任务摘要（housekeeping_task:read）；403/网络静默隐藏，不阻塞主体
  useEffect(() => {
    if (!room || !canReadHousekeepingTask) return;
    let cancelled = false;
    api.housekeeping
      .list({ room_id: room.id, page: 1, page_size: 10 })
      .then((page) => {
        if (cancelled) return;
        const active = page.items.find((t) =>
          ["PENDING", "IN_PROGRESS", "INSPECTION", "REWORK"].includes(t.status),
        );
        setActiveTask(active ?? null);
      })
      .catch(() => {
        if (!cancelled) setActiveTask(null);
      });
    return () => {
      cancelled = true;
    };
  }, [room, canReadHousekeepingTask, reloadKey]);

  async function submitChange(
    dimension: "occupancy" | "cleaning",
    value: OccupancyStatus | CleaningStatus,
  ) {
    if (!room || busyDimension) return;
    setBusyDimension(dimension);
    setMessage(null);
    try {
      const body =
        dimension === "occupancy"
          ? { occupancy_status: value as OccupancyStatus }
          : { cleaning_status: value as CleaningStatus };
      const updated = await api.rooms.changeStatus(room.id, body);
      setRoom(updated);
      setOccupancyValue(updated.occupancy_status);
      setCleaningValue(updated.cleaning_status);
      setMessage({
        kind: "success",
        text: `${dimension === "occupancy" ? OCCUPANCY_DIMENSION_LABEL : CLEANING_DIMENSION_LABEL}已更新为「${
          dimension === "occupancy"
            ? OCCUPANCY_META[value as OccupancyStatus].label
            : CLEANING_META[value as CleaningStatus].label
        }」`,
      });
    } catch (err) {
      if (err instanceof ApiError && err.kind === "unauthorized") {
        router.replace("/login");
        return;
      }
      setMessage({
        kind: "error",
        text:
          err instanceof ApiError
            ? err.message
            : "状态更新失败，请稍后重试",
      });
    } finally {
      setBusyDimension(null);
    }
  }

  function requestChange(
    dimension: "occupancy" | "cleaning",
    value: OccupancyStatus | CleaningStatus,
  ) {
    if (!room) return;
    const isOccupancy = dimension === "occupancy";
    const current = isOccupancy ? room.occupancy_status : room.cleaning_status;
    if (value === current) return;

    // blocked / out_of_service 变更需确认
    const needsConfirm =
      isOccupancy &&
      (value === "blocked" || value === "out_of_service");
    if (needsConfirm) {
      setConfirmTarget({ kind: "occupancy", to: value as OccupancyStatus });
      return;
    }
    void submitChange(dimension, value);
  }

  function confirmAndSubmit() {
    if (!confirmTarget) return;
    const { kind, to } = confirmTarget;
    setConfirmTarget(null);
    void submitChange(kind, to);
  }

  if (error) {
    return (
      <div>
        <BackLink />
        <ErrorView
          message={error.kind === "not_found" ? "房间不存在或已被删除" : error.message}
          offline={error.kind === "network"}
          onRetry={error.kind === "not_found" ? undefined : retry}
        />
      </div>
    );
  }

  if (!room) {
    return (
      <div>
        <BackLink />
        <Loading text="正在加载房间详情…" />
      </div>
    );
  }

  const fields: { label: string; value: string }[] = [
    { label: "房号", value: room.room_number },
    { label: "房型", value: room.room_type?.name ?? `房型 #${room.room_type_id}` },
    { label: "楼层", value: `${room.floor} 楼` },
    { label: "备注", value: room.notes || "—" },
    { label: "创建时间", value: formatDateTime(room.created_at) },
    { label: "更新时间", value: formatDateTime(room.updated_at) },
  ];

  const occupancyCurrent = room.occupancy_status;
  const cleaningCurrent = room.cleaning_status;

  return (
    <div className="mx-auto max-w-3xl">
      <BackLink />

      <div className="rounded-lg border border-gray-200 bg-white shadow-sm">
        <div className="flex items-center justify-between gap-3 border-b border-gray-200 px-5 py-4">
          <div>
            <h1 className="text-lg font-semibold text-gray-900">
              房间 {room.room_number}
            </h1>
            <p className="mt-0.5 text-sm text-gray-500">
              {room.floor} 楼 · {room.room_type?.name ?? `房型 #${room.room_type_id}`}
            </p>
          </div>
          <div className="flex flex-wrap justify-end gap-1.5">
            <OccupancyBadge status={occupancyCurrent} />
            <CleaningBadge status={cleaningCurrent} />
          </div>
        </div>

        <dl className="grid grid-cols-1 gap-x-6 gap-y-4 px-5 py-4 sm:grid-cols-2">
          {fields.map((f) => (
            <div key={f.label}>
              <dt className="text-xs text-gray-500">{f.label}</dt>
              <dd className="mt-0.5 break-words text-sm text-gray-900">{f.value}</dd>
            </div>
          ))}
        </dl>

        {/* 状态修改区（真实后端状态机 + 权限） */}
        <div className="border-t border-gray-200 px-5 py-4">
          <h2 className="text-sm font-semibold text-gray-900">状态修改</h2>
          <p className="mt-1 text-xs text-gray-500">
            状态由后端状态机校验：非法转换会直接显示后端返回的错误
          </p>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <StatusChangeForm
              testId="occupancy-status-form"
              dimensionLabel={OCCUPANCY_DIMENSION_LABEL}
              current={occupancyCurrent}
              options={occupancyOptions}
              value={occupancyValue}
              onValueChange={(v) => setOccupancyValue(v as OccupancyStatus | "")}
              onSubmit={(v) => requestChange("occupancy", v)}
              busy={busyDimension === "occupancy"}
              disabledReason={
                occupancyOptions.length === 0 ? "无权限修改占用状态" : null
              }
              meta={OCCUPANCY_META}
            />
            <StatusChangeForm
              testId="cleaning-status-form"
              dimensionLabel={CLEANING_DIMENSION_LABEL}
              current={cleaningCurrent}
              options={cleaningOptions}
              value={cleaningValue}
              onValueChange={(v) => setCleaningValue(v as CleaningStatus | "")}
              onSubmit={(v) => requestChange("cleaning", v)}
              busy={busyDimension === "cleaning"}
              disabledReason={
                cleaningOptions.length === 0 ? "无权限修改清洁状态" : null
              }
              meta={CLEANING_META}
            />
          </div>

          {message ? (
            <p
              role={message.kind === "error" ? "alert" : "status"}
              className={`mt-4 rounded-md px-3 py-2 text-sm ring-1 ring-inset ${
                message.kind === "success"
                  ? "bg-emerald-50 text-emerald-800 ring-emerald-200"
                  : "bg-red-50 text-red-700 ring-red-200"
              }`}
            >
              {message.text}
            </p>
          ) : null}
        </div>
      </div>

      {/* Booking 关联（S2-T2）：当前 Stay / 下一笔 Reservation，PII 按权限 */}
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        {canReadStay && activeStay && activeStay.room_id === room.id ? (
          <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-gray-900">当前在住</h2>
            <dl className="mt-2 space-y-1 text-sm text-gray-700">
              <div>
                <dt className="inline text-xs text-gray-500">入住单号：</dt>
                <dd className="inline">
                  <Link
                    href={`/stays/${activeStay.id}`}
                    className="font-medium hover:underline"
                  >
                    {activeStay.stay_no}
                  </Link>
                </dd>
              </div>
              <div>
                <dt className="inline text-xs text-gray-500">实际入住：</dt>
                <dd className="inline">
                  {formatDateTime(activeStay.actual_check_in_at)}
                </dd>
              </div>
              <div>
                <dt className="inline text-xs text-gray-500">计划退房：</dt>
                <dd className="inline">{activeStay.planned_check_out_date}</dd>
              </div>
            </dl>
          </div>
        ) : !canReadStay && room.occupancy_status === "occupied" ? (
          <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-gray-900">当前有客</h2>
            <p className="mt-2 text-sm text-gray-500">房间正在被客人使用</p>
          </div>
        ) : null}

        {canReadReservation &&
        nextReservation &&
        nextReservation.room_id === room.id ? (
          <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-gray-900">下一笔预订</h2>
            <dl className="mt-2 space-y-1 text-sm text-gray-700">
              <div>
                <dt className="inline text-xs text-gray-500">预订号：</dt>
                <dd className="inline">
                  <Link
                    href={`/reservations/${nextReservation.id}`}
                    className="font-medium hover:underline"
                  >
                    {nextReservation.reservation_no}
                  </Link>
                </dd>
              </div>
              <div>
                <dt className="inline text-xs text-gray-500">日期：</dt>
                <dd className="inline">
                  {nextReservation.check_in_date} →{" "}
                  {nextReservation.check_out_date}
                </dd>
              </div>
              <div>
                <dt className="inline text-xs text-gray-500">来源：</dt>
                <dd className="inline">{nextReservation.source}</dd>
              </div>
              {canReadGuest && nextReservation.guest_name ? (
                <div>
                  <dt className="inline text-xs text-gray-500">客人：</dt>
                  <dd className="inline">{nextReservation.guest_name}</dd>
                </div>
              ) : null}
            </dl>
          </div>
        ) : null}

        {/* 保洁任务摘要（S3）：仅 housekeeping_task:read；不含任何 PII */}
        {canReadHousekeepingTask &&
        activeTask &&
        activeTask.room_id === room.id ? (
          <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-gray-900">保洁任务</h2>
              <StatusBadge meta={HK_TASK_STATUS_META[activeTask.status]} />
            </div>
            <dl className="mt-2 space-y-1 text-sm text-gray-700">
              <div>
                <dt className="inline text-xs text-gray-500">任务号：</dt>
                <dd className="inline">
                  <Link
                    href={`/housekeeping/${activeTask.id}`}
                    className="font-medium hover:underline"
                  >
                    {activeTask.task_no}
                  </Link>
                </dd>
              </div>
              <div>
                <dt className="inline text-xs text-gray-500">优先级：</dt>
                <dd className="inline">
                  {HK_PRIORITY_META[activeTask.priority].label}
                </dd>
              </div>
              <div>
                <dt className="inline text-xs text-gray-500">保洁员：</dt>
                <dd className="inline">{activeTask.assignee_name ?? "未指派"}</dd>
              </div>
            </dl>
          </div>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirmTarget !== null}
        title="确认状态变更"
        message={`确定要将占用状态变更为「${
          confirmTarget
            ? OCCUPANCY_META[confirmTarget.to as OccupancyStatus].label
            : ""
        }」吗？`}
        confirmLabel="确认变更"
        busy={busyDimension !== null}
        onConfirm={confirmAndSubmit}
        onCancel={() => setConfirmTarget(null)}
      />
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/rooms"
      className="mb-4 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900"
    >
      ← 返回房态棋盘
    </Link>
  );
}

interface StatusChangeFormProps<T extends string> {
  testId: string;
  dimensionLabel: string;
  current: T;
  options: T[];
  value: T | "";
  onValueChange: (v: T | "") => void;
  onSubmit: (v: T) => void;
  busy: boolean;
  disabledReason: string | null;
  meta: Record<string, { label: string }>;
}

function StatusChangeForm<T extends string>({
  testId,
  dimensionLabel,
  current,
  options,
  value,
  onValueChange,
  onSubmit,
  busy,
  disabledReason,
  meta,
}: StatusChangeFormProps<T>) {
  const currentLabel = meta[current]?.label ?? current;
  const selected = value === "" ? "" : value;
  const sameAsCurrent = selected === current;

  return (
    <div className="rounded-md border border-gray-200 p-4" data-testid={testId}>
      <p className="mb-2 text-sm font-medium text-gray-900">{dimensionLabel}</p>
      <p className="mb-3 text-xs text-gray-500">
        当前：<span className="font-medium text-gray-800">{currentLabel}</span>
      </p>
      {disabledReason ? (
        <p className="rounded-md bg-gray-50 px-3 py-2 text-xs text-gray-500">
          {disabledReason}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={`${dimensionLabel}-select`} className="sr-only">
            修改{dimensionLabel}
          </label>
          <select
            id={`${dimensionLabel}-select`}
            value={selected}
            onChange={(e) => onValueChange(e.target.value as T | "")}
            className="min-w-36 flex-1 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
          >
            <option value="">选择新状态…</option>
            {options
              .filter((o) => o !== current)
              .map((o) => (
                <option key={o} value={o}>
                  {meta[o]?.label ?? o}
                </option>
              ))}
          </select>
          <button
            type="button"
            disabled={busy || selected === "" || sameAsCurrent}
            onClick={() => onSubmit(selected as T)}
            className="rounded-md bg-gray-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "提交中…" : "应用"}
          </button>
        </div>
      )}
    </div>
  );
}
