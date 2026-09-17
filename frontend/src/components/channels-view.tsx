"use client";

/**
 * 渠道管理（alpha.9.6 F3）。
 *
 * 现场需求：OTA 不能只叫「OTA」，需拆分为 美团 / 携程 / 飞猪 / 其他，
 * 且「其他」需要可编辑/扩展。
 *
 * 设计要点：
 * - **不做 `channel=OTHER + other_text`**：所有渠道在 channels 表中平权，
 *   「其他」只是其中一行默认渠道；经营者可自由新增「抖音 / 小红书 / 途家 /
 *   Booking / Agoda」等任意渠道，经营分析中各自独立成行，长期可分析。
 * - 系统预置渠道（美团 / 携程 / 飞猪 / 直销 / 电话 / 微信 / 散客 / 协议客户）
 *   名称固定、不可删除，仅可停用（后端强制，409 原样展示）。
 * - 停用不释放名称（避免经营分析出现同名渠道），历史预订仍保留其渠道归属。
 * - 权限：channel:read 查看；channel:write 管理（后端强制）。
 */

import { useCallback, useMemo, useState } from "react";
import { ApiError, api } from "@/lib/api";
import type { ChannelCategory, ChannelOut } from "@/lib/api/types";
import { useUser } from "@/components/app-shell";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Modal } from "@/components/modal";
import { Empty, Forbidden, Loading } from "@/components/status-views";
import { IconPencil, IconPlus, IconTrash } from "@/components/icons";
import {
  ActionMessage,
  Field,
  SettingsHeader,
  TableShell,
  inputClass,
  listErrorView,
  usePageFetch,
} from "@/components/settings/shared";
import {
  CHANNEL_CATEGORY_LABELS,
  CHANNEL_CATEGORY_ORDER,
} from "@/lib/channels";

interface ChannelFormState {
  name: string;
  category: ChannelCategory;
  sortOrder: string;
}

const EMPTY_FORM: ChannelFormState = {
  name: "",
  category: "OTHER",
  sortOrder: "0",
};

function toForm(channel: ChannelOut): ChannelFormState {
  return {
    name: channel.name,
    category: channel.category,
    sortOrder: String(channel.sort_order),
  };
}

