"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, api } from "@/lib/api";
import type { RoleOut, UserOut } from "@/lib/api/types";
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

interface UserFormState {
  username: string;
  password: string;
  displayName: string;
  email: string;
  phone: string;
  roleIds: number[];
}

const EMPTY_FORM: UserFormState = {
  username: "",
  password: "",
  displayName: "",
  email: "",
  phone: "",
  roleIds: [],
};

function toForm(user: UserOut): UserFormState {
  return {
    username: user.username,
    password: "",
    displayName: user.display_name ?? "",
    email: user.email ?? "",
    phone: user.phone ?? "",
    roleIds: user.roles.map((r) => r.id),
  };
}

export default function UsersView() {
  const user = useUser();
  const permissions = useMemo(
    () => new Set(user?.permissions ?? []),
    [user],
  );
  const canWrite = permissions.has("user:write");
  const canDelete = permissions.has("user:delete");
  const canSeeRoles = permissions.has("role:read");

  const load = useCallback(
    () => api.users.list({ page: 1, page_size: 100 }),
    [],
  );
  const { items, total, error, reload } = usePageFetch<UserOut>(load, []);

  // 角色选项（仅在有 role:read 时加载，用于创建/编辑时分配角色）
  const [roles, setRoles] = useState<RoleOut[] | null>(null);
  useEffect(() => {
    if (!canSeeRoles) return;
    let cancelled = false;
    api.roles
      .list({ page: 1, page_size: 100 })
      .then((page) => {
        if (!cancelled) setRoles(page.items);
      })
      .catch(() => {
        // 角色列表加载失败不阻塞用户列表
      });
    return () => {
      cancelled = true;
    };
  }, [canSeeRoles]);

  const [dialog, setDialog] = useState<
    | { mode: "create" }
    | { mode: "edit"; user: UserOut }
    | null
  >(null);
  const [form, setForm] = useState<UserFormState>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UserOut | null>(null);
  const [actionMessage, setActionMessage] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);

  const isSelf = useCallback(
    (target: UserOut) => user !== null && target.id === user.id,
    [user],
  );

  function openCreate() {
    setForm(EMPTY_FORM);
    setDialogError(null);
    setDialog({ mode: "create" });
  }

  function openEdit(target: UserOut) {
    setForm(toForm(target));
    setDialogError(null);
    setDialog({ mode: "edit", user: target });
  }

  async function submitForm() {
    if (!dialog) return;
    setBusy(true);
    setDialogError(null);
    try {
      if (dialog.mode === "create") {
        const created = await api.users.create({
          username: form.username.trim(),
          password: form.password,
          display_name: form.displayName.trim() || null,
          email: form.email.trim() || null,
          phone: form.phone.trim() || null,
          is_active: true,
        });
        if (canSeeRoles && form.roleIds.length > 0) {
          await api.users.assignRoles(created.id, form.roleIds);
        }
        setActionMessage({ kind: "success", text: `用户「${created.username}」已创建` });
      } else {
        const body: Parameters<typeof api.users.update>[1] = {
          username: form.username.trim(),
          display_name: form.displayName.trim() || null,
          email: form.email.trim() || null,
          phone: form.phone.trim() || null,
        };
        if (form.password) body.password = form.password;
        const updated = await api.users.update(dialog.user.id, body);
        if (canSeeRoles) {
          await api.users.assignRoles(updated.id, form.roleIds);
        }
        setActionMessage({ kind: "success", text: `用户「${updated.username}」已更新` });
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

  async function toggleActive(target: UserOut) {
    setActionMessage(null);
    try {
      const updated = await api.users.update(target.id, {
        is_active: !target.is_active,
      });
      setActionMessage({
        kind: "success",
        text: `用户「${updated.username}」已${updated.is_active ? "启用" : "停用"}`,
      });
      reload();
    } catch (err) {
      setActionMessage({
        kind: "error",
        text: err instanceof ApiError ? err.message : "操作失败，请稍后重试",
      });
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setBusy(true);
    setActionMessage(null);
    try {
      await api.users.remove(deleteTarget.id);
      setActionMessage({
        kind: "success",
        text: `用户「${deleteTarget.username}」已删除`,
      });
      setDeleteTarget(null);
      reload();
    } catch (err) {
      setActionMessage({
        kind: "error",
        text: err instanceof ApiError ? err.message : "删除失败，请稍后重试",
      });
    } finally {
      setBusy(false);
    }
  }

  if (error) return listErrorView(error, reload);
  if (items === null) return <Loading text="正在加载用户列表…" />;

  return (
    <div>
      <SettingsHeader
        title="用户管理"
        description="系统账号列表：创建/编辑用户、启用停用、分配角色（权限由后端校验）"
        action={
          canWrite ? (
            <button
              type="button"
              onClick={openCreate}
              className="inline-flex items-center gap-1.5 rounded-md bg-gray-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-gray-700"
            >
              <IconPlus className="size-4" />
              新建用户
            </button>
          ) : null
        }
      />

      <div className="space-y-4">
        {actionMessage ? <ActionMessage message={actionMessage} /> : null}

        {items.length === 0 ? (
          <Empty text="暂无用户" />
        ) : (
          <>
            <p className="text-sm text-gray-500">
              共 {total ?? items.length} 个用户
            </p>
            <TableShell>
              <thead className="bg-gray-50">
                <tr className="text-left text-xs text-gray-500">
                  <th className="px-4 py-3 font-medium">用户名</th>
                  <th className="px-4 py-3 font-medium">姓名</th>
                  <th className="px-4 py-3 font-medium">角色</th>
                  <th className="px-4 py-3 font-medium">状态</th>
                  <th className="px-4 py-3 font-medium">创建时间</th>
                  {canWrite || canDelete ? (
                    <th className="px-4 py-3 font-medium">操作</th>
                  ) : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 text-gray-900">
                {items.map((u) => (
                  <tr key={u.id}>
                    <td className="px-4 py-3">
                      <span className="font-medium">{u.username}</span>
                      {isSelf(u) ? (
                        <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">
                          当前账号
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {u.display_name ?? "—"}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {u.roles.length === 0 ? (
                          <span className="text-xs text-gray-400">未分配角色</span>
                        ) : (
                          u.roles.map((r) => (
                            <span
                              key={r.id}
                              className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600"
                            >
                              {r.name}
                            </span>
                          ))
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
                          u.is_active
                            ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                            : "bg-red-50 text-red-700 ring-red-200"
                        }`}
                      >
                        {u.is_active ? "启用" : "停用"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {formatDateTime(u.created_at)}
                    </td>
                    {canWrite || canDelete ? (
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1.5">
                          {canWrite ? (
                            <>
                              <button
                                type="button"
                                onClick={() => openEdit(u)}
                                className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                              >
                                <IconPencil className="size-3.5" />
                                编辑
                              </button>
                              <button
                                type="button"
                                disabled={isSelf(u)}
                                title={isSelf(u) ? "不能停用当前登录用户" : undefined}
                                onClick={() => void toggleActive(u)}
                                className="rounded-md border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {u.is_active ? "停用" : "启用"}
                              </button>
                            </>
                          ) : null}
                          {canDelete ? (
                            <button
                              type="button"
                              disabled={isSelf(u)}
                              title={isSelf(u) ? "不能删除当前登录用户" : undefined}
                              onClick={() => setDeleteTarget(u)}
                              className="inline-flex items-center gap-1 rounded-md border border-red-200 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
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

      {/* 创建 / 编辑用户 */}
      <Modal
        open={dialog !== null}
        title={dialog?.mode === "create" ? "新建用户" : "编辑用户"}
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
          <Field label="用户名" htmlFor="user-username" required>
            <input
              id="user-username"
              type="text"
              required
              autoComplete="off"
              value={form.username}
              onChange={(e) =>
                setForm((f) => ({ ...f, username: e.target.value }))
              }
              className={inputClass}
              placeholder="登录用户名（唯一）"
            />
          </Field>
          <Field
            label={dialog?.mode === "create" ? "初始密码" : "重置密码"}
            htmlFor="user-password"
            required={dialog?.mode === "create"}
            hint={
              dialog?.mode === "create"
                ? "至少 8 位，请勿使用明文存储（后端仅保存哈希）"
                : "留空表示不修改密码"
            }
          >
            <input
              id="user-password"
              type="password"
              required={dialog?.mode === "create"}
              minLength={8}
              autoComplete="new-password"
              value={form.password}
              onChange={(e) =>
                setForm((f) => ({ ...f, password: e.target.value }))
              }
              className={inputClass}
              placeholder={
                dialog?.mode === "create" ? "请输入初始密码" : "留空不修改"
              }
            />
          </Field>
          <Field label="姓名" htmlFor="user-display-name">
            <input
              id="user-display-name"
              type="text"
              value={form.displayName}
              onChange={(e) =>
                setForm((f) => ({ ...f, displayName: e.target.value }))
              }
              className={inputClass}
              placeholder="员工姓名（选填）"
            />
          </Field>
          <Field label="邮箱" htmlFor="user-email">
            <input
              id="user-email"
              type="email"
              value={form.email}
              onChange={(e) =>
                setForm((f) => ({ ...f, email: e.target.value }))
              }
              className={inputClass}
              placeholder="name@example.com（选填）"
            />
          </Field>
          <Field label="电话" htmlFor="user-phone">
            <input
              id="user-phone"
              type="tel"
              value={form.phone}
              onChange={(e) =>
                setForm((f) => ({ ...f, phone: e.target.value }))
              }
              className={inputClass}
              placeholder="手机号（选填）"
            />
          </Field>

          {canSeeRoles ? (
            <fieldset>
              <legend className="mb-1.5 block text-sm font-medium text-gray-700">
                分配角色
              </legend>
              <div className="rounded-md border border-gray-200 p-3">
                {roles === null ? (
                  <p className="text-xs text-gray-500">正在加载角色列表…</p>
                ) : roles.length === 0 ? (
                  <p className="text-xs text-gray-500">暂无可用角色</p>
                ) : (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {roles.map((r) => {
                      const checked = form.roleIds.includes(r.id);
                      return (
                        <label
                          key={r.id}
                          className="flex items-center gap-2 text-sm text-gray-700"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) =>
                              setForm((f) => ({
                                ...f,
                                roleIds: e.target.checked
                                  ? [...f.roleIds, r.id]
                                  : f.roleIds.filter((id) => id !== r.id),
                              }))
                            }
                            className="size-4 rounded border-gray-300"
                          />
                          {r.name}
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            </fieldset>
          ) : null}

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
        title="确认删除用户"
        message={`确定要删除用户「${deleteTarget?.username ?? ""}」吗？该操作不可恢复，其历史审计记录将被保留。`}
        confirmLabel="删除"
        busy={busy}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
