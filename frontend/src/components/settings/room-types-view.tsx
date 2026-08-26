"use client";

import { useCallback, useMemo, useState } from "react";
import { ApiError, api } from "@/lib/api";
import type { RoomTypeOut } from "@/lib/api/types";
import { useUser } from "@/components/app-shell";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Modal } from "@/components/modal";
import { Empty, Loading } from "@/components/status-views";
import { IconPencil, IconPlus, IconTrash } from "@/components/icons";
import {
  ActionMessage,
  Field,
  SettingsHeader,
  TableShell,
  formatDateTime,
  inputClass,
  listErrorView,
  usePageFetch,
} from "@/components/settings/shared";

interface RoomTypeFormState {
  name: string;
  basePrice: string;
  capacity: string;
  description: string;
}

const EMPTY_FORM: RoomTypeFormState = {
  name: "",
  basePrice: "",
  capacity: "2",
  description: "",
};

function toForm(rt: RoomTypeOut): RoomTypeFormState {
  return {
    name: rt.name,
    basePrice: rt.base_price,
    capacity: String(rt.capacity),
    description: rt.description ?? "",
  };
}

function formatPrice(value: string): string {
  const num = Number(value);
  if (Number.isNaN(num)) return `¥${value}`;
  return `¥${num.toFixed(2)}`;
}

