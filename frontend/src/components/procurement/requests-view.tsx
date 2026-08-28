"use client";

/**
 * /procurement/requests 采购申请列表 + 新建（Sprint 7 §23/§24/§43）：
 * - 列表按状态筛选；行点击进详情
 * - 新建：多行物资 + 数量（后端 422 最终权威）
 * - 权限：读 procurement:read；创建 procurement:request
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ApiError, api } from "@/lib/api";
import type {
  InventoryItemListRow,
  PurchaseRequestOut,
  PurchaseRequestStatus,
} from "@/lib/api/types";
import { qty } from "@/lib/inventory";
import { PR_STATUS_META, PR_STATUSES } from "@/lib/procurement";
import { useUser } from "@/components/app-shell";
import { ErrorView, Forbidden, Loading } from "@/components/status-views";
import { StatusBadge } from "@/components/status-badge";
import { Modal } from "@/components/modal";
import { Field, inputClass } from "@/components/booking/shared";

interface DraftLine {
  key: number;
  itemId: number | "";
  quantity: string;
}

let nextKey = 2000;

export default function RequestsView() {
  const router = useRouter();
  const user = useUser();
  const permissions = useMemo(() => new Set(user?.permissions ?? []), [user]);
  const canRead = permissions.has("procurement:read");
  const canRequest = permissions.has("procurement:request");

  const [requests, setRequests] = useState<PurchaseRequestOut[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [statusFilter, setStatusFilter] = useState<PurchaseRequestStatus | "">("");
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    if (!canRead) return;
    let cancelled = false;
    const load = async () => {
      try {
        const all: PurchaseRequestOut[] = [];
        let page = 1;
        for (;;) {
          const result = await api.procurement.listRequests({
            page,
            page_size: 100,
            status: statusFilter === "" ? undefined : statusFilter,
          });
          all.push(...result.items);
          if (result.page * result.page_size >= result.total) break;
          page += 1;
        }
        if (!cancelled) setRequests(all);
      } catch (err: unknown) {
        if (cancelled) return;
        if (err instanceof ApiError && err.kind === "unauthorized") {
          router.replace("/login");
          return;
        }
        setError(
          err instanceof ApiError ? err : new ApiError("unknown", null, "加载失败"),
        );
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [canRead, router, reloadKey, statusFilter]);

  const refresh = useCallback(() => {
    setError(null);
    setReloadKey((k) => k + 1);
  }, []);

  if (!canRead) {
    return <Forbidden text="无权限访问采购申请（缺少 procurement:read）" />;
  }
  if (error) {
    return (
      <ErrorView
        message={error.message}
        offline={error.kind === "network"}
        onRetry={refresh}
      />
    );
  }
  if (!requests) {
    return <Loading text="正在加载采购申请…" />;
  }

  return (
    <div>
      <Link
        href="/procurement"
        className="mb-4 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900"
      >
        ← 返回采购工作台
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">采购申请</h1>
          <p className="mt-1 text-sm text-gray-500">
            草稿 → 提交 → 审批 → 转采购订单
          </p>
        </div>
        {canRequest ? (
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="rounded-md bg-gray-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-gray-700"
          >
            新建采购申请
          </button>
        ) : null}
      </div>

      <div className="mt-5 flex items-center gap-2">
        <select
          value={statusFilter}
          onChange={(e) =>
            setStatusFilter(e.target.value as PurchaseRequestStatus | "")
          }
          className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
          aria-label="按状态筛选"
        >
          <option value="">全部状态</option>
          {PR_STATUSES.map((s) => (
            <option key={s} value={s}>
              {PR_STATUS_META[s].label}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-4 overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50 text-left text-xs font-medium text-gray-500">
            <tr>
              <th className="px-4 py-3">申请单号</th>
              <th className="px-4 py-3">状态</th>
              <th className="px-4 py-3">申请人</th>
              <th className="px-4 py-3 text-right">行数</th>
              <th className="px-4 py-3">创建时间</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {requests.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-gray-400">
                  暂无采购申请
                </td>
              </tr>
            ) : (
              requests.map((pr) => (
                <tr key={pr.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <Link
                      href={`/procurement/requests/${pr.id}`}
                      className="font-medium text-gray-900 hover:underline"
                    >
                      {pr.request_no}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge meta={PR_STATUS_META[pr.status]} />
                  </td>
                  <td className="px-4 py-3 text-gray-500">
                    {pr.requester_name ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-500">
                    {pr.lines.length}
                  </td>
                  <td className="px-4 py-3 text-gray-500">
                    {new Date(pr.created_at).toLocaleString("zh-CN", {
                      hour12: false,
                    })}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <CreateRequestModal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onSuccess={() => {
          setShowCreate(false);
          refresh();
        }}
      />
    </div>
  );
}

export function CreateRequestModal({
  open,
  onClose,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [items, setItems] = useState<InventoryItemListRow[]>([]);
  const [lines, setLines] = useState<DraftLine[]>([
    { key: nextKey++, itemId: "", quantity: "1" },
  ]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api.inventory
      .listItems({ page: 1, page_size: 100 })
      .then((page) => {
        if (!cancelled) setItems(page.items.filter((i) => i.is_active));
      })
      .catch(() => {
        /* 物资加载失败时仍可关闭表单 */
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const updateLine = useCallback((key: number, patch: Partial<DraftLine>) => {
    setLines((prev) =>
      prev.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    );
  }, []);

  const addLine = useCallback(() => {
    setLines((prev) => [
      ...prev,
      { key: nextKey++, itemId: "", quantity: "1" },
    ]);
  }, []);

  const removeLine = useCallback((key: number) => {
    setLines((prev) =>
      prev.length <= 1 ? prev : prev.filter((line) => line.key !== key),
    );
  }, []);

  const submit = useCallback(async () => {
    if (submitting) return;
    const validLines = lines.filter(
      (line) => line.itemId !== "" && qty(line.quantity) > 0,
    );
    if (validLines.length === 0) {
      setError("请至少选择一种物资并填写数量");
      return;
    }
    const itemIds = validLines.map((line) => line.itemId as number);
    if (new Set(itemIds).size !== itemIds.length) {
      setError("同一采购申请不允许重复物资");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.procurement.createRequest({
        lines: validLines.map((line) => ({
          item_id: line.itemId as number,
          quantity: qty(line.quantity),
        })),
      });
      setLines([{ key: nextKey++, itemId: "", quantity: "1" }]);
      onSuccess();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "创建失败，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  }, [submitting, lines, onSuccess]);

  return (
    <Modal open={open} title="新建采购申请" onClose={onClose}>
      <div className="space-y-4">
        <Field
          label="申请明细"
          required
          error={null}
          hint="创建后为草稿状态，需提交并审批后才能转采购订单"
        >
          <div className="space-y-2">
            {lines.map((line) => (
              <div key={line.key} className="flex items-center gap-2">
                <select
                  value={line.itemId === "" ? "" : String(line.itemId)}
                  onChange={(e) =>
                    updateLine(line.key, {
                      itemId:
                        e.target.value === "" ? "" : Number(e.target.value),
                    })
                  }
                  disabled={submitting}
                  className={`${inputClass} min-w-0 flex-1`}
                  aria-label="申请物资"
                >
                  <option value="">选择物资…</option>
                  {items.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.item_code} · {item.name}（{item.base_unit}）
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={line.quantity}
                  onChange={(e) => updateLine(line.key, { quantity: e.target.value })}
                  disabled={submitting}
                  className={`${inputClass} w-24`}
                  aria-label="申请数量"
                />
                <button
                  type="button"
                  onClick={() => removeLine(line.key)}
                  disabled={submitting || lines.length <= 1}
                  aria-label="删除该行"
                  className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-40"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </Field>
        <button
          type="button"
          onClick={addLine}
          disabled={submitting}
          className="text-xs font-medium text-gray-900 underline-offset-2 hover:underline disabled:opacity-50"
        >
          + 添加物资
        </button>

        {error ? (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-inset ring-red-200">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2.5 pt-1">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-md border border-gray-300 px-3.5 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={submitting}
            className="rounded-md bg-gray-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
          >
            {submitting ? "创建中…" : "创建申请"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
