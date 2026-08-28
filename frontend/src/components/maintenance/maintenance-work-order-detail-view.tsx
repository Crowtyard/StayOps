"use client";

/**
 * /maintenance/[id] 维修工单详情（Sprint 5 §35）：
 * - 工单字段：单号 / 房间 / 标题 / 描述 / 分类 / 严重度 / 阻断 / 来源 / 状态 /
 *   报修人 / 负责人
 * - Room occupancy_status + cleaning_status（后端已内嵌，无需 room:read）
 * - 时间线：started_at / resolved_at / verified_at / completed_at
 * - 操作（按 permission + status 显隐，后端状态机为最终权威）：
 *   assign（write）/ start（work）/ resolve（work）/ verify（verify）/
 *   rework（verify）/ cancel（cancel）
 * - 编辑（write）：category / severity / title / description（PATCH strict）
 * - PII：不展示任何 Guest / Reservation 数据
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ApiError, api } from "@/lib/api";
import type {
  MaintenanceAssigneeOut,
  MaintenanceCategory,
  MaintenanceSeverity,
  MaintenanceWorkOrderOut,
} from "@/lib/api/types";
import {
  MWO_CATEGORY_LABELS,
  MWO_SEVERITY_META,
  MWO_SOURCE_LABELS,
  MWO_STATUS_META,
} from "@/lib/maintenance";
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

type ActionKind = "start" | "resolve" | "verify" | "rework" | "cancel";

const CATEGORIES = Object.keys(MWO_CATEGORY_LABELS) as MaintenanceCategory[];
const SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as MaintenanceSeverity[];

function formatWhen(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

export default function MaintenanceWorkOrderDetailView({ id }: { id: string }) {
  const router = useRouter();
  const user = useUser();
  const permissions = useMemo(() => new Set(user?.permissions ?? []), [user]);

  const canWrite = permissions.has("maintenance_order:write");
  const canWork = permissions.has("maintenance_order:work");
  const canVerify = permissions.has("maintenance_order:verify");
  const canCancel = permissions.has("maintenance_order:cancel");

  const [order, setOrder] = useState<MaintenanceWorkOrderOut | null>(null);
  const [assignees, setAssignees] = useState<MaintenanceAssigneeOut[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const [confirming, setConfirming] = useState<ActionKind | null>(null);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ kind: "success" | "conflict"; text: string } | null>(null);

  // 派单 / 编辑（write）
  const [assigneeId, setAssigneeId] = useState<number | "">("");
  const [category, setCategory] = useState<MaintenanceCategory>("HVAC");
  const [severity, setSeverity] = useState<MaintenanceSeverity>("MEDIUM");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.maintenance
      .get(id)
      .then((data) => {
        if (cancelled) return;
        setOrder(data);
        setAssigneeId(data.assigned_to_user_id ?? "");
        setCategory(data.category);
        setSeverity(data.severity);
        setTitle(data.title);
        setDescription(data.description ?? "");
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

  // 派单候选人（maintenance_order:write；无需 user:read；失败不阻塞）
  useEffect(() => {
    if (!order || !canWrite) return;
    let cancelled = false;
    api.maintenance
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
  }, [order, canWrite]);

  const retry = useCallback(() => {
    setError(null);
    setForbidden(false);
    setOrder(null);
    setReloadKey((k) => k + 1);
  }, []);

  async function runAction(kind: ActionKind) {
    if (!order || busy) return;
    setBusy(true);
    setBanner(null);
    try {
      if (kind === "start") await api.maintenance.start(order.id);
      else if (kind === "resolve") await api.maintenance.resolve(order.id);
      else if (kind === "verify") await api.maintenance.verify(order.id);
      else if (kind === "rework") await api.maintenance.rework(order.id);
      else if (kind === "cancel") await api.maintenance.cancel(order.id);
      setBanner({
        kind: "success",
        text:
          kind === "start"
            ? "已开始维修"
            : kind === "resolve"
              ? "已提交验收"
              : kind === "verify"
                ? "验收通过，工单完成"
                : kind === "rework"
                  ? "已退回返工"
                  : "工单已取消",
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

  async function saveAssign() {
    if (!order || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const target = assigneeId === "" ? null : Number(assigneeId);
      if (target === null) {
        setSaveError("请选择维修负责人");
        return;
      }
      if (target === (order.assigned_to_user_id ?? null)) {
        setSaveError("负责人未变化");
        return;
      }
      const updated = await api.maintenance.assign(order.id, target);
      setOrder(updated);
      setAssigneeId(updated.assigned_to_user_id ?? "");
      setBanner({ kind: "success", text: "已派工" });
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "派工失败，请稍后重试");
    } finally {
      setSaving(false);
    }
  }

  async function saveEdits() {
    if (!order || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const payload: {
        category?: MaintenanceCategory;
        severity?: MaintenanceSeverity;
        title?: string;
        description?: string | null;
      } = {};
      if (category !== order.category) payload.category = category;
      if (severity !== order.severity) payload.severity = severity;
      if (title.trim() !== order.title) payload.title = title.trim();
      if (description.trim() !== (order.description ?? "")) {
        payload.description = description.trim() || null;
      }
      if (Object.keys(payload).length === 0) {
        setSaveError("没有需要保存的变更");
        return;
      }
      const updated = await api.maintenance.update(order.id, payload);
      setOrder(updated);
      setCategory(updated.category);
      setSeverity(updated.severity);
      setTitle(updated.title);
      setDescription(updated.description ?? "");
      setBanner({ kind: "success", text: "已保存" });
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "保存失败，请稍后重试");
    } finally {
      setSaving(false);
    }
  }

  if (forbidden) {
    return <Forbidden text="无权限查看维修工单" />;
  }
  if (error) {
    return (
      <div>
        <BackLink />
        <ErrorView
          message={error.kind === "not_found" ? "维修工单不存在或已被删除" : error.message}
          offline={error.kind === "network"}
          onRetry={error.kind === "not_found" ? undefined : retry}
        />
      </div>
    );
  }
  if (!order) {
    return (
      <div>
        <BackLink />
        <Loading text="正在加载维修工单…" />
      </div>
    );
  }

  const active = ["OPEN", "ASSIGNED", "IN_PROGRESS", "RESOLVED"].includes(order.status);
  const assignable = order.status === "OPEN" || order.status === "ASSIGNED";

  return (
    <div className="mx-auto max-w-4xl">
      <BackLink />

      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">
            维修工单 {order.work_order_no}
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            房间 {order.room_number} · {MWO_CATEGORY_LABELS[order.category]} ·{" "}
            {MWO_SOURCE_LABELS[order.source]} · 创建于 {formatWhen(order.created_at)}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <StatusBadge meta={MWO_STATUS_META[order.status]} />
          <StatusBadge meta={MWO_SEVERITY_META[order.severity]} />
          {order.blocks_room ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-700 ring-1 ring-inset ring-red-300">
              <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />
              阻断客房
            </span>
          ) : null}
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
        {order.status === "ASSIGNED" && canWork ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirming("start")}
            className={primaryButtonClass}
          >
            开始维修
          </button>
        ) : null}
        {order.status === "IN_PROGRESS" && canWork ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirming("resolve")}
            className={primaryButtonClass}
          >
            提交验收
          </button>
        ) : null}
        {order.status === "RESOLVED" && canVerify ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirming("verify")}
              className={primaryButtonClass}
            >
              验收通过
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirming("rework")}
              className={secondaryButtonClass}
            >
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
            取消工单
          </button>
        ) : null}
      </div>

      <div className="space-y-5">
        <SectionCard title="工单信息">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
            <Info label="工单标题" value={order.title} />
            <Info label="故障描述" value={order.description || "—"} />
            <Info label="报修人" value={order.reporter_name ?? "—"} />
            <Info label="负责人" value={order.assignee_name ?? "未指派"} />
            <Info label="阻断客房" value={order.blocks_room ? "是（阻止新住宿业务）" : "否"} />
            <Info label="验收记录" value={order.verified_by_user_id != null ? "已记录" : "—"} />
            <Info label="开始维修" value={formatWhen(order.started_at)} />
            <Info label="提交解决" value={formatWhen(order.resolved_at)} />
            <Info label="验收时间" value={formatWhen(order.verified_at)} />
            <Info label="完成时间" value={formatWhen(order.completed_at)} />
            <Info label="取消时间" value={formatWhen(order.cancelled_at)} />
          </dl>
        </SectionCard>

        {order.verification_notes ? (
          <SectionCard title="验收备注">
            <p className="whitespace-pre-wrap text-sm text-gray-700">
              {order.verification_notes}
            </p>
          </SectionCard>
        ) : null}
        {order.resolution_notes ? (
          <SectionCard title="维修结果说明">
            <p className="whitespace-pre-wrap text-sm text-gray-700">
              {order.resolution_notes}
            </p>
          </SectionCard>
        ) : null}

        <SectionCard title="房间现场状态">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-gray-600">房间 {order.room_number}：</span>
            {order.room_occupancy_status ? (
              <OccupancyBadge status={order.room_occupancy_status} />
            ) : null}
            {order.room_cleaning_status ? (
              <CleaningBadge status={order.room_cleaning_status} />
            ) : null}
          </div>
          <p className="mt-2 text-xs text-gray-400">
            维修状态与房间占用/清洁状态相互独立；维修完成并验收不代表房间已清洁。
          </p>
        </SectionCard>

        {canWrite && assignable ? (
          <SectionCard title="派工">
            <div className="space-y-3">
              <Field label="维修负责人" error={null}>
                <select
                  value={assigneeId === "" ? "" : String(assigneeId)}
                  onChange={(e) =>
                    setAssigneeId(e.target.value === "" ? "" : Number(e.target.value))
                  }
                  disabled={saving}
                  className={inputClass}
                  aria-label="指派维修负责人"
                >
                  <option value="">选择负责人…</option>
                  {(assignees ?? []).map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.display_name}（{a.username}）
                    </option>
                  ))}
                </select>
              </Field>
              {saveError ? (
                <p role="alert" className="text-sm text-red-600">
                  {saveError}
                </p>
              ) : null}
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => void saveAssign()}
                  disabled={saving}
                  className={primaryButtonClass}
                >
                  {saving ? "派工中…" : order.status === "ASSIGNED" ? "改派" : "派工"}
                </button>
              </div>
            </div>
          </SectionCard>
        ) : null}

        {canWrite && active ? (
          <SectionCard title="编辑工单">
            <div className="space-y-4">
              <Field label="故障分类" error={null}>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value as MaintenanceCategory)}
                  disabled={saving}
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
              <Field label="严重程度" error={null}>
                <select
                  value={severity}
                  onChange={(e) => setSeverity(e.target.value as MaintenanceSeverity)}
                  disabled={saving}
                  className={inputClass}
                  aria-label="严重程度"
                >
                  {SEVERITIES.map((s) => (
                    <option key={s} value={s}>
                      {MWO_SEVERITY_META[s].label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="工单标题" error={null}>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  disabled={saving}
                  maxLength={200}
                  className={inputClass}
                  aria-label="工单标题"
                />
              </Field>
              <Field label="故障描述" error={null}>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  disabled={saving}
                  rows={3}
                  maxLength={2000}
                  className={inputClass}
                  aria-label="故障描述"
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
            ? "开始维修"
            : confirming === "resolve"
              ? "提交验收"
              : confirming === "verify"
                ? "验收通过"
                : confirming === "rework"
                  ? "返工"
                  : "取消工单"
        }
        message={
          confirming === "verify"
            ? `确定工单 ${order.work_order_no} 验收通过吗？工单将完成；如为最后一张阻断工单，房间将恢复可售。`
            : confirming === "rework"
              ? `确定将房间 ${order.room_number} 的工单退回维修吗？房间继续被阻断。`
              : confirming === "cancel"
                ? `确定取消工单 ${order.work_order_no} 吗？取消后不可恢复。`
                : `确定对房间 ${order.room_number} 执行该操作吗？`
        }
        confirmLabel={
          confirming === "start"
            ? "开始维修"
            : confirming === "resolve"
              ? "提交验收"
              : confirming === "verify"
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
      href="/maintenance"
      className="mb-4 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900"
    >
      ← 返回维修工作台
    </Link>
  );
}