export default function RoomTypesView() {
  const user = useUser();
  const permissions = useMemo(
    () => new Set(user?.permissions ?? []),
    [user],
  );
  const canWrite = permissions.has("room_type:write");
  const canDelete = permissions.has("room_type:delete");

  const load = useCallback(
    () => api.roomTypes.list({ page: 1, page_size: 100 }),
    [],
  );
  const { items, total, error, reload } = usePageFetch<RoomTypeOut>(load, []);

  const [dialog, setDialog] = useState<
    { mode: "create" } | { mode: "edit"; roomType: RoomTypeOut } | null
  >(null);
  const [form, setForm] = useState<RoomTypeFormState>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RoomTypeOut | null>(null);
  const [actionMessage, setActionMessage] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);

  function openCreate() {
    setForm(EMPTY_FORM);
    setDialogError(null);
    setDialog({ mode: "create" });
  }

  function openEdit(rt: RoomTypeOut) {
    setForm(toForm(rt));
    setDialogError(null);
    setDialog({ mode: "edit", roomType: rt });
  }

  async function submitForm() {
    if (!dialog) return;
    setBusy(true);
    setDialogError(null);
    try {
      const body = {
        name: form.name.trim(),
        base_price: form.basePrice.trim(),
        capacity: Number(form.capacity),
        description: form.description.trim() || null,
      };
      if (dialog.mode === "create") {
        const created = await api.roomTypes.create(body);
        setActionMessage({ kind: "success", text: `房型「${created.name}」已创建` });
      } else {
        const updated = await api.roomTypes.update(dialog.roomType.id, body);
        setActionMessage({ kind: "success", text: `房型「${updated.name}」已更新` });
      }
      setDialog(null);
      reload();
    } catch (err) {
      setDialogError(
        err instanceof ApiError ? err.message : "保存失败，请稍后重试",
      );
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setBusy(true);
    setActionMessage(null);
    try {
      await api.roomTypes.remove(deleteTarget.id);
      setActionMessage({
        kind: "success",
        text: `房型「${deleteTarget.name}」已删除`,
      });
      setDeleteTarget(null);
      reload();
    } catch (err) {
      // 409（该房型下仍有房间）等冲突直接展示后端可读文案
      setActionMessage({
        kind: "error",
        text: err instanceof ApiError ? err.message : "删除失败，请稍后重试",
      });
    } finally {
      setBusy(false);
    }
  }

  if (error) return listErrorView(error, reload);
  if (items === null) return <Loading text="正在加载房型列表…" />;

  return (
    <div>
      <SettingsHeader
        title="房型管理"
        description="客房房型配置：名称、基础价格、容纳人数；房型下仍有房间时后端拒绝删除（409）"
        action={
          canWrite ? (
            <button
              type="button"
              onClick={openCreate}
              className="inline-flex items-center gap-1.5 rounded-md bg-gray-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-gray-700"
            >
              <IconPlus className="size-4" />
              新建房型
            </button>
          ) : null
        }
      />

      <div className="space-y-4">
        {actionMessage ? <ActionMessage message={actionMessage} /> : null}

        {items.length === 0 ? (
          <Empty text="暂无房型" />
        ) : (
          <>
            <p className="text-sm text-gray-500">
              共 {total ?? items.length} 个房型
            </p>
            <TableShell>
              <thead className="bg-gray-50">
                <tr className="text-left text-xs text-gray-500">
                  <th className="px-4 py-3 font-medium">名称</th>
                  <th className="px-4 py-3 font-medium">描述</th>
                  <th className="px-4 py-3 font-medium">基础价格</th>
                  <th className="px-4 py-3 font-medium">容纳人数</th>
                  <th className="px-4 py-3 font-medium">房间数</th>
                  <th className="px-4 py-3 font-medium">创建时间</th>
                  {canWrite || canDelete ? (
                    <th className="px-4 py-3 font-medium">操作</th>
                  ) : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 text-gray-900">
                {items.map((rt) => (
                  <tr key={rt.id}>
                    <td className="px-4 py-3 font-medium">{rt.name}</td>
                    <td className="max-w-xs px-4 py-3 text-gray-600">
                      {rt.description ?? "—"}
                    </td>
                    <td className="px-4 py-3 tabular-nums">
                      {formatPrice(rt.base_price)}
                    </td>
                    <td className="px-4 py-3">{rt.capacity} 人</td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded px-1.5 py-0.5 text-xs ${
                          rt.room_count > 0
                            ? "bg-gray-100 text-gray-600"
                            : "bg-emerald-50 text-emerald-700"
                        }`}
                      >
                        {rt.room_count > 0
                          ? `${rt.room_count} 间`
                          : "暂无房间"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {formatDateTime(rt.created_at)}
                    </td>
                    {canWrite || canDelete ? (
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1.5">
                          {canWrite ? (
                            <button
                              type="button"
                              onClick={() => openEdit(rt)}
                              className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                            >
                              <IconPencil className="size-3.5" />
                              编辑
                            </button>
                          ) : null}
                          {canDelete ? (
                            <button
                              type="button"
                              onClick={() => setDeleteTarget(rt)}
                              className="inline-flex items-center gap-1 rounded-md border border-red-200 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
                            >
                              <IconTrash className="size-3.5" />
                              删除
                            </button>
                          ) : null}
                        </div>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </TableShell>
          </>
        )}
      </div>

      {/* 创建 / 编辑房型 */}
      <Modal
        open={dialog !== null}
        title={dialog?.mode === "create" ? "新建房型" : "编辑房型"}
        onClose={() => {
          if (!busy) setDialog(null);
        }}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submitForm();
          }}
          className="space-y-4"
        >
          <Field label="名称" htmlFor="room-type-name" required>
            <input
              id="room-type-name"
              type="text"
              required
              autoComplete="off"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              className={inputClass}
              placeholder="如：标准大床房"
            />
          </Field>
          <Field
            label="基础价格（元/晚）"
            htmlFor="room-type-price"
            required
            hint="后端以 Decimal 字符串存储，避免浮点精度问题"
          >
            <input
              id="room-type-price"
              type="number"
              required
              min="0"
              step="0.01"
              value={form.basePrice}
              onChange={(e) =>
                setForm((f) => ({ ...f, basePrice: e.target.value }))
              }
              className={inputClass}
              placeholder="如：328.00"
            />
          </Field>
          <Field label="容纳人数" htmlFor="room-type-capacity" required>
            <input
              id="room-type-capacity"
              type="number"
              required
              min="1"
              value={form.capacity}
              onChange={(e) =>
                setForm((f) => ({ ...f, capacity: e.target.value }))
              }
              className={inputClass}
            />
          </Field>
          <Field label="描述" htmlFor="room-type-description">
            <textarea
              id="room-type-description"
              rows={3}
              value={form.description}
              onChange={(e) =>
                setForm((f) => ({ ...f, description: e.target.value }))
              }
              className={inputClass}
              placeholder="床型、景观等说明（选填）"
            />
          </Field>

          {dialogError ? (
            <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-inset ring-red-200" role="alert">
              {dialogError}
            </p>
          ) : null}

          <div className="flex justify-end gap-2.5 pt-1">
            <button
              type="button"
              onClick={() => setDialog(null)}
              disabled={busy}
              className="rounded-md border border-gray-300 px-3.5 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={busy}
              className="rounded-md bg-gray-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
            >
              {busy ? "保存中…" : "保存"}
            </button>
          </div>
        </form>
      </Modal>

      {/* 删除确认 */}
      <ConfirmDialog
        open={deleteTarget !== null}
        title="确认删除房型"
        message={`确定要删除房型「${deleteTarget?.name ?? ""}」吗？若该房型下仍有房间，后端将拒绝删除。`}
        confirmLabel="删除"
        busy={busy}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
