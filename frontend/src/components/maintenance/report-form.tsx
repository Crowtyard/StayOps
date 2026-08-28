"use client";

/**
 * /maintenance/new 现场报修表单（Sprint 5 §36，Mobile Friendly）：
 * - Room / Category / Severity / Blocks Room? / Title / Description / Submit
 * - 支持 URL 预填：?room_id=&source=HOUSEKEEPING（保洁快捷报修，Sprint 5 §37）
 * - source 可选 MANUAL / FRONT_DESK / HOUSEKEEPING / PRE_OPENING
 *   （PRE_OPENING 用于开业前 28 房整改清单，Sprint 5 §39）
 * - 权限：maintenance_order:write（后端仍为最终权威）
 * - PII：表单与响应不含任何 Guest / Reservation 数据
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ApiError, api } from "@/lib/api";
import type {
  MaintenanceCategory,
  MaintenanceSeverity,
  MaintenanceSource,
  RoomOut,
} from "@/lib/api/types";
import {
  MWO_CATEGORY_LABELS,
  MWO_SEVERITY_META,
  MWO_SOURCE_LABELS,
} from "@/lib/maintenance";
import { Forbidden } from "@/components/status-views";
import { useUser } from "@/components/app-shell";
import {
  Field,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
} from "@/components/booking/shared";

const CATEGORIES = Object.keys(MWO_CATEGORY_LABELS) as MaintenanceCategory[];
const SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as MaintenanceSeverity[];
const SOURCES = ["MANUAL", "FRONT_DESK", "HOUSEKEEPING", "PRE_OPENING"] as MaintenanceSource[];

export interface MaintenanceReportPrefill {
  roomId?: number;
  source?: MaintenanceSource;
}

export default function MaintenanceReportForm({
  prefill,
}: {
  prefill: MaintenanceReportPrefill;
}) {
  const router = useRouter();
  const user = useUser();
  const permissions = useMemo(() => new Set(user?.permissions ?? []), [user]);
  const canWrite = permissions.has("maintenance_order:write");
  const forbidden = !canWrite;

  const [rooms, setRooms] = useState<RoomOut[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [roomId, setRoomId] = useState<number | "">(prefill.roomId ?? "");
  const [category, setCategory] = useState<MaintenanceCategory>("HVAC");
  const [severity, setSeverity] = useState<MaintenanceSeverity>("MEDIUM");
  const [blocksRoom, setBlocksRoom] = useState(false);
  const [source, setSource] = useState<MaintenanceSource>(
    prefill.source ?? "MANUAL",
  );
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (!canWrite) return;
    let cancelled = false;
    api.rooms
      .list({ page: 1, page_size: 100 })
      .then((page) => {
        if (!cancelled) setRooms(page.items);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoadError(
            err instanceof ApiError ? err.message : "房间列表加载失败",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [canWrite]);

  const submit = useCallback(async () => {
    if (submitting) return;
    if (roomId === "") {
      setSubmitError("请选择房间");
      return;
    }
    if (title.trim() === "") {
      setSubmitError("请填写故障标题");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const created = await api.maintenance.create({
        room_id: Number(roomId),
        category,
        severity,
        blocks_room: blocksRoom,
        source,
        title: title.trim(),
        description: description.trim() || null,
      });
      router.replace(`/maintenance/${created.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.kind === "unauthorized") {
        router.replace("/login");
        return;
      }
      // 409 / 422 原文展示（后端最终权威）
      setSubmitError(
        err instanceof ApiError ? err.message : "提交失败，请稍后重试",
      );
    } finally {
      setSubmitting(false);
    }
  }, [
    submitting,
    roomId,
    category,
    severity,
    blocksRoom,
    source,
    title,
    description,
    router,
  ]);

  if (forbidden) {
    return <Forbidden text="无权限报修（缺少 maintenance_order:write）" />;
  }

  return (
    <div className="mx-auto max-w-xl">
      <Link
        href="/maintenance"
        className="mb-4 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900"
      >
        ← 返回维修工作台
      </Link>

      <h1 className="text-xl font-semibold text-gray-900">现场报修</h1>
      <p className="mt-1 text-sm text-gray-500">
        创建维修工单：报修 → 派工 → 维修 → 验收闭环
      </p>

      <div className="mt-5 rounded-lg border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
        <div className="space-y-4">
          <Field label="房间" required error={null}>
            <select
              value={roomId === "" ? "" : String(roomId)}
              onChange={(e) =>
                setRoomId(e.target.value === "" ? "" : Number(e.target.value))
              }
              disabled={submitting || rooms === null}
              className={inputClass}
              aria-label="报修房间"
            >
              <option value="">{rooms === null ? "正在加载房间…" : "选择房间…"}</option>
              {(rooms ?? []).map((room) => (
                <option key={room.id} value={room.id}>
                  {room.room_number}（{room.occupancy_status === "available" ? "可售" : room.occupancy_status} · {room.cleaning_status === "clean" ? "干净" : room.cleaning_status}）
                </option>
              ))}
            </select>
          </Field>

          <Field label="故障分类" required error={null}>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as MaintenanceCategory)}
              disabled={submitting}
              className={inputClass}
              aria-label="故障分类"
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {MWO_CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </Field>

          <Field label="严重程度" required error={null} hint="严重程度与是否阻断客房相互独立">
            <div className="flex flex-wrap gap-2">
              {SEVERITIES.map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={severity === s}
                  disabled={submitting}
                  onClick={() => setSeverity(s)}
                  className={`rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ${
                    severity === s
                      ? "bg-gray-900 text-white"
                      : "border border-gray-300 text-gray-700 hover:bg-gray-50"
                  }`}
                >
                  {MWO_SEVERITY_META[s].label}
                </button>
              ))}
            </div>
          </Field>

          <Field
            label="阻断客房销售"
            error={null}
            hint="开启后，Active 工单将阻止该房间接受新的住宿业务（维修完成并验收前不恢复）"
          >
            <label className="flex items-center gap-2.5">
              <input
                type="checkbox"
                checked={blocksRoom}
                onChange={(e) => setBlocksRoom(e.target.checked)}
                disabled={submitting}
                className="size-4 rounded border-gray-300 text-gray-900 focus:ring-gray-900"
                aria-label="阻断客房销售"
              />
              <span className="text-sm text-gray-700">
                是，该故障阻止房间继续销售（blocks_room）
              </span>
            </label>
          </Field>

          <Field label="报修来源" error={null}>
            <select
              value={source}
              onChange={(e) => setSource(e.target.value as MaintenanceSource)}
              disabled={submitting}
              className={inputClass}
              aria-label="报修来源"
            >
              {SOURCES.map((s) => (
                <option key={s} value={s}>
                  {MWO_SOURCE_LABELS[s]}
                </option>
              ))}
            </select>
          </Field>

          <Field label="故障标题" required error={null}>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={submitting}
              placeholder="例如：空调不制冷"
              maxLength={200}
              className={inputClass}
              aria-label="故障标题"
            />
          </Field>

          <Field label="故障描述" error={null}>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={submitting}
              rows={3}
              placeholder="现场情况描述（可选）"
              maxLength={2000}
              className={inputClass}
              aria-label="故障描述"
            />
          </Field>

          {loadError ? (
            <p role="alert" className="text-sm text-red-600">
              {loadError}
            </p>
          ) : null}
          {submitError ? (
            <p role="alert" className="text-sm text-red-600">
              {submitError}
            </p>
          ) : null}

          <div className="flex justify-end gap-2.5 pt-1">
            <Link href="/maintenance" className={secondaryButtonClass}>
              取消
            </Link>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={submitting}
              className={primaryButtonClass}
            >
              {submitting ? "提交中…" : "提交报修"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
