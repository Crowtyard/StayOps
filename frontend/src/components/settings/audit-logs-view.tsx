"use client";

import { useCallback, useMemo, useState } from "react";
import { api } from "@/lib/api";
import type { AuditLogOut } from "@/lib/api/types";
import { IconChevronDown } from "@/components/icons";
import { Empty, Loading } from "@/components/status-views";
import {
  SettingsHeader,
  TableShell,
  formatDateTime,
  listErrorView,
  usePageFetch,
} from "@/components/settings/shared";

/** details 展开查看：格式化 JSON（不整块塞进表格单元格） */
function formatDetails(details: Record<string, unknown> | null): string {
  if (details === null || details === undefined) return "—";
  if (Object.keys(details).length === 0) return "（空）";
  return JSON.stringify(details, null, 2);
}

const ACTION_LABELS: Record<string, string> = {
  login: "登录",
  login_failed: "登录失败",
  logout: "退出",
  "user.create": "创建用户",
  "user.update": "更新用户",
  "user.delete": "删除用户",
  "user.assign_roles": "分配角色",
  "role.create": "创建角色",
  "role.update": "更新角色",
  "role.delete": "删除角色",
  "role.set_permissions": "设置角色权限",
  "room_type.create": "创建房型",
  "room_type.update": "更新房型",
  "room_type.delete": "删除房型",
  "room.create": "创建房间",
  "room.update": "更新房间",
  "room.delete": "删除房间",
  "room.status_change": "房态变更",
};

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

export default function AuditLogsView() {
  const [actionFilter, setActionFilter] = useState("");
  const [resourceTypeFilter, setResourceTypeFilter] = useState("");

  const load = useCallback(
    () =>
      api.auditLogs.list({
        page: 1,
        page_size: 100,
        action: actionFilter || undefined,
        resource_type: resourceTypeFilter || undefined,
      }),
    [actionFilter, resourceTypeFilter],
  );
  const { items, total, error, reload } = usePageFetch<AuditLogOut>(load, [
    actionFilter,
    resourceTypeFilter,
  ]);

  const [expandedId, setExpandedId] = useState<number | null>(null);

  // 筛选选项来自当前已加载数据中出现的 action / resource_type（与后端精确匹配参数一致）
  const actionOptions = useMemo(() => {
    const set = new Set<string>();
    for (const log of items ?? []) set.add(log.action);
    return [...set].sort();
  }, [items]);

  const resourceTypeOptions = useMemo(() => {
    const set = new Set<string>();
    for (const log of items ?? []) {
      if (log.resource_type) set.add(log.resource_type);
    }
    return [...set].sort();
  }, [items]);

  const currentFilterActive = actionFilter !== "" || resourceTypeFilter !== "";

  if (error) return listErrorView(error, reload);

  return (
    <div>
      <SettingsHeader
        title="审计日志"
        description="所有写操作（含登录成功/失败）的审计记录：时间、操作人、操作、资源与来源 IP；details 展开查看"
      />

      {/* 筛选 */}
      <div className="mb-4 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <fieldset>
            <legend className="mb-1.5 text-xs font-medium text-gray-500">
              操作类型
            </legend>
            <select
              aria-label="操作类型"
              value={actionFilter}
              onChange={(e) => {
                setExpandedId(null);
                setActionFilter(e.target.value);
              }}
              className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
            >
              <option value="">全部操作</option>
              {actionOptions.map((a) => (
                <option key={a} value={a}>
                  {actionLabel(a)}（{a}）
                </option>
              ))}
            </select>
          </fieldset>
          <fieldset>
            <legend className="mb-1.5 text-xs font-medium text-gray-500">
              资源类型
            </legend>
            <select
              aria-label="资源类型"
              value={resourceTypeFilter}
              onChange={(e) => {
                setExpandedId(null);
                setResourceTypeFilter(e.target.value);
              }}
              className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
            >
              <option value="">全部资源</option>
              {resourceTypeOptions.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </fieldset>
          {currentFilterActive ? (
            <button
              type="button"
              onClick={() => {
                setExpandedId(null);
                setActionFilter("");
                setResourceTypeFilter("");
              }}
              className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50"
            >
              清除筛选
            </button>
          ) : null}
        </div>
      </div>

      {items === null ? (
        <Loading text="正在加载审计日志…" />
      ) : items.length === 0 ? (
        <Empty
          text={
            currentFilterActive
              ? "当前筛选条件下没有审计记录"
              : "暂无审计记录"
          }
        />
      ) : (
        <>
          <p className="mb-3 text-sm text-gray-500">
            {total !== null && total > items.length
              ? `共 ${total} 条，显示前 ${items.length} 条`
              : `共 ${items.length} 条`}
          </p>
          <TableShell>
            <thead className="bg-gray-50">
              <tr className="text-left text-xs text-gray-500">
                <th className="px-4 py-3 font-medium">时间</th>
                <th className="px-4 py-3 font-medium">操作人</th>
                <th className="px-4 py-3 font-medium">操作</th>
                <th className="px-4 py-3 font-medium">资源</th>
                <th className="px-4 py-3 font-medium">IP</th>
                <th className="px-4 py-3 font-medium">详情</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {items.map((log) => {
                const expanded = expandedId === log.id;
                return (
                  <FragmentRow
                    key={log.id}
                    log={log}
                    expanded={expanded}
                    onToggle={() =>
                      setExpandedId(expanded ? null : log.id)
                    }
                  />
                );
              })}
            </tbody>
          </TableShell>
        </>
      )}
    </div>
  );
}

function FragmentRow({
  log,
  expanded,
  onToggle,
}: {
  log: AuditLogOut;
  expanded: boolean;
  onToggle: () => void;
}) {
  const hasDetails = log.details !== null && log.details !== undefined;
  return (
    <>
      <tr className="text-gray-900">
        <td className="whitespace-nowrap px-4 py-3 text-gray-600">
          {formatDateTime(log.created_at)}
        </td>
        <td className="px-4 py-3">
          {log.username ?? <span className="text-gray-400">—</span>}
        </td>
        <td className="px-4 py-3">
          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-medium text-gray-700">
            {log.action}
          </span>
          <span className="ml-2 text-xs text-gray-500">
            {actionLabel(log.action)}
          </span>
        </td>
        <td className="px-4 py-3 text-gray-600">
          {log.resource_type ? (
            <>
              {log.resource_type}
              {log.resource_id !== null && log.resource_id !== undefined ? (
                <span className="text-gray-400"> #{log.resource_id}</span>
              ) : null}
            </>
          ) : (
            "—"
          )}
        </td>
        <td className="whitespace-nowrap px-4 py-3 text-gray-600">
          {log.ip ?? "—"}
        </td>
        <td className="px-4 py-3">
          <button
            type="button"
            disabled={!hasDetails}
            onClick={onToggle}
            aria-expanded={expanded}
            className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            详情
            <IconChevronDown
              className={`size-3.5 transition-transform ${
                expanded ? "rotate-180" : ""
              }`}
            />
          </button>
        </td>
      </tr>
      {expanded ? (
        <tr className="bg-gray-50">
          <td colSpan={6} className="px-4 py-3">
            <pre className="overflow-x-auto rounded-md border border-gray-200 bg-white p-3 text-xs leading-5 text-gray-800">
              {formatDetails(log.details)}
            </pre>
          </td>
        </tr>
      ) : null}
    </>
  );
}