export default function ChannelsView() {
  const user = useUser();
  const permissions = useMemo(
    () => new Set(user?.permissions ?? []),
    [user],
  );
  const canRead = permissions.has("channel:read");
  const canWrite = permissions.has("channel:write");

  const load = useCallback(
    () =>
      // 无 channel:read 时不发起请求（禁止 fetch -> 403 -> 静默隐藏）
      canRead
        ? api.channels.list({
            page: 1,
            page_size: 100,
            include_disabled: true,
          })
        : Promise.resolve({ items: [], total: 0, page: 1, page_size: 100 }),
    [canRead],
  );
  const { items, total, error, reload } = usePageFetch<ChannelOut>(load, [
    canRead,
  ]);

  const [dialog, setDialog] = useState<
    { mode: "create" } | { mode: "edit"; channel: ChannelOut } | null
  >(null);
  const [form, setForm] = useState<ChannelFormState>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [toggleTarget, setToggleTarget] = useState<ChannelOut | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ChannelOut | null>(null);
  const [actionMessage, setActionMessage] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);

  if (!canRead) {
    return <Forbidden text="无权限查看渠道主数据（需要 channel:read）" />;
  }
  if (canRead && error) return listErrorView(error, reload);
  if (!canRead || items === null) return <Loading text="正在加载渠道列表…" />;

  function openCreate() {
    setForm(EMPTY_FORM);
    setDialogError(null);
    setDialog({ mode: "create" });
  }

  function openEdit(channel: ChannelOut) {
    setForm(toForm(channel));
    setDialogError(null);
    setDialog({ mode: "edit", channel });
  }

  async function submitForm() {
    if (!dialog) return;
    setBusy(true);
    setDialogError(null);
    try {
      if (dialog.mode === "create") {
        const created = await api.channels.create({
          name: form.name.trim(),
          category: form.category,
          sort_order: Number(form.sortOrder) || 0,
        });
        setActionMessage({
          kind: "success",
          text: `渠道「${created.name}」已创建`,
        });
      } else {
        const updated = await api.channels.patch(dialog.channel.id, {
          name: form.name.trim(),
          category: form.category,
          sort_order: Number(form.sortOrder) || 0,
        });
        setActionMessage({
          kind: "success",
          text: `渠道「${updated.name}」已更新`,
        });
      }
      setDialog(null);
      reload();
    } catch (err) {
      // 409（名称重复 / 系统渠道名称固定）直接展示后端可读文案
      setDialogError(
        err instanceof ApiError ? err.message : "保存失败，请稍后重试",
      );
    } finally {
      setBusy(false);
    }
  }

  async function toggleEnabled() {
    if (!toggleTarget) return;
    const target = toggleTarget;
    setBusy(true);
    setActionMessage(null);
    try {
      const updated = target.enabled
        ? await api.channels.disable(target.id)
        : await api.channels.enable(target.id);
      setActionMessage({
        kind: "success",
        text: `渠道「${updated.name}」已${updated.enabled ? "启用" : "停用"}`,
      });
      setToggleTarget(null);
      reload();
    } catch (err) {
      setActionMessage({
        kind: "error",
        text: err instanceof ApiError ? err.message : "操作失败，请稍后重试",
      });
      setToggleTarget(null);
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setBusy(true);
    setActionMessage(null);
    try {
      await api.channels.remove(deleteTarget.id);
      setActionMessage({
        kind: "success",
        text: `渠道「${deleteTarget.name}」已删除`,
      });
      setDeleteTarget(null);
      reload();
    } catch (err) {
      setActionMessage({
        kind: "error",
        text: err instanceof ApiError ? err.message : "删除失败，请稍后重试",
      });
      setDeleteTarget(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <SettingsHeader
        title="渠道管理"
        description="客源渠道主数据：订单来源统一从此处选择。系统预置渠道名称固定、不可删除，仅可停用；自定义渠道可改名、可停用；已被预订使用的渠道不能删除（请改用停用），历史记录不受影响。"
        action={
          canWrite ? (
            <button
              type="button"
              onClick={openCreate}
              className="inline-flex items-center gap-1.5 rounded-md bg-gray-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-gray-700"
            >
              <IconPlus className="size-4" />
              新增渠道
            </button>
          ) : null
        }
      />

      <div className="space-y-4">
        {actionMessage ? <ActionMessage message={actionMessage} /> : null}

        {items.length === 0 ? (
          <Empty text="暂无渠道" />
        ) : (
          <>
            <p className="text-sm text-gray-500">
              共 {total ?? items.length} 个渠道（含已停用）
            </p>
            <TableShell>
              <thead className="bg-gray-50">
                <tr className="text-left text-xs text-gray-500">
                  <th className="px-4 py-3 font-medium">渠道名称</th>
                  <th className="px-4 py-3 font-medium">类别</th>
                  <th className="px-4 py-3 font-medium">编码</th>
                  <th className="px-4 py-3 font-medium">排序</th>
                  <th className="px-4 py-3 font-medium">状态</th>
                  <th className="px-4 py-3 font-medium">来源</th>
                  {canWrite ? (
                    <th className="px-4 py-3 font-medium">操作</th>
                  ) : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 text-gray-900">
                {items.map((channel) => (
                  <tr
                    key={channel.id}
                    className={channel.enabled ? "" : "bg-gray-50"}
                  >
                    <td className="px-4 py-3 font-medium">{channel.name}</td>
                    <td className="px-4 py-3 text-gray-600">
                      {CHANNEL_CATEGORY_LABELS[channel.category]}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-500">
                      {channel.code}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-gray-600">
                      {channel.sort_order}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded px-1.5 py-0.5 text-xs ${
                          channel.enabled
                            ? "bg-emerald-50 text-emerald-700"
                            : "bg-gray-200 text-gray-600"
                        }`}
                      >
                        {channel.enabled ? "启用中" : "已停用"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {channel.is_system ? "系统预置" : "自定义"}
                    </td>
                    {canWrite ? (
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1.5">
                          <button
                            type="button"
                            onClick={() => openEdit(channel)}
                            className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                          >
                            <IconPencil className="size-3.5" />
                            编辑
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setActionMessage(null);
                              setToggleTarget(channel);
                            }}
                            className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium ${
                              channel.enabled
                                ? "border-amber-200 text-amber-700 hover:bg-amber-50"
                                : "border-emerald-200 text-emerald-700 hover:bg-emerald-50"
                            }`}
                          >
                            {channel.enabled ? "停用" : "启用"}
                          </button>
                          {channel.is_system ? null : (
                            <button
                              type="button"
                              onClick={() => {
                                setActionMessage(null);
                                setDeleteTarget(channel);
                              }}
                              className="inline-flex items-center gap-1 rounded-md border border-red-200 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
                            >
                              <IconTrash className="size-3.5" />
                              删除
                            </button>
                          )}
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

      {/* 新增 / 编辑渠道 */}
      <Modal
        open={dialog !== null}
        title={dialog?.mode === "create" ? "新增渠道" : "编辑渠道"}
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
          <Field
            label="渠道名称"
            htmlFor="channel-name"
            required
            hint={
              dialog?.mode === "edit" && dialog.channel.is_system
                ? "系统预置渠道名称固定，不可修改（可改类别 / 排序 / 启停）"
                : "如：抖音、小红书、途家、Booking、协议客户"
            }
          >
            <input
              id="channel-name"
              type="text"
              required
              autoComplete="off"
              disabled={
                dialog?.mode === "edit" &&
                dialog.channel.is_system &&
                !["CUSTOM_OTHER", "CUSTOM_LEGACY"].includes(dialog.channel.code)
              }
              value={form.name}
              onChange={(e) =>
                setForm((f) => ({ ...f, name: e.target.value }))
              }
              className={inputClass}
              placeholder="如：抖音"
            />
          </Field>

          <Field label="类别" htmlFor="channel-category" required>
            <select
              id="channel-category"
              value={form.category}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  category: e.target.value as ChannelCategory,
                }))
              }
              className={inputClass}
            >
              {CHANNEL_CATEGORY_ORDER.map((category) => (
                <option key={category} value={category}>
                  {CHANNEL_CATEGORY_LABELS[category]}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="排序"
            htmlFor="channel-sort"
            hint="数值越小越靠前（用于预订表单中的渠道顺序）"
          >
            <input
              id="channel-sort"
              type="number"
              min="0"
              max="9999"
              value={form.sortOrder}
              onChange={(e) =>
                setForm((f) => ({ ...f, sortOrder: e.target.value }))
              }
              className={inputClass}
            />
          </Field>

          {dialogError ? (
            <p
              role="alert"
              className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-inset ring-red-200"
            >
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

      {/* 停用 / 启用确认 */}
      <ConfirmDialog
        open={toggleTarget !== null}
        title={toggleTarget?.enabled ? "确认停用渠道" : "确认启用渠道"}
        message={
          toggleTarget?.enabled
            ? `确定要停用渠道「${toggleTarget?.name ?? ""}」吗？停用后该渠道不再出现在预订的来源渠道下拉中，但历史预订仍保留其渠道归属，经营分析也仍能看到历史业绩。`
            : `确定要恢复启用渠道「${toggleTarget?.name ?? ""}」吗？`
        }
        confirmLabel={toggleTarget?.enabled ? "停用" : "启用"}
        busy={busy}
        onConfirm={() => void toggleEnabled()}
        onCancel={() => setToggleTarget(null)}
      />

      {/* 删除确认 */}
      <ConfirmDialog
        open={deleteTarget !== null}
        title="确认删除渠道"
        message={`确定要删除渠道「${deleteTarget?.name ?? ""}」吗？仅当该渠道从未被任何预订使用时才会成功；否则后端会拒绝并建议改用停用。`}
        confirmLabel="删除"
        busy={busy}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
