"use client";

/**
 * /procurement/requests/[id] 采购申请详情（Sprint 7 §43）：
 * - 申请信息 / 行 / 关键时间戳（submitted/approved/rejected/cancelled）
 * - 依权限与 status 显隐动作：submit（DRAFT）/ approve·reject（SUBMITTED）/
 *   cancel（DRAFT·APPROVED）/ 转采购订单（APPROVED）
 * 前端不复制后端状态机：非法转换由后端 409 裁决并原文展示。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ApiError, api } from "@/lib/api";
import type {
  PurchaseRequestOut,
  SupplierOut,
} from "@/lib/api/types";
import { fmtQty } from "@/lib/inventory";
import { PR_STATUS_META } from "@/lib/procurement";
import { useUser } from "@/components/app-shell";
import { ErrorView, Forbidden, Loading } from "@/components/status-views";
import { StatusBadge } from "@/components/status-badge";
import { Modal } from "@/components/modal";
import { Field, inputClass } from "@/components/booking/shared";

export default function RequestDetailView({ id }: { id: string }) {
  const router = useRouter();
  const user = useUser();
  const permissions = useMemo(() => new Set(user?.permissions ?? []), [user]);
  const canRead = permissions.has("procurement:read");
  const canRequest = permissions.has("procurement:request");
  const canApprove = permissions.has("procurement:approve");
  const canOrder = permissions.has("procurement:order");

  const [pr, setPr] = useState<PurchaseRequestOut | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showConvert, setShowConvert] = useState(false);

  useEffect(() => {
    if (!canRead) return;
    let cancelled = false;
    api.procurement
      .getRequest(id)
      .then((data) => {
        if (!cancelled) setPr(data);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.kind === "unauthorized") {
          router.replace("/login");
          return;
        }
        setError(
          err instanceof ApiError ? err : new ApiError("unknown", null, "加载失败"),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [canRead, id, router, reloadKey]);

  const refresh = useCallback(() => {
    setError(null);
    setActionError(null);
    setReloadKey((k) => k + 1);
  }, []);

  const runAction = useCallback(
    async (action: () => Promise<unknown>) => {
      if (busy) return;
      setBusy(true);
      setActionError(null);
      try {
        await action();
        refresh();
      } catch (err) {
        setActionError(
          err instanceof ApiError ? err.message : "操作失败，请稍后重试",
        );
      } finally {
        setBusy(false);
      }
    },
    [busy, refresh],
  );

  if (!canRead) {
    return <Forbidden text="无权限访问采购申请（缺少 procurement:read）" />;
  }
  if (error && error.kind !== "not_found") {
    return (
      <ErrorView
        message={error.message}
        offline={error.kind === "network"}
        onRetry={refresh}
      />
    );
  }
  if (error?.kind === "not_found") {
    return <Forbidden text="该采购申请不存在" />;
  }
  if (!pr) {
    return <Loading text="正在加载采购申请…" />;
  }

  const status = pr.status;
  const canSubmit = canRequest && status === "DRAFT";
  const canApproveNow = canApprove && status === "SUBMITTED";
  const canRejectNow = canApprove && status === "SUBMITTED";
  const canCancelNow =
    canRequest && (status === "DRAFT" || status === "APPROVED");
  const canConvert = canOrder && status === "APPROVED";

  const timestamps: { label: string; value: string | null }[] = [
    { label: "提交时间", value: pr.submitted_at ?? null },
    { label: "审批时间", value: pr.approved_at ?? null },
    { label: "驳回时间", value: pr.rejected_at ?? null },
    { label: "取消时间", value: pr.cancelled_at ?? null },
  ];

  return (
    <div>
      <Link
        href="/procurement/requests"
        className="mb-4 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900"
      >
        ← 返回采购申请列表
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2.5 text-xl font-semibold text-gray-900">
            {pr.request_no}
            <StatusBadge meta={PR_STATUS_META[status]} />
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            申请人 {pr.requester_name ?? "—"}
            {pr.approved_by_name ? ` · 审批人 ${pr.approved_by_name}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canSubmit ? (
            <button
              type="button"
              onClick={() => void runAction(() => api.procurement.submitRequest(pr.id))}
              disabled={busy}
              className="rounded-md bg-gray-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
            >
              提交审批
            </button>
          ) : null}
          {canApproveNow ? (
            <button
              type="button"
              onClick={() => void runAction(() => api.procurement.approveRequest(pr.id))}
              disabled={busy}
              className="rounded-md bg-emerald-700 px-3.5 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
            >
              批准
            </button>
          ) : null}
          {canRejectNow ? (
            <button
              type="button"
              onClick={() => void runAction(() => api.procurement.rejectRequest(pr.id))}
              disabled={busy}
              className="rounded-md bg-red-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50"
            >
              驳回
            </button>
          ) : null}
          {canConvert ? (
            <button
              type="button"
              onClick={() => setShowConvert(true)}
              disabled={busy}
              className="rounded-md bg-gray-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
            >
              转采购订单
            </button>
          ) : null}
          {canCancelNow ? (
            <button
              type="button"
              onClick={() => void runAction(() => api.procurement.cancelRequest(pr.id))}
              disabled={busy}
              className="rounded-md border border-gray-300 px-3.5 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              取消申请
            </button>
          ) : null}
        </div>
      </div>

      {actionError ? (
        <p
          role="alert"
          className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-inset ring-red-200"
        >
          {actionError}
        </p>
      ) : null}

      <div className="mt-5 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
        <div className="border-b border-gray-200 px-5 py-3.5">
          <h2 className="text-sm font-semibold text-gray-900">申请明细</h2>
        </div>
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50 text-left text-xs font-medium text-gray-500">
            <tr>
              <th className="px-5 py-2.5">物资</th>
              <th className="px-5 py-2.5 text-right">申请数量</th>
              <th className="px-5 py-2.5">单位</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {pr.lines.map((line) => (
              <tr key={line.id}>
                <td className="px-5 py-2.5 text-gray-900">
                  {line.item_name ?? `#${line.item_id}`}
                  <span className="ml-1.5 text-xs text-gray-400">
                    {line.item_code}
                  </span>
                </td>
                <td className="px-5 py-2.5 text-right tabular-nums text-gray-900">
                  {fmtQty(line.quantity)}
                </td>
                <td className="px-5 py-2.5 text-gray-500">
                  {line.base_unit ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {timestamps.map((ts) => (
          <div
            key={ts.label}
            className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm"
          >
            <p className="text-xs text-gray-500">{ts.label}</p>
            <p className="mt-1.5 text-sm font-medium text-gray-900">
              {ts.value
                ? new Date(ts.value).toLocaleString("zh-CN", { hour12: false })
                : "—"}
            </p>
          </div>
        ))}
      </div>

      {showConvert ? (
        <ConvertToOrderModal
          request={pr}
          onClose={() => setShowConvert(false)}
          onSuccess={(orderId) => {
            setShowConvert(false);
            router.push(`/procurement/orders/${orderId}`);
          }}
        />
      ) : null}
    </div>
  );
}

export function ConvertToOrderModal({
  request,
  onClose,
  onSuccess,
}: {
  request: PurchaseRequestOut;
  onClose: () => void;
  onSuccess: (orderId: number) => void;
}) {
  const [suppliers, setSuppliers] = useState<SupplierOut[]>([]);
  const [supplierId, setSupplierId] = useState<number | "">("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.procurement
      .listSuppliers({ page: 1, page_size: 100 })
      .then((page) => {
        if (!cancelled) setSuppliers(page.items.filter((s) => s.is_active));
      })
      .catch(() => {
        /* 供应商加载失败时仍可关闭 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = useCallback(async () => {
    if (submitting) return;
    if (supplierId === "") {
      setError("请选择供应商");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const order = await api.procurement.createOrder({
        supplier_id: Number(supplierId),
        purchase_request_id: request.id,
      });
      onSuccess(order.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "转单失败，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  }, [submitting, supplierId, request.id, onSuccess]);

  return (
    <Modal open title="转为采购订单" onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-gray-500">
          申请 {request.request_no} 将转为采购订单（草稿状态），行自动复制自申请；
          成功后申请状态变为「已下单」，一张申请至多转一张订单。
        </p>
        <Field label="供应商" required error={null}>
          <select
            value={supplierId === "" ? "" : String(supplierId)}
            onChange={(e) =>
              setSupplierId(e.target.value === "" ? "" : Number(e.target.value))
            }
            disabled={submitting}
            className={inputClass}
            aria-label="订单供应商"
          >
            <option value="">选择供应商…</option>
            {suppliers.map((supplier) => (
              <option key={supplier.id} value={supplier.id}>
                {supplier.name}（{supplier.supplier_code}）
              </option>
            ))}
          </select>
        </Field>
        {error ? (
          <p role="alert" className="text-sm text-red-600">
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
            {submitting ? "转单中…" : "确认转单"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
