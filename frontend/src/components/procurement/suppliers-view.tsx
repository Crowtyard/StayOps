"use client";

/**
 * /procurement/suppliers 供应商管理（Sprint 7 §22）：
 * - 列表 + 新建 / 编辑 / 停用（is_active，不物理删除）
 * - 权限：读 procurement:read；写 procurement:supplier_manage
 *   （后端 403 为最终权威）
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ApiError, api } from "@/lib/api";
import type { SupplierOut } from "@/lib/api/types";
import { useUser } from "@/components/app-shell";
import { ErrorView, Forbidden, Loading } from "@/components/status-views";
import { Modal } from "@/components/modal";
import { Field, inputClass } from "@/components/booking/shared";

export default function SuppliersView() {
  const router = useRouter();
  const user = useUser();
  const permissions = useMemo(() => new Set(user?.permissions ?? []), [user]);
  const canRead = permissions.has("procurement:read");
  const canManage = permissions.has("procurement:supplier_manage");

  const [suppliers, setSuppliers] = useState<SupplierOut[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [editing, setEditing] = useState<SupplierOut | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    if (!canRead) return;
    let cancelled = false;
    const load = async () => {
      try {
        const all: SupplierOut[] = [];
        let page = 1;
        for (;;) {
          const result = await api.procurement.listSuppliers({
            page,
            page_size: 100,
          });
          all.push(...result.items);
          if (result.page * result.page_size >= result.total) break;
          page += 1;
        }
        if (!cancelled) setSuppliers(all);
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
  }, [canRead, router, reloadKey]);

  const refresh = useCallback(() => {
    setError(null);
    setReloadKey((k) => k + 1);
  }, []);

  if (!canRead) {
    return <Forbidden text="无权限访问供应商（缺少 procurement:read）" />;
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
  if (!suppliers) {
    return <Loading text="正在加载供应商…" />;
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
          <h1 className="text-xl font-semibold text-gray-900">供应商</h1>
          <p className="mt-1 text-sm text-gray-500">
            采购供应商档案（停用不删除；不含银行/税务/合同信息）
          </p>
        </div>
        {canManage ? (
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="rounded-md bg-gray-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-gray-700"
          >
            新建供应商
          </button>
        ) : null}
      </div>

      <div className="mt-5 overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50 text-left text-xs font-medium text-gray-500">
            <tr>
              <th className="px-4 py-3">代码</th>
              <th className="px-4 py-3">名称</th>
              <th className="px-4 py-3">联系人</th>
              <th className="px-4 py-3">电话</th>
              <th className="px-4 py-3">状态</th>
              {canManage ? <th className="px-4 py-3 text-right">操作</th> : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {suppliers.length === 0 ? (
              <tr>
                <td
                  colSpan={canManage ? 6 : 5}
                  className="px-4 py-12 text-center text-gray-400"
                >
                  暂无供应商，请先创建
                </td>
              </tr>
            ) : (
              suppliers.map((supplier) => (
                <tr key={supplier.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900">
                    {supplier.supplier_code}
                  </td>
                  <td className="px-4 py-3 text-gray-700">{supplier.name}</td>
                  <td className="px-4 py-3 text-gray-500">
                    {supplier.contact_name ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-gray-500">
                    {supplier.phone ?? "—"}
                  </td>
                  <td className="px-4 py-3">
                    {supplier.is_active ? (
                      <span className="inline-flex items-center rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-800 ring-1 ring-inset ring-emerald-300">
                        启用
                      </span>
                    ) : (
                      <span className="inline-flex items-center rounded-full bg-slate-200 px-2.5 py-0.5 text-xs font-medium text-slate-700 ring-1 ring-inset ring-slate-400">
                        已停用
                      </span>
                    )}
                  </td>
                  {canManage ? (
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => setEditing(supplier)}
                        className="text-xs font-medium text-gray-900 underline-offset-2 hover:underline"
                      >
                        编辑
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <SupplierFormModal
        open={showCreate}
        supplier={null}
        onClose={() => setShowCreate(false)}
        onSuccess={() => {
          setShowCreate(false);
          refresh();
        }}
      />
      {editing ? (
        <SupplierFormModal
          open
          supplier={editing}
          onClose={() => setEditing(null)}
          onSuccess={() => {
            setEditing(null);
            refresh();
          }}
        />
      ) : null}
    </div>
  );
}

export function SupplierFormModal({
  open,
  supplier,
  onClose,
  onSuccess,
}: {
  open: boolean;
  supplier: SupplierOut | null;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [code, setCode] = useState(supplier?.supplier_code ?? "");
  const [name, setName] = useState(supplier?.name ?? "");
  const [contactName, setContactName] = useState(supplier?.contact_name ?? "");
  const [phone, setPhone] = useState(supplier?.phone ?? "");
  const [wechat, setWechat] = useState(supplier?.wechat ?? "");
  const [isActive, setIsActive] = useState(supplier?.is_active ?? true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    if (submitting) return;
    if (code.trim() === "" || name.trim() === "") {
      setError("请填写供应商代码与名称");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      if (supplier) {
        await api.procurement.updateSupplier(supplier.id, {
          name: name.trim(),
          contact_name: contactName.trim() || null,
          phone: phone.trim() || null,
          wechat: wechat.trim() || null,
          is_active: isActive,
        });
      } else {
        await api.procurement.createSupplier({
          supplier_code: code.trim(),
          name: name.trim(),
          contact_name: contactName.trim() || null,
          phone: phone.trim() || null,
          wechat: wechat.trim() || null,
        });
      }
      onSuccess();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "保存失败，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  }, [
    submitting,
    supplier,
    code,
    name,
    contactName,
    phone,
    wechat,
    isActive,
    onSuccess,
  ]);

  return (
    <Modal
      open={open}
      title={supplier ? "编辑供应商" : "新建供应商"}
      onClose={onClose}
    >
      <div className="space-y-4">
        <Field label="供应商代码" required error={null}>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            disabled={submitting || supplier !== null}
            maxLength={50}
            placeholder="例如：SUP-001"
            className={inputClass}
            aria-label="供应商代码"
          />
        </Field>
        <Field label="供应商名称" required error={null}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={submitting}
            maxLength={100}
            className={inputClass}
            aria-label="供应商名称"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="联系人" error={null}>
            <input
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
              disabled={submitting}
              maxLength={100}
              className={inputClass}
              aria-label="联系人"
            />
          </Field>
          <Field label="电话" error={null}>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              disabled={submitting}
              maxLength={32}
              className={inputClass}
              aria-label="电话"
            />
          </Field>
        </div>
        <Field label="微信" error={null}>
          <input
            value={wechat}
            onChange={(e) => setWechat(e.target.value)}
            disabled={submitting}
            maxLength={100}
            className={inputClass}
            aria-label="微信"
          />
        </Field>
        {supplier ? (
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              disabled={submitting}
              className="size-4 rounded border-gray-300 text-gray-900 focus:ring-gray-900"
              aria-label="是否启用"
            />
            <span className="text-sm text-gray-700">启用（停用不删除档案）</span>
          </label>
        ) : null}
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
            {submitting ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
