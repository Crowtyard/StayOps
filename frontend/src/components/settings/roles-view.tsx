"use client";

import { useCallback, useMemo, useState } from "react";
import { ApiError, api } from "@/lib/api";
import type { PermissionOut, RoleOut } from "@/lib/api/types";
import { useUser } from "@/components/app-shell";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Modal } from "@/components/modal";
import { Empty, Loading } from "@/components/status-views";
import { IconEye, IconPencil, IconPlus, IconTrash } from "@/components/icons";
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

export default function RolesView() {
  const user = useUser();
  const permissions = useMemo(
    () => new Set(user?.permissions ?? []),
    [user],
  );
  const canWrite = permissions.has("role:write");
  const canDelete = permissions.has("role:delete");

  const load = useCallback(
    () => api.roles.list({ page: 1, page_size: 100 }),
    [],
  );
  const { items, total, error, reload } = usePageFetch<RoleOut>(load, []);

  // 权限全量列表（role:write 时用于勾选修改；role:read 即可查看）
  const [allPermissions, setAllPermissions] = useState<PermissionOut[] | null>(
    null,
  );

  const [permDialog, setPermDialog] = useState<RoleOut | null>(null);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [permBusy, setPermBusy] = useState(false);
  const [permError, setPermError] = useState<string | null>(null);

  const [roleDialog, setRoleDialog] = useState<
    { mode: "create" } | { mode: "edit"; role: RoleOut } | null
  >(null);
  const [roleName, setRoleName] = useState("");
  const [roleDescription, setRoleDescription] = useState("");
  const [roleBusy, setRoleBusy] = useState(false);
  const [roleError, setRoleError] = useState<string | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<RoleOut | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);

  async function loadAllPermissions() {
    if (allPermissions !== null) return allPermissions;
    const page = await api.permissions.list({ page: 1, page_size: 100 });
    setAllPermissions(page.items);
    return page.items;
  }

  async function openPermissions(role: RoleOut) {
    setPermError(null);
    setPermDialog(role);
    setSelectedIds(role.permissions.map((p) => p.id));
    try {
      await loadAllPermissions();
    } catch (err) {
      setPermError(
        err instanceof ApiError ? err.message : "加载权限列表失败",
      );
    }
  }

  async function savePermissions() {
    if (!permDialog) return;
    setPermBusy(true);
    setPermError(null);
    try {
      const updated = await api.roles.setPermissions(permDialog.id, selectedIds);
      setPermDialog(null);
      setActionMessage({
        kind: "success",
        text: `角色「${updated.name}」权限已更新（${updated.permissions.length} 项）`,
      });
      reload();
    } catch (err) {
      setPermError(
        err instanceof ApiError ? err.message : "保存失败，请稍后重试",
      );
    } finally {
      setPermBusy(false);
    }
  }

  function openCreate() {
    setRoleName("");
    setRoleDescription("");
    setRoleError(null);
    setRoleDialog({ mode: "create" });
  }

  function openEdit(role: RoleOut) {
    setRoleName(role.name);
    setRoleDescription(role.description ?? "");
    setRoleError(null);
    setRoleDialog({ mode: "edit", role });
  }

  async function submitRole() {
    if (!roleDialog) return;
    setRoleBusy(true);
    setRoleError(null);
    try {
      if (roleDialog.mode === "create") {
        const created = await api.roles.create({
          name: roleName.trim(),
          description: roleDescription.trim() || null,
        });
        setActionMessage({ kind: "success", text: `角色「${created.name}」已创建` });
      } else {
        const updated = await api.roles.update(roleDialog.role.id, {
          name: roleName.trim(),
          description: roleDescription.trim() || null,
        });
        setActionMessage({ kind: "success", text: `角色「${updated.name}」已更新` });
      }
      setRoleDialog(null);
      reload();
    } catch (err) {
      setRoleError(
        err instanceof ApiError ? err.message : "保存失败，请稍后重试",
      );
    } finally {
      setRoleBusy(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    setActionMessage(null);
    try {
      await api.roles.remove(deleteTarget.id);
      setActionMessage({
        kind: "success",
        text: `角色「${deleteTarget.name}」已删除（关联的用户角色与权限映射已清理）`,
      });
      setDeleteTarget(null);
      reload();
    } catch (err) {
      setActionMessage({
        kind: "error",
        text: err instanceof ApiError ? err.message : "删除失败，请稍后重试",
      });
    } finally {
      setDeleteBusy(false);
    }
  }

  if (error) return listErrorView(error, reload);
  if (items === null) return <Loading text="正在加载角色列表…" />;

  return (
    <div>
      <SettingsHeader
        title="角色与权限"
        description="系统角色及其权限映射：查看权限列表，拥有 role:write 权限可修改权限"
        action={
          canWrite ? (
            <button
              type="button"
              onClick={openCreate}
              className="inline-flex items-center gap-1.5 rounded-md bg-gray-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-gray-700"
            >
              <IconPlus className="size-4" />
              新建角色
            </button>
          ) : null
        }
      />

      <div className="space-y-4">
        {actionMessage ? <ActionMessage message={actionMessage} /> : null}

        {items.length === 0 ? (
          <Empty text="暂无角色" />
        ) : (
          <>
            <p className="text-sm text-gray-500">
              共 {total ?? items.length} 个角色
            </p>
            <TableShell>
              <thead className="bg-gray-50">
                <tr className="text-left text-xs text-gray-500">
                  <th className="px-4 py-3 font-medium">角色名</th>
                  <th className="px-4 py-3 font-medium">描述</th>
                  <th className="px-4 py-3 font-medium">权限</th>
                  <th className="px-4 py-3 font-medium">创建时间</th>
                  <th className="px-4 py-3 font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 text-gray-900">
                {items.map((r) => (
                  <tr key={r.id}>
                    <td className="px-4 py-3 font-medium">{r.name}</td>
                    <td className="max-w-xs px-4 py-3 text-gray-600">
                      {r.description ?? "—"}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {r.permissions.slice(0, 4).map((p) => (
                          <code
                            key={p.id}
                            className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600"
                          >
                            {p.code}
                          </code>
                        ))}
                        {r.permissions.length > 4 ? (
                          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">
                            +{r.permissions.length - 4}
                          </span>
                        ) : null}
                        {r.permissions.length === 0 ? (
                          <span className="text-xs text-gray-400">无权限</span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {formatDateTime(r.created_at)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1.5">
                        <button
                          type="button"
                          onClick={() => void openPermissions(r)}
                          className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                        >
                          <IconEye className="size-3.5" />
                          {canWrite ? "查看 / 修改权限" : "查看权限"}
                        </button>
                        {canWrite ? (
                          <button
                            type="button"
                            onClick={() => openEdit(r)}
                            className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                          >
                            <IconPencil className="size-3.5" />
                            编辑
                          </button>
                        ) : null}
                        {canDelete ? (
                          <button
                            type="button"
                            onClick={() => setDeleteTarget(r)}
                            className="inline-flex items-center gap-1 rounded-md border border-red-200 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
                          >
                            <IconTrash className="size-3.5" />
                            删除
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          </>
        )}
      </div>

      {/* 权限查看 / 修改 */}
      <Modal
        open={permDialog !== null}
        title={`角色权限 · ${permDialog?.name ?? ""}`}
        onClose={() => {
          if (!permBusy) setPermDialog(null);
        }}
      >
        <div className="space-y-4">
          {permError ? (
            <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-inset ring-red-200" role="alert">
              {permError}
            </p>
          ) : null}
          {allPermissions === null ? (
            <p className="py-4 text-center text-sm text-gray-500">
              正在加载权限列表…
            </p>
          ) : (
            <>
              <p className="text-xs text-gray-500">
                共 {allPermissions.length} 项权限
                {canWrite
                  ? "（勾选后保存，整体替换该角色的权限映射）"
                  : "（只读，需 role:write 权限才能修改）"}
              </p>
              <ul className="max-h-80 space-y-1 overflow-y-auto rounded-md border border-gray-200 p-3">
                {allPermissions.map((p) => {
                  const checked = selectedIds.includes(p.id);
                  return (
                    <li key={p.id}>
                      <label
                        className={`flex items-start gap-2 rounded px-1.5 py-1 text-sm ${
                          canWrite ? "hover:bg-gray-50" : ""
                        }`}
                      >
                        <input
                          type="checkbox"
                          disabled={!canWrite}
                          checked={checked}
                          onChange={(e) =>
                            setSelectedIds((ids) =>
                              e.target.checked
                                ? [...ids, p.id]
                                : ids.filter((id) => id !== p.id),
                            )
                          }
                          className="mt-0.5 size-4 rounded border-gray-300"
                        />
                        <span className="min-w-0">
                          <code className="text-xs font-medium text-gray-900">
                            {p.code}
                          </code>
                          <span className="ml-2 text-xs text-gray-500">
                            {p.name}
                          </span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          {canWrite ? (
            <div className="flex justify-end gap-2.5">
              <button
                type="button"
                onClick={() => setPermDialog(null)}
                disabled={permBusy}
                className="rounded-md border border-gray-300 px-3.5 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void savePermissions()}
                disabled={permBusy || allPermissions === null}
                className="rounded-md bg-gray-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
              >
                {permBusy ? "保存中…" : "保存权限"}
              </button>
            </div>
          ) : null}
        </div>
      </Modal>

      {/* 创建 / 编辑角色 */}
      <Modal
        open={roleDialog !== null}
        title={roleDialog?.mode === "create" ? "新建角色" : "编辑角色"}
        onClose={() => {
          if (!roleBusy) setRoleDialog(null);
        }}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submitRole();
          }}
          className="space-y-4"
        >
          <Field label="角色名" htmlFor="role-name" required>
            <input
              id="role-name"
              type="text"
              required
              autoComplete="off"
              value={roleName}
              onChange={(e) => setRoleName(e.target.value)}
              className={inputClass}
              placeholder="如：FRONT_DESK"
            />
          </Field>
          <Field label="描述" htmlFor="role-description">
            <textarea
              id="role-description"
              rows={3}
              value={roleDescription}
              onChange={(e) => setRoleDescription(e.target.value)}
              className={inputClass}
              placeholder="角色职责说明（选填）"
            />
          </Field>
          {roleError ? (
            <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-inset ring-red-200" role="alert">
              {roleError}
            </p>
          ) : null}
          <div className="flex justify-end gap-2.5 pt-1">
            <button
              type="button"
              onClick={() => setRoleDialog(null)}
              disabled={roleBusy}
              className="rounded-md border border-gray-300 px-3.5 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={roleBusy}
              className="rounded-md bg-gray-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
            >
              {roleBusy ? "保存中…" : "保存"}
            </button>
          </div>
        </form>
      </Modal>

      {/* 删除确认 */}
      <ConfirmDialog
        open={deleteTarget !== null}
        title="确认删除角色"
        message={`确定要删除角色「${deleteTarget?.name ?? ""}」吗？关联的用户-角色与角色-权限映射将被级联清理。`}
        confirmLabel="删除"
        busy={deleteBusy}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
