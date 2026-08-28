"use client";

/**
 * /maintenance 维修运营工作台（Sprint 5 §34，轻量 Work Order Board）：
 * - 顶部视图：待处理 / 已派工 / 维修中 / 待验收 / 阻断客房 / 今日完成（+ 全部）
 * - 工单卡片列表：房间 / 状态 / 严重度 / 分类 / 负责人 / 阻断徽标
 * - 筛选：Severity / Category / Assignee / Blocks Room / Source + 搜索
 *   （work_order_no / room_no / title，不搜 Guest PII）
 * - 快捷操作：OPEN 派单（write）/ ASSIGNED 开始维修（work）/
 *   IN_PROGRESS 提交解决（work）/ RESOLVED 验收（verify）
 * - 权限：maintenance_order:read（403 → Forbidden 视图，不跳登录）
 * - Mobile：<768px 单列卡片 + 操作按钮可点（不渲染复杂看板）
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ApiError, api } from "@/lib/api";
import type {
  MaintenanceAssigneeOut,
  MaintenanceCategory,
  MaintenanceSeverity,
  MaintenanceSource,
  MaintenanceWorkOrderOut,
  MaintenanceWorkOrderStatus,
} from "@/lib/api/types";
import {
  MWO_CATEGORY_LABELS,
  MWO_SEVERITY_META,
  MWO_SOURCE_LABELS,
  MWO_STATUS_META,
} from "@/lib/maintenance";
import { StatusBadge } from "@/components/status-badge";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Empty, ErrorView, Forbidden, Loading } from "@/components/status-views";
import { useUser } from "@/components/app-shell";
import {
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
} from "@/components/booking/shared";

const PAGE_SIZE = 20;

type StatusFilter = MaintenanceWorkOrderStatus | "" | "BLOCKING" | "TODAY_DONE";

const FILTER_TABS: { value: StatusFilter; label: string }[] = [
  { value: "", label: "全部" },
  { value: "OPEN", label: "待处理" },
  { value: "ASSIGNED", label: "已派工" },
  { value: "IN_PROGRESS", label: "维修中" },
  { value: "RESOLVED", label: "待验收" },
  { value: "BLOCKING", label: "阻断客房" },
  { value: "TODAY_DONE", label: "今日完成" },
];

type ActionKind = "assign" | "start" | "resolve" | "verify";

function formatWhen(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

/** 今日完成（COMPLETED 且完成时间在业务日期今天，客户端按时间过滤） */
function isTodayCompleted(order: MaintenanceWorkOrderOut): boolean {
  if (order.status !== "COMPLETED" || !order.completed_at) return false;
  const value = new Date(order.completed_at);
  if (Number.isNaN(value.getTime())) return false;
  const now = new Date();
  const shanghaiNow = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Shanghai" }),
  );
  const shanghaiDone = new Date(
    value.toLocaleString("en-US", { timeZone: "Asia/Shanghai" }),
  );
  return (
    shanghaiDone.getFullYear() === shanghaiNow.getFullYear() &&
    shanghaiDone.getMonth() === shanghaiNow.getMonth() &&
    shanghaiDone.getDate() === shanghaiNow.getDate()
  );
}

