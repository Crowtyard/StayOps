"use client";

/**
 * GuestPicker：Guest 搜索 + 创建（新建预订与编辑表单共用）。
 * PII 边界：name/phone/email 仅在持有 guest:read 时渲染（后端已裁剪，前端双保险）。
 */

import { useEffect, useState } from "react";
import { ApiError, api } from "@/lib/api";
import type { GuestCreate, GuestOut } from "@/lib/api/types";
import { Field, inputClass, primaryButtonClass, secondaryButtonClass } from "@/components/booking/shared";
import { Modal } from "@/components/modal";
import { IconSearch } from "@/components/icons";

export interface GuestPickerProps {
  value: number | null;
  /** 当前已选客人（用于展示身份；name/phone 仅 guest:read 时渲染） */
  selected: GuestOut | null;
  onChange: (guest: GuestOut) => void;
  /** guest:read 才允许搜索/展示身份信息 */
  canSearch: boolean;
  /** guest:write 才允许创建 */
  canCreate: boolean;
  error?: string | null;
}

const EMPTY_FORM = { name: "", phone: "", email: "", notes: "" };

export default function GuestPicker({
  value,
  selected,
  onChange,
  canSearch,
  canCreate,
  error,
}: GuestPickerProps) {
  const [query, setQuery] = useState("");
  // 结果携带其查询词：查询词变化后旧结果立即失效（渲染期派生判断，effect 不同步 setState）
  const [result, setResult] = useState<{ query: string; items: GuestOut[] } | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const trimmed = query.trim();
  const fresh = result !== null && result.query === trimmed;

  // 防抖搜索：300ms 内输入变化只发一次请求；过期响应（cleanup 标记）直接丢弃
  useEffect(() => {
    if (!canSearch || trimmed === "") return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setSearching(true);
      setSearchError(null);
      api.guests
        .list({ search: trimmed, page: 1, page_size: 10 })
        .then((page) => {
          if (cancelled) return;
          setResult({ query: trimmed, items: page.items });
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setSearchError(
            err instanceof ApiError ? err.message : "搜索失败，请稍后重试",
          );
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, canSearch, trimmed]);

  async function submitCreate() {
    if (!form.name.trim()) {
      setCreateError("请输入客人姓名");
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const body: GuestCreate = {
        name: form.name.trim(),
        phone: form.phone.trim() || null,
        email: form.email.trim() || null,
        notes: form.notes.trim() || null,
      };
      const created = await api.guests.create(body);
      onChange(created);
      setCreateOpen(false);
      setForm(EMPTY_FORM);
      setQuery("");
      setResult(null);
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "创建失败，请稍后重试");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div>
      <Field label="客人" required error={error}>
        <div className="space-y-2">
          {!canSearch ? (
            <p className="rounded-md bg-gray-50 px-3 py-2 text-sm text-gray-500">
              无权限查看客人信息（需 guest:read）
            </p>
          ) : (
            <>
              <div className="relative">
                <IconSearch className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-gray-400" />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索客人（姓名或手机号）…"
                  className={`${inputClass} pl-9`}
                  aria-label="搜索客人"
                />
              </div>
              {searching ? (
                <p className="text-xs text-gray-400">搜索中…</p>
              ) : null}
              {searchError ? (
                <p role="alert" className="text-xs text-red-600">
                  {searchError}
                </p>
              ) : null}
              {trimmed !== "" && fresh && result.items.length === 0 && !searching ? (
                <div className="flex items-center justify-between gap-2 rounded-md bg-gray-50 px-3 py-2">
                  <p className="text-sm text-gray-500">未找到匹配客人</p>
                  {canCreate ? (
                    <button
                      type="button"
                      onClick={() => setCreateOpen(true)}
                      className={secondaryButtonClass}
                    >
                      新建客人
                    </button>
                  ) : null}
                </div>
              ) : null}
              {trimmed !== "" && fresh && result.items.length > 0 ? (
                <ul className="max-h-44 list-none overflow-y-auto rounded-md border border-gray-200">
                  {result.items.map((guest) => (
                    <li key={guest.id}>
                      <button
                        type="button"
                        onClick={() => {
                          onChange(guest);
                          setQuery("");
                          setResult(null);
                        }}
                        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-gray-50"
                      >
                        <span className="font-medium text-gray-900">
                          {guest.name}
                        </span>
                        <span className="text-xs text-gray-500">
                          {guest.phone || "—"}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {canCreate ? (
                <button
                  type="button"
                  onClick={() => setCreateOpen(true)}
                  className={secondaryButtonClass}
                >
                  新建客人
                </button>
              ) : null}
            </>
          )}
        </div>
      </Field>

      {value !== null ? (
        <p className="mb-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 ring-1 ring-inset ring-emerald-200">
          已选择客人：
          {canSearch && selected
            ? `${selected.name}${selected.phone ? `（${selected.phone}）` : ""}`
            : `ID ${value}`}
        </p>
      ) : null}

      <Modal
        open={createOpen}
        title="新建客人"
        onClose={() => {
          setCreateOpen(false);
          setCreateError(null);
        }}
      >
        <div className="space-y-3">
          <Field label="姓名" required error={null}>
            <input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              className={inputClass}
              aria-label="姓名"
            />
          </Field>
          <Field label="手机号" error={null}>
            <input
              value={form.phone}
              onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
              className={inputClass}
              aria-label="手机号"
            />
          </Field>
          <Field label="邮箱" error={null}>
            <input
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              className={inputClass}
              aria-label="邮箱"
            />
          </Field>
          <Field label="备注" error={null}>
            <textarea
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              className={inputClass}
              rows={2}
              aria-label="备注"
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
              onClick={submitCreate}
              disabled={creating}
              className={primaryButtonClass}
            >
              {creating ? "创建中…" : "创建"}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
