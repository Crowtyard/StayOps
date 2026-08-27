"use client";

/**
 * /housekeeping 保洁运营工作台（Sprint 3）：
 * - 状态视图：待清扫 / 清扫中 / 待验房 / 返工 / 已完成（+ 全部）
 * - 任务列表：房间号 / 状态 / 优先级 / 保洁员 / 更新时间；手机可操作
 * - 快捷操作（一到两次点击）：
 *   PENDING → 开始清扫（work）；IN_PROGRESS → 提交验房（work）
 *   INSPECTION → 通过 / 返工（inspect，确认对话框）
 * - 新建任务（write）：选择待清扫房间 + 优先级 + 备注
 * - 权限：housekeeping_task:read（403 → Forbidden 视图，不跳登录）
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ApiError, api } from "@/lib/api";
import type {
  HousekeepingTaskOut,
  HousekeepingTaskStatus,
  RoomOut,
} from "@/lib/api/types";
import {
  HK_PRIORITY_META,
  HK_TASK_STATUS_META,
} from "@/lib/housekeeping";
import { StatusBadge } from "@/components/status-badge";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Modal } from "@/components/modal";
import { Empty, ErrorView, Forbidden, Loading } from "@/components/status-views";
import { useUser } from "@/components/app-shell";
import {
  Field,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
} from "@/components/booking/shared";

const PAGE_SIZE = 20;

type StatusFilter = HousekeepingTaskStatus | "";

const FILTER_TABS: { value: StatusFilter; label: string }[] = [
  { value: "", label: "全部" },
  { value: "PENDING", label: "待清扫" },
  { value: "IN_PROGRESS", label: "清扫中" },
  { value: "INSPECTION", label: "待验房" },
  { value: "REWORK", label: "返工" },
  { value: "COMPLETED", label: "已完成" },
];

type ActionKind = "start" | "submit" | "pass" | "rework" | "cancel";

function formatWhen(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

export default function HousekeepingWorkspaceView() {
  const router = useRouter();
  const user = useUser();
  const permissions = useMemo(() => new Set(user?.permissions ?? []), [user]);

  const canWrite = permissions.has("housekeeping_task:write");
  const canWork = permissions.has("housekeeping_task:work");
  const canInspect = permissions.has("housekeeping_task:inspect");
  const canCancel = permissions.has("housekeeping_task:cancel");

  const [items, setItems] = useState<HousekeepingTaskOut[] | null>(null);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<StatusFilter>("");
  const [error, setError] = useState<ApiError | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const [actionTask, setActionTask] = useState<HousekeepingTaskOut | null>(null);
  const [actionKind, setActionKind] = useState<ActionKind | null>(null);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ kind: "success" | "conflict"; text: string } | null>(null);

  // 新建任务（write）
  const [createOpen, setCreateOpen] = useState(false);
  const [dirtyRooms, setDirtyRooms] = useState<RoomOut[] | null>(null);
  const [createRoomId, setCreateRoomId] = useState<number | "">("");
  const [createPriority, setCreatePriority] = useState<"NORMAL" | "URGENT">("NORMAL");
  const [createNotes, setCreateNotes] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.housekeeping
      .list({ page: 1, page_size: PAGE_SIZE, status: status || undefined })
      .then((result) => {
        if (cancelled) return;
        setItems(result.items);
        setTotal(result.total);
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
  }, [router, status, reloadKey]);

  const retry = useCallback(() => {
    setError(null);
    setForbidden(false);
    setItems(null);
    setReloadKey((k) => k + 1);
  }, []);

  async function runAction(task: HousekeepingTaskOut, kind: ActionKind) {
    if (busy) return;
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
            ? `房间 ${task.room_number} 已开始清扫`
            : kind === "submit"
              ? `房间 ${task.room_number} 已提交验房`
              : kind === "pass"
                ? `房间 ${task.room_number} 验收通过，翻房完成`
                : kind === "rework"
                  ? `房间 ${task.room_number} 已标记返工`
                  : `任务 ${task.task_no} 已取消`,
      });
      setReloadKey((k) => k + 1);
    } catch (err) {
      if (err instanceof ApiError && err.kind === "unauthorized") {
        router.replace("/login");
        return;
      }
      // 409 原文展示（状态机/并发冲突），不被吞掉
      setBanner({
        kind: "conflict",
        text: err instanceof ApiError ? err.message : "操作失败，请稍后重试",
      });
    } finally {
      setBusy(false);
      setActionTask(null);
      setActionKind(null);
    }
  }

  function requestAction(task: HousekeepingTaskOut, kind: ActionKind) {
    setBanner(null);
    // pass / rework / cancel 需确认；start / submit 一键直达
    if (kind === "pass" || kind === "rework" || kind === "cancel") {
      setActionTask(task);
      setActionKind(kind);
      return;
    }
    void runAction(task, kind);
  }

  async function openCreateModal() {
    setCreateOpen(true);
    setCreateError(null);
    setDirtyRooms(null);
    try {
      const page = await api.rooms.list({
        cleaning_status: "dirty",
        page: 1,
        page_size: 100,
      });
      setDirtyRooms(page.items);
    } catch {
      setDirtyRooms([]);
    }
  }

  async function submitCreate() {
    if (createRoomId === "") {
      setCreateError("请选择待清扫房间");
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const created = await api.housekeeping.create({
        room_id: Number(createRoomId),
        priority: createPriority,
        notes: createNotes.trim() || null,
      });
      setCreateOpen(false);
      setCreateRoomId("");
      setCreatePriority("NORMAL");
      setCreateNotes("");
      setBanner({ kind: "success", text: `已创建任务 ${created.task_no}` });
      setReloadKey((k) => k + 1);
      router.push(`/housekeeping/${created.id}`);
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "创建失败，请稍后重试");
    } finally {
      setCreating(false);
    }
  }

  if (forbidden) {
    return <Forbidden text="无权限查看保洁任务" />;
  }
  if (error) {
    return (
      <ErrorView
        message={error.message}
        offline={error.kind === "network"}
        onRetry={retry}
      />
    );
  }

  const confirmMeta =
    actionKind === "pass"
      ? { title: "验收通过", message: `确定房间 ${actionTask?.room_number ?? ""} 验收通过吗？房间将变为干净并可再次入住。`, label: "确认通过" }
      : actionKind === "rework"
        ? { title: "返工", message: `确定将房间 ${actionTask?.room_number ?? ""} 标记为返工吗？` , label: "确认返工" }
        : { title: "取消任务", message: `确定取消任务 ${actionTask?.task_no ?? ""} 吗？房间将保持待清扫。`, label: "确认取消" };

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">保洁运营</h1>
          <p className="mt-1 text-sm text-gray-500">
            房间翻房闭环：待清扫 → 清扫中 → 待验房 → 通过 / 返工
          </p>
        </div>
        {canWrite ? (
          <button
            type="button"
            onClick={() => void openCreateModal()}
            className={primaryButtonClass}
          >
            新建任务
          </button>
        ) : null}
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

      {/* 状态筛选（真实后端查询参数） */}
      <div className="mb-4 flex flex-wrap gap-2">
        {FILTER_TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            aria-pressed={status === tab.value}
            onClick={() => setStatus(tab.value)}
            className={`rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ${
              status === tab.value
                ? "bg-gray-900 text-white"
                : "border border-gray-300 text-gray-700 hover:bg-gray-50"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {items === null ? (
        <Loading text="正在加载保洁任务…" />
      ) : items.length === 0 ? (
        <Empty text={status === "" ? "暂无保洁任务" : `当前没有「${FILTER_TABS.find((t) => t.value === status)?.label}」任务`} />
      ) : (
        <>
          <p className="mb-3 text-sm text-gray-500">共 {total} 条任务</p>
          <ul className="list-none space-y-3">
            {items.map((task) => (
              <li
                key={task.id}
                className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <Link
                      href={`/housekeeping/${task.id}`}
                      className="text-base font-semibold text-gray-900 hover:underline"
                    >
                      房间 {task.room_number}
                    </Link>
                    <p className="mt-0.5 text-xs text-gray-500">
                      {task.task_no} · {task.source === "CHECKOUT" ? "退房自动" : "手动创建"} ·
                      更新于 {formatWhen(task.updated_at)}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <StatusBadge meta={HK_TASK_STATUS_META[task.status]} />
                    <StatusBadge meta={HK_PRIORITY_META[task.priority]} />
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm text-gray-600">
                    保洁员：
                    <span className="font-medium text-gray-900">
                      {task.assignee_name ?? "未指派"}
                    </span>
                    {task.started_at ? (
                      <span className="ml-3 text-xs text-gray-400">
                        开始 {formatWhen(task.started_at)}
                      </span>
                    ) : null}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {(task.status === "PENDING" || task.status === "REWORK") &&
                    canWork ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => requestAction(task, "start")}
                        className={primaryButtonClass}
                      >
                        开始清扫
                      </button>
                    ) : null}
                    {task.status === "IN_PROGRESS" && canWork ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => requestAction(task, "submit")}
                        className={primaryButtonClass}
                      >
                        提交验房
                      </button>
                    ) : null}
                    {task.status === "INSPECTION" && canInspect ? (
                      <>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => requestAction(task, "pass")}
                          className={primaryButtonClass}
                        >
                          通过
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => requestAction(task, "rework")}
                          className={secondaryButtonClass}
                        >
                          返工
                        </button>
                      </>
                    ) : null}
                    {canCancel &&
                    ["PENDING", "IN_PROGRESS", "INSPECTION", "REWORK"].includes(
                      task.status,
                    ) ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => requestAction(task, "cancel")}
                        className="rounded-md border border-red-200 px-3.5 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                      >
                        取消
                      </button>
                    ) : null}
                    <Link
                      href={`/housekeeping/${task.id}`}
                      className={secondaryButtonClass}
                    >
                      详情
                    </Link>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* 新建任务（write）：仅 dirty 房间可选 */}
      <Modal
        open={createOpen}
        title="新建保洁任务"
        onClose={() => {
          if (!creating) {
            setCreateOpen(false);
            setCreateError(null);
          }
        }}
      >
        <div className="space-y-3">
          <Field label="房间" required error={null}>
            <select
              value={createRoomId === "" ? "" : String(createRoomId)}
              onChange={(e) =>
                setCreateRoomId(e.target.value === "" ? "" : Number(e.target.value))
              }
              disabled={creating}
              className={inputClass}
              aria-label="选择待清扫房间"
            >
              <option value="">选择待清扫房间…</option>
              {(dirtyRooms ?? []).map((room) => (
                <option key={room.id} value={room.id}>
                  {room.room_number}（{room.cleaning_status === "dirty" ? "待清扫" : room.cleaning_status}）
                </option>
              ))}
            </select>
          </Field>
          <Field label="优先级" error={null}>
            <select
              value={createPriority}
              onChange={(e) =>
                setCreatePriority(e.target.value as "NORMAL" | "URGENT")
              }
              disabled={creating}
              className={inputClass}
              aria-label="任务优先级"
            >
              <option value="NORMAL">普通</option>
              <option value="URGENT">加急</option>
            </select>
          </Field>
          <Field label="备注" error={null}>
            <textarea
              value={createNotes}
              onChange={(e) => setCreateNotes(e.target.value)}
              disabled={creating}
              rows={2}
              className={inputClass}
              aria-label="任务备注"
              placeholder="可选"
            />
          </Field>
          {createError ? (
            <p role="alert" className="text-sm text-red-600">
              {createError}
            </p>
          ) : null}
          <div className="flex justify-end gap-2.5 pt-1">
            <button
              type="button"
              onClick={() => setCreateOpen(false)}
              disabled={creating}
              className={secondaryButtonClass}
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void submitCreate()}
              disabled={creating}
              className={primaryButtonClass}
            >
              {creating ? "创建中…" : "创建"}
            </button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={actionTask !== null && actionKind !== null}
        title={confirmMeta.title}
        message={confirmMeta.message}
        confirmLabel={confirmMeta.label}
        busy={busy}
        onConfirm={() => {
          if (actionTask && actionKind) void runAction(actionTask, actionKind);
        }}
        onCancel={() => {
          setActionTask(null);
          setActionKind(null);
        }}
      />
    </div>
  );
}