export default function MaintenanceWorkspaceView() {
  const router = useRouter();
  const user = useUser();
  const permissions = useMemo(() => new Set(user?.permissions ?? []), [user]);

  const canWrite = permissions.has("maintenance_order:write");
  const canWork = permissions.has("maintenance_order:work");
  const canVerify = permissions.has("maintenance_order:verify");

  const [items, setItems] = useState<MaintenanceWorkOrderOut[] | null>(null);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<StatusFilter>("");
  const [category, setCategory] = useState<MaintenanceCategory | "">("");
  const [severity, setSeverity] = useState<MaintenanceSeverity | "">("");
  const [source, setSource] = useState<MaintenanceSource | "">("");
  const [blocksRoom, setBlocksRoom] = useState<"" | "true" | "false">("");
  const [assigneeId, setAssigneeId] = useState<number | "">("");
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");

  const [assignees, setAssignees] = useState<MaintenanceAssigneeOut[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const [actionOrder, setActionOrder] = useState<MaintenanceWorkOrderOut | null>(null);
  const [actionKind, setActionKind] = useState<ActionKind | null>(null);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ kind: "success" | "conflict"; text: string } | null>(null);

  // 派单候选人（maintenance_order:write 才请求）
  useEffect(() => {
    if (!canWrite) return;
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
  }, [canWrite]);

  useEffect(() => {
    let cancelled = false;
    const params: Record<string, string | number | boolean | undefined> = {
      page: 1,
      page_size: PAGE_SIZE,
    };
    if (status === "BLOCKING") params.blocks_room = true;
    else if (status === "TODAY_DONE") params.status = "COMPLETED";
    else if (status !== "") params.status = status;
    if (category !== "") params.category = category;
    if (severity !== "") params.severity = severity;
    if (source !== "") params.source = source;
    if (blocksRoom !== "") params.blocks_room = blocksRoom === "true";
    if (assigneeId !== "") params.assigned_to = Number(assigneeId);
    if (search.trim() !== "") params.search = search.trim();

    api.maintenance
      .list(params)
      .then((result) => {
        if (cancelled) return;
        let filtered = result.items;
        if (status === "BLOCKING") {
          // blocks_room=true 可能包含已完成/已取消：只保留 Active Blocking
          filtered = filtered.filter((o) =>
            ["OPEN", "ASSIGNED", "IN_PROGRESS", "RESOLVED"].includes(o.status),
          );
        }
        if (status === "TODAY_DONE") {
          filtered = filtered.filter(isTodayCompleted);
        }
        setItems(filtered);
        setTotal(filtered.length);
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
  }, [
    router,
    status,
    category,
    severity,
    source,
    blocksRoom,
    assigneeId,
    search,
    reloadKey,
  ]);

  const retry = useCallback(() => {
    setError(null);
    setForbidden(false);
    setItems(null);
    setReloadKey((k) => k + 1);
  }, []);

  async function runAction(order: MaintenanceWorkOrderOut, kind: ActionKind) {
    if (busy) return;
    setBusy(true);
    setBanner(null);
    try {
      if (kind === "assign") {
        await api.maintenance.assign(order.id, Number(assigneeId));
      } else if (kind === "start") await api.maintenance.start(order.id);
      else if (kind === "resolve") await api.maintenance.resolve(order.id);
      else if (kind === "verify") await api.maintenance.verify(order.id);
      setBanner({
        kind: "success",
        text:
          kind === "assign"
            ? `工单 ${order.work_order_no} 已派工`
            : kind === "start"
              ? `房间 ${order.room_number} 已开始维修`
              : kind === "resolve"
                ? `房间 ${order.room_number} 已提交验收`
                : `房间 ${order.room_number} 验收通过，工单完成`,
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
      setActionOrder(null);
      setActionKind(null);
    }
  }

  function requestAction(order: MaintenanceWorkOrderOut, kind: ActionKind) {
    setBanner(null);
    if (kind === "assign") {
      // 快捷派单：负责人来自筛选行下拉；未选择则提示（确认对话框仅用于验收）
      if (assigneeId === "") {
        setBanner({
          kind: "conflict",
          text: "请先在筛选行选择维修负责人，再点击派工",
        });
        return;
      }
      void runAction(order, kind);
      return;
    }
    if (kind === "verify") {
      setActionOrder(order);
      setActionKind(kind);
      return;
    }
    void runAction(order, kind);
  }

  if (forbidden) {
    return <Forbidden text="无权限查看维修工单" />;
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

  const confirmMeta = {
    title: "验收通过",
    message: `确定工单 ${actionOrder?.work_order_no ?? ""}（房间 ${actionOrder?.room_number ?? ""}）验收通过吗？工单将完成；如为最后一张阻断工单，房间将恢复可售（清洁状态保持不变）。`,
    label: "确认通过",
  };

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">维修运营</h1>
          <p className="mt-1 text-sm text-gray-500">
            报修 → 派工 → 维修 → 验收 / 返工 → 完成 → 房间恢复可售
          </p>
        </div>
        {canWrite ? (
          <Link href="/maintenance/new" className={primaryButtonClass}>
            现场报修
          </Link>
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

      {/* 状态视图（真实后端查询参数） */}
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

      {/* 筛选行 */}
      <div className="mb-4 flex flex-wrap items-end gap-2.5 rounded-lg border border-gray-200 bg-white p-3">
        <div className="min-w-40 flex-1">
          <label className="mb-1 block text-xs font-medium text-gray-600">搜索</label>
          <div className="flex gap-2">
            <input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") setSearch(searchInput.trim());
              }}
              placeholder="工单号 / 房号 / 标题"
              className={inputClass}
              aria-label="搜索工单"
            />
            <button
              type="button"
              onClick={() => setSearch(searchInput.trim())}
              className={secondaryButtonClass}
            >
              搜索
            </button>
          </div>
        </div>
        <div className="min-w-28">
          <label className="mb-1 block text-xs font-medium text-gray-600">分类</label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as MaintenanceCategory | "")}
            className={inputClass}
            aria-label="分类筛选"
          >
            <option value="">全部</option>
            {(Object.keys(MWO_CATEGORY_LABELS) as MaintenanceCategory[]).map((c) => (
              <option key={c} value={c}>
                {MWO_CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-24">
          <label className="mb-1 block text-xs font-medium text-gray-600">严重度</label>
          <select
            value={severity}
            onChange={(e) => setSeverity(e.target.value as MaintenanceSeverity | "")}
            className={inputClass}
            aria-label="严重度筛选"
          >
            <option value="">全部</option>
            <option value="LOW">低</option>
            <option value="MEDIUM">中</option>
            <option value="HIGH">高</option>
            <option value="CRITICAL">紧急</option>
          </select>
        </div>
        <div className="min-w-28">
          <label className="mb-1 block text-xs font-medium text-gray-600">来源</label>
          <select
            value={source}
            onChange={(e) => setSource(e.target.value as MaintenanceSource | "")}
            className={inputClass}
            aria-label="来源筛选"
          >
            <option value="">全部</option>
            {(Object.keys(MWO_SOURCE_LABELS) as MaintenanceSource[]).map((s) => (
              <option key={s} value={s}>
                {MWO_SOURCE_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-24">
          <label className="mb-1 block text-xs font-medium text-gray-600">阻断客房</label>
          <select
            value={blocksRoom}
            onChange={(e) => setBlocksRoom(e.target.value as "" | "true" | "false")}
            className={inputClass}
            aria-label="阻断客房筛选"
          >
            <option value="">全部</option>
            <option value="true">是</option>
            <option value="false">否</option>
          </select>
        </div>
        {canWrite ? (
          <div className="min-w-32">
            <label className="mb-1 block text-xs font-medium text-gray-600">负责人</label>
            <select
              value={assigneeId === "" ? "" : String(assigneeId)}
              onChange={(e) =>
                setAssigneeId(e.target.value === "" ? "" : Number(e.target.value))
              }
              className={inputClass}
              aria-label="负责人筛选"
            >
              <option value="">全部</option>
              {assignees.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.display_name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      {items === null ? (
        <Loading text="正在加载维修工单…" />
      ) : items.length === 0 ? (
        <Empty
          text={
            status === ""
              ? "暂无维修工单"
              : `当前没有「${FILTER_TABS.find((t) => t.value === status)?.label}」工单`
          }
        />
      ) : (
        <>
          <p className="mb-3 text-sm text-gray-500">共 {total} 张工单</p>
          <ul className="list-none space-y-3">
            {items.map((order) => (
              <li
                key={order.id}
                className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <Link
                      href={`/maintenance/${order.id}`}
                      className="text-base font-semibold text-gray-900 hover:underline"
                    >
                      房间 {order.room_number}
                    </Link>
                    <p className="mt-0.5 text-xs text-gray-500">
                      {order.work_order_no} · {MWO_CATEGORY_LABELS[order.category]} ·{" "}
                      {MWO_SOURCE_LABELS[order.source]} · 更新于{" "}
                      {formatWhen(order.updated_at)}
                    </p>
                    <p className="mt-1 truncate text-sm text-gray-700">{order.title}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <StatusBadge meta={MWO_STATUS_META[order.status]} />
                    <StatusBadge meta={MWO_SEVERITY_META[order.severity]} />
                    {order.blocks_room &&
                    ["OPEN", "ASSIGNED", "IN_PROGRESS", "RESOLVED"].includes(
                      order.status,
                    ) ? (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-700 ring-1 ring-inset ring-red-300">
                        <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />
                        阻断客房
                      </span>
                    ) : null}
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm text-gray-600">
                    负责人：
                    <span className="font-medium text-gray-900">
                      {order.assignee_name ?? "未指派"}
                    </span>
                    {order.started_at ? (
                      <span className="ml-3 text-xs text-gray-400">
                        开始 {formatWhen(order.started_at)}
                      </span>
                    ) : null}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {order.status === "OPEN" && canWrite ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => requestAction(order, "assign")}
                        className={primaryButtonClass}
                      >
                        派工
                      </button>
                    ) : null}
                    {order.status === "ASSIGNED" && canWork ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => requestAction(order, "start")}
                        className={primaryButtonClass}
                      >
                        开始维修
                      </button>
                    ) : null}
                    {order.status === "IN_PROGRESS" && canWork ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => requestAction(order, "resolve")}
                        className={primaryButtonClass}
                      >
                        提交验收
                      </button>
                    ) : null}
                    {order.status === "RESOLVED" && canVerify ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => requestAction(order, "verify")}
                        className={primaryButtonClass}
                      >
                        验收通过
                      </button>
                    ) : null}
                    <Link
                      href={`/maintenance/${order.id}`}
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

      <ConfirmDialog
        open={actionOrder !== null && actionKind !== null}
        title={confirmMeta.title}
        message={confirmMeta.message}
        confirmLabel={confirmMeta.label}
        busy={busy}
        onConfirm={() => {
          if (actionOrder && actionKind) void runAction(actionOrder, actionKind);
        }}
        onCancel={() => {
          setActionOrder(null);
          setActionKind(null);
        }}
      />
    </div>
  );
}
