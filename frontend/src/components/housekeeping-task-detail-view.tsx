"use client";

/**
 * /housekeeping/[id] 保洁任务详情（Sprint 3）：
 * - 任务字段 + 房间现场状态（room:read）+ 操作时间线
 * - 操作（与工作台一致）：start / submit / pass / rework / cancel
 * - 派单（write）：选择用户（可取消派单）；优先级 / 备注编辑（write）
 * - PII：不展示任何 Guest / Reservation 数据
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ApiError, api } from "@/lib/api";
import type {
  HousekeepingAssigneeOut,
  HousekeepingTaskOut,
  RoomOut,
} from "@/lib/api/types";
import {
  HK_PRIORITY_META,
  HK_SOURCE_LABELS,
  HK_TASK_STATUS_META,
} from "@/lib/housekeeping";
import { CleaningBadge, OccupancyBadge, StatusBadge } from "@/components/status-badge";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ErrorView, Forbidden, Loading } from "@/components/status-views";
import { useUser } from "@/components/app-shell";
import {
  Field,
  SectionCard,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
} from "@/components/booking/shared";

type ActionKind = "start" | "submit" | "pass" | "rework" | "cancel";

function formatWhen(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

export default function HousekeepingTaskDetailView({ id }: { id: string }) {
  const router = useRouter();
  const user = useUser();
  const permissions = useMemo(() => new Set(user?.permissions ?? []), [user]);

  const canWrite = permissions.has("housekeeping_task:write");
  const canWork = permissions.has("housekeeping_task:work");
  const canInspect = permissions.has("housekeeping_task:inspect");
  const canCancel = permissions.has("housekeeping_task:cancel");
  const canReadRooms = permissions.has("room:read");
  // Sprint 5 §37：发现设施问题 → 报修（仅 maintenance_order:write 时显示）
  const canReportMaintenance = permissions.has("maintenance_order:write");

  const [task, setTask] = useState<HousekeepingTaskOut | null>(null);
  const [room, setRoom] = useState<RoomOut | null>(null);
  const [assignees, setAssignees] = useState<HousekeepingAssigneeOut[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const [confirming, setConfirming] = useState<ActionKind | null>(null);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ kind: "success" | "conflict"; text: string } | null>(null);

  // 派单 / 编辑（write）
  const [assigneeId, setAssigneeId] = useState<number | "">("");
  const [priority, setPriority] = useState<"NORMAL" | "URGENT">("NORMAL");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.housekeeping
      .get(id)
      .then((data) => {
        if (cancelled) return;
        setTask(data);
        setAssigneeId(data.assigned_to_user_id ?? "");
        setPriority(data.priority);
        setNotes(data.notes ?? "");
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

  // 房间现场状态（无 room:read 不请求）
  useEffect(() => {
    if (!task || !canReadRooms) return;
    let cancelled = false;
    api.rooms
      .get(task.room_id)
      .then((data) => {
        if (!cancelled) setRoom(data);
      })
      .catch(() => {
        if (!cancelled) setRoom(null);
      });
    return () => {
      cancelled = true;
    };
  }, [task, canReadRooms, reloadKey]);

  // 派单候选人（housekeeping_task:write；无需 user:read；失败不阻塞）
  useEffect(() => {
    if (!task || !canWrite) return;
    let cancelled = false;
    api.housekeeping
      .assignees()
      .then((list) => {
        if (!cancelled) setAssignees(list);
      })
      .catch(() => {
        if (!cancelled) setAssignees([]);
      });
    return () => {
      cancelled = true;
    };
  }, [task, canWrite]);

  const retry = useCallback(() => {
    setError(null);
    setForbidden(false);
    setTask(null);
    setReloadKey((k) => k + 1);
  }, []);

  async function runAction(kind: ActionKind) {
    if (!task || busy) return;
    setBusy(true);
    setBanner(null);
    try {
      if (kind === "start") await api.housekeeping.start(task.id);
      else if (kind === "submit") await api.housekeeping.submitInspection(task.id);
      else if (kind === "pass") await api.housekeeping.pass(task.id);
      else if (kind === "rework") await api.housekeeping.rework(task.id);
      else if (kind === "cancel") await api.housekeeping.cancel(task.id);
      setBanner({
        kind: "success",
        text:
          kind === "start"
            ? "已开始清扫"
            : kind === "submit"
              ? "已提交验房"
              : kind === "pass"
                ? "验收通过，翻房完成"
                : kind === "rework"
                  ? "已标记返工"
                  : "任务已取消",
      });
      setReloadKey((k) => k + 1);
    } catch (err) {
      if (err instanceof ApiError && err.kind === "unauthorized") {
        router.replace("/login");
        return;
      }
      setBanner({
        kind: "conflict",
        text: err instanceof ApiError ? err.message : "操作失败，请稍后重试",
      });
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  }

  async function saveEdits() {
    if (!task || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const payload: {
        priority?: "NORMAL" | "URGENT";
        assigned_to_user_id?: number | null;
        notes?: string | null;
      } = {};
      if (priority !== task.priority) payload.priority = priority;
      if (notes.trim() !== (task.notes ?? "")) payload.notes = notes.trim() || null;
      const targetAssignee = assigneeId === "" ? null : Number(assigneeId);
      if (targetAssignee !== (task.assigned_to_user_id ?? null)) {
        payload.assigned_to_user_id = targetAssignee;
      }
      if (Object.keys(payload).length === 0) {
        setSaveError("没有需要保存的变更");
        return;
      }
      const updated = await api.housekeeping.update(task.id, payload);
      setTask(updated);
      setAssigneeId(updated.assigned_to_user_id ?? "");
      setPriority(updated.priority);
      setNotes(updated.notes ?? "");
      setBanner({ kind: "success", text: "已保存" });
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "保存失败，请稍后重试");
    } finally {
      setSaving(false);
    }
  }

  if (forbidden) {
    return <Forbidden text="无权限查看保洁任务" />;
  }
  if (error) {
    return (
      <div>
        <BackLink />
        <ErrorView
          message={error.kind === "not_found" ? "保洁任务不存在或已被删除" : error.message}
          offline={error.kind === "network"}
          onRetry={error.kind === "not_found" ? undefined : retry}
        />
      </div>
    );
  }
  if (!task) {
    return (
      <div>
        <BackLink />
        <Loading text="正在加载保洁任务…" />
      </div>
    );
  }

  const active = ["PENDING", "IN_PROGRESS", "INSPECTION", "REWORK"].includes(task.status);

  return (
    <div className="mx-auto max-w-4xl">
      <BackLink />

      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">
            保洁任务 {task.task_no}
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            房间 {task.room_number} · {HK_SOURCE_LABELS[task.source]} · 创建于 {formatWhen(task.created_at)}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <StatusBadge meta={HK_TASK_STATUS_META[task.status]} />
          <StatusBadge meta={HK_PRIORITY_META[task.priority]} />
        </div>
      </div>

      {banner ? (
        <div
          role={banner.kind === "success" ? "status" : "alert"}
          className={`mb-4 rounded-md px-3 py-2 text-sm ring-1 ring-inset ${
            banner.kind === "success"
              ? "bg-emerald-50 text-emerald-800 ring-emerald-200"
              : "bg-amber-50 text-amber-900 ring-amber-300"
          }`}
        >
          {banner.text}
        </div>
      ) : null}

      {/* 操作区：仅按 status 值 + 权限显隐；状态机校验在后端 */}
      <div className="mb-5 flex flex-wrap gap-2.5">
        {(task.status === "PENDING" || task.status === "REWORK") && canWork ? (
          <button type="button" disabled={busy} onClick={() => setConfirming("start")} className={primaryButtonClass}>
            开始清扫
          </button>
        ) : null}
        {task.status === "IN_PROGRESS" && canWork ? (
          <button type="button" disabled={busy} onClick={() => setConfirming("submit")} className={primaryButtonClass}>
            提交验房
          </button>
        ) : null}
        {task.status === "INSPECTION" && canInspect ? (
          <>
            <button type="button" disabled={busy} onClick={() => setConfirming("pass")} className={primaryButtonClass}>
              验收通过
            </button>
            <button type="button" disabled={busy} onClick={() => setConfirming("rework")} className={secondaryButtonClass}>
              返工
            </button>
          </>
        ) : null}
        {active && canCancel ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirming("cancel")}
            className="rounded-md border border-red-200 px-3.5 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
          >
            取消任务
          </button>
        ) : null}
      </div>

      <div className="space-y-5">
        <SectionCard title="任务信息">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
            <Info label="保洁员" value={task.assignee_name ?? "未指派"} />
            <Info label="备注" value={task.notes || "—"} />
            <Info label="开始清扫" value={formatWhen(task.started_at)} />
            <Info label="提交验房" value={formatWhen(task.submitted_for_inspection_at)} />
            <Info label="完成时间" value={formatWhen(task.completed_at)} />
            <Info label="取消时间" value={formatWhen(task.cancelled_at)} />
          </dl>
        </SectionCard>

        {canReadRooms && room ? (
          <SectionCard
            title="房间现场状态"
            action={
              canReportMaintenance ? (
                <Link
                  href={`/maintenance/new?room_id=${task.room_id}&source=HOUSEKEEPING`}
                  className="inline-flex items-center gap-1 rounded-md border border-amber-300 px-2.5 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-50"
                >
                  发现设施问题 → 报修
                </Link>
              ) : undefined
            }
          >
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm text-gray-600">房间 {room.room_number}：</span>
              <OccupancyBadge status={room.occupancy_status} />
              <CleaningBadge status={room.cleaning_status} />
            </div>
          </SectionCard>
        ) : null}

        {canWrite && active ? (
          <SectionCard title="派单与调整">
            <div className="space-y-4">
              <Field label="保洁员（选择“未指派”即取消派单）" error={null}>
                <select
                  value={assigneeId === "" ? "" : String(assigneeId)}
                  onChange={(e) =>
                    setAssigneeId(e.target.value === "" ? "" : Number(e.target.value))
                  }
                  disabled={saving}
                  className={inputClass}
                  aria-label="指派保洁员"
                >
                  <option value="">未指派</option>
                  {(assignees ?? []).map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.display_name}（{a.username}）
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="优先级" error={null}>
                <select
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as "NORMAL" | "URGENT")}
                  disabled={saving}
                  className={inputClass}
                  aria-label="任务优先级"
                >
                  <option value="NORMAL">普通</option>
                  <option value="URGENT">加急</option>
                </select>
              </Field>
              <Field label="备注" error={null}>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  disabled={saving}
                  rows={3}
                  className={inputClass}
                  aria-label="任务备注"
                />
              </Field>
              {saveError ? (
                <p role="alert" className="text-sm text-red-600">
                  {saveError}
                </p>
              ) : null}
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => void saveEdits()}
                  disabled={saving}
                  className={primaryButtonClass}
                >
                  {saving ? "保存中…" : "保存"}
                </button>
              </div>
            </div>
          </SectionCard>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirming !== null}
        title={
          confirming === "start"
            ? "开始清扫"
            : confirming === "submit"
              ? "提交验房"
              : confirming === "pass"
                ? "验收通过"
                : confirming === "rework"
                  ? "返工"
                  : "取消任务"
        }
        message={
          confirming === "pass"
            ? `确定房间 ${task.room_number} 验收通过吗？房间将变为干净并可再次入住。`
            : confirming === "rework"
              ? `确定将房间 ${task.room_number} 标记为返工吗？`
              : confirming === "cancel"
                ? `确定取消任务 ${task.task_no} 吗？房间将保持待清扫。`
                : `确定对房间 ${task.room_number} 执行该操作吗？`
        }
        confirmLabel={
          confirming === "start"
            ? "开始清扫"
            : confirming === "submit"
              ? "提交验房"
              : confirming === "pass"
                ? "确认通过"
                : confirming === "rework"
                  ? "确认返工"
                  : "确认取消"
        }
        busy={busy}
        onConfirm={() => {
          if (confirming) void runAction(confirming);
        }}
        onCancel={() => setConfirming(null)}
      />
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-gray-900">{value}</dd>
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/housekeeping"
      className="mb-4 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900"
    >
      ← 返回保洁工作台
    </Link>
  );
}
