"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ApiError, api } from "@/lib/api";
import type {
  CleaningStatus,
  OccupancyStatus,
  RoomOut,
} from "@/lib/api/types";
import {
  CLEANING_DIMENSION_LABEL,
  CLEANING_META,
  CLEANING_STATUSES,
  OCCUPANCY_DIMENSION_LABEL,
  OCCUPANCY_META,
  OCCUPANCY_STATUSES,
} from "@/lib/status";
import { CleaningBadge, OccupancyBadge } from "@/components/status-badge";
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

  const canWrite = permissions.has("room:write");
  const canClean = permissions.has("room:status_cleaning");
  const canMaintain = permissions.has("room:status_maintenance");

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
