"use client";

/**
 * 房间资料管理（alpha.9.6 F1，真实酒店现场试用反馈）。
 *
 * 目标：经营者无需改数据库 / seed / 代码，就能把 28 间改成 30 间，
 * 也能把「101 大床房」改成「101 豪华大床房」。
 *
 * 设计要点：
 * - 房间数量（总数 / 启用 / 停用）全部来自后端 GET /rooms/summary（COUNT 计算），
 *   **不是可编辑字段**，也不存在 rooms.room_count 真值列。
 * - 停用/启用优先于删除：停用不释放房号、不破坏历史 Reservation / Stay / 工单。
 * - 删除仅在房间从未被任何业务记录引用时可用（后端最终仲裁，409 直接展示）。
 * - 房态（占用 / 清洁）不在本表单修改：必须走房态状态机接口。
 * - 使用 <table> 而非 ul>li：房态棋盘的卡片列表依赖 `ul.grid > li` 结构。
 * - **权限（alpha.9.6 QA DEF-1）**：本视图的写操作统一由
 *   `room:inventory_manage` 门控（`canManageInventory`），与后端端点一致；
 *   `room:write` 只承担房态操作，**不**显现资料管理按钮。
 *   因此 FRONT_DESK 打开本视图时仅能看到只读数量统计，不显示任何写操作按钮。
 */

import { useMemo, useState } from "react";
import { ApiError, api } from "@/lib/api";
import type { RoomOut, RoomTypeOut } from "@/lib/api/types";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Modal } from "@/components/modal";
import { Empty } from "@/components/status-views";
import { IconPencil, IconPlus, IconTrash } from "@/components/icons";
import { CleaningBadge, OccupancyBadge } from "@/components/status-badge";
import {
  ActionMessage,
  Field,
  TableShell,
  inputClass,
} from "@/components/settings/shared";

export interface RoomSummaryState {
  total_count: number;
  enabled_count: number;
  disabled_count: number;
}

interface RoomFormState {
  roomNumber: string;
  name: string;
  roomTypeId: string;
  floor: string;
  notes: string;
}

interface Props {
  rooms: RoomOut[];
  summary: RoomSummaryState | null;
  roomTypes: RoomTypeOut[];
  /**
   * alpha.9.6 QA DEF-1：房间主数据管理权限（新增/编辑/停用/启用）。
   * 由 room:inventory_manage 判定 —— **不是** room:write（后者仅承担房态操作）。
   */
  canManageInventory: boolean;
  /** 物理删除（后端要求 room:inventory_manage 且 room:delete，且房间无任何历史引用） */
  canDelete: boolean;
  onChanged: () => void;
}

function emptyForm(roomTypes: RoomTypeOut[]): RoomFormState {
  return {
    roomNumber: "",
    name: "",
    roomTypeId: roomTypes.length > 0 ? String(roomTypes[0].id) : "",
    floor: "1",
    notes: "",
  };
}

function toForm(room: RoomOut): RoomFormState {
  return {
    roomNumber: room.room_number,
    name: room.name ?? "",
    roomTypeId: String(room.room_type_id),
    floor: String(room.floor),
    notes: room.notes ?? "",
  };
}

export default function RoomsManagementView({
  rooms,
  summary,
  roomTypes,
  canManageInventory,
  canDelete,
  onChanged,
}: Props) {
  const [dialog, setDialog] = useState<
    { mode: "create" } | { mode: "edit"; room: RoomOut } | null
  >(null);
  const [form, setForm] = useState<RoomFormState>(emptyForm(roomTypes));
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);
  const [toggleTarget, setToggleTarget] = useState<RoomOut | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RoomOut | null>(null);

  const sorted = useMemo(
    () =>
      [...rooms].sort((a, b) =>
        a.room_number.localeCompare(b.room_number, "zh-CN", { numeric: true }),
      ),
    [rooms],
  );

  function openCreate() {
    setForm(emptyForm(roomTypes));
    setDialogError(null);
    setDialog({ mode: "create" });
  }

  function openEdit(room: RoomOut) {
    setForm(toForm(room));
    setDialogError(null);
    setDialog({ mode: "edit", room });
  }

  async function submitForm() {
    if (!dialog) return;
    setBusy(true);
    setDialogError(null);
    const payload = {
      room_number: form.roomNumber.trim(),
      name: form.name.trim() === "" ? null : form.name.trim(),
      room_type_id: Number(form.roomTypeId),
      floor: Number(form.floor),
      notes: form.notes.trim() === "" ? null : form.notes.trim(),
    };
    try {
      if (dialog.mode === "create") {
        const created = await api.rooms.create(payload);
        setActionMessage({
          kind: "success",
          text: `房间 ${created.room_number}${
            created.name ? `（${created.name}）` : ""
          } 已创建`,
        });
      } else {
        const updated = await api.rooms.patch(dialog.room.id, payload);
        setActionMessage({
          kind: "success",
          text: `房间 ${updated.room_number} 已更新`,
        });
      }
      setDialog(null);
      onChanged();
    } catch (err) {
      // 409（房号重复 / 历史记录保护）等直接展示后端可读文案
      setDialogError(
        err instanceof ApiError ? err.message : "保存失败，请稍后重试",
      );
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive() {
    if (!toggleTarget) return;
    const target = toggleTarget;
    setBusy(true);
    setActionMessage(null);
    try {
      const updated = target.is_active
        ? await api.rooms.disable(target.id)
        : await api.rooms.enable(target.id);
      setActionMessage({
        kind: "success",
        text: `房间 ${updated.room_number} 已${updated.is_active ? "启用" : "停用"}`,
      });
      setToggleTarget(null);
      onChanged();
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
      await api.rooms.remove(deleteTarget.id);
      setActionMessage({
        kind: "success",
        text: `房间 ${deleteTarget.room_number} 已删除`,
      });
      setDeleteTarget(null);
      onChanged();
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
    <div className="space-y-4">
      {actionMessage ? <ActionMessage message={actionMessage} /> : null}

      {/* 房间数量：全部由后端 COUNT 计算，不可手填 */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "总房间数", value: summary?.total_count ?? null },
          { label: "启用房间数", value: summary?.enabled_count ?? null },
          { label: "停用房间数", value: summary?.disabled_count ?? null },
        ].map((card) => (
          <div
            key={card.label}
            className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm"
          >
            <p className="text-xs text-gray-500">{card.label}</p>
            <p className="mt-1.5 text-2xl font-semibold tabular-nums text-gray-900">
              {card.value ?? "…"}
            </p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-gray-500">
          停用房间不参与可售与新预订，但历史预订 / 入住 / 工单记录保持完整；
          停用不释放房号。
        </p>
        {canManageInventory ? (
          <button
            type="button"
            onClick={openCreate}
            className="inline-flex items-center gap-1.5 rounded-md bg-gray-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-gray-700"
          >
            <IconPlus className="size-4" />
            新增房间
          </button>
        ) : null}
      </div>

      {sorted.length === 0 ? (
        <Empty text="暂无房间数据" />
      ) : (
        <TableShell>
          <thead className="bg-gray-50">
            <tr className="text-left text-xs text-gray-500">
              <th className="px-4 py-3 font-medium">房号</th>
              <th className="px-4 py-3 font-medium">房间名称</th>
              <th className="px-4 py-3 font-medium">房型</th>
              <th className="px-4 py-3 font-medium">楼层</th>
              <th className="px-4 py-3 font-medium">经营状态</th>
              <th className="px-4 py-3 font-medium">占用</th>
              <th className="px-4 py-3 font-medium">清洁</th>
              {canManageInventory || canDelete ? (
                <th className="px-4 py-3 font-medium">操作</th>
              ) : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 text-gray-900">
            {sorted.map((room) => (
              <tr key={room.id} className={room.is_active ? "" : "bg-gray-50"}>
                <td className="px-4 py-3 font-medium">{room.room_number}</td>
                <td className="px-4 py-3 text-gray-600">
                  {room.name ?? <span className="text-gray-300">—</span>}
                </td>
                <td className="px-4 py-3 text-gray-600">
                  {room.room_type?.name ?? `房型 #${room.room_type_id}`}
                </td>
                <td className="px-4 py-3 tabular-nums text-gray-600">
                  {room.floor} 楼
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`rounded px-1.5 py-0.5 text-xs ${
                      room.is_active
                        ? "bg-emerald-50 text-emerald-700"
                        : "bg-gray-200 text-gray-600"
                    }`}
                  >
                    {room.is_active ? "启用中" : "已停用"}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <OccupancyBadge status={room.occupancy_status} />
                </td>
                <td className="px-4 py-3">
                  <CleaningBadge status={room.cleaning_status} />
                </td>
                {canManageInventory || canDelete ? (
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1.5">
                      {canManageInventory ? (
                        <>
                          <button
                            type="button"
                            onClick={() => openEdit(room)}
                            className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                          >
                            <IconPencil className="size-3.5" />
                            编辑
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setActionMessage(null);
                              setToggleTarget(room);
                            }}
                            className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium ${
                              room.is_active
                                ? "border-amber-200 text-amber-700 hover:bg-amber-50"
                                : "border-emerald-200 text-emerald-700 hover:bg-emerald-50"
                            }`}
                          >
                            {room.is_active ? "停用" : "启用"}
                          </button>
                        </>
                      ) : null}
                      {canDelete ? (
                        <button
                          type="button"
                          onClick={() => {
                            setActionMessage(null);
                            setDeleteTarget(room);
                          }}
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
      )}

      {/* 新增 / 编辑房间 */}
      <Modal
        open={dialog !== null}
        title={dialog?.mode === "create" ? "新增房间" : "编辑房间"}
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
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="房号" htmlFor="room-number" required>
              <input
                id="room-number"
                type="text"
                required
                autoComplete="off"
                value={form.roomNumber}
                onChange={(e) =>
                  setForm((f) => ({ ...f, roomNumber: e.target.value }))
                }
                className={inputClass}
                placeholder="如：301"
              />
            </Field>
            <Field
              label="房间名称"
              htmlFor="room-name"
              hint="选填；不填时界面显示房号"
            >
              <input
                id="room-name"
                type="text"
                autoComplete="off"
                value={form.name}
                onChange={(e) =>
                  setForm((f) => ({ ...f, name: e.target.value }))
                }
                className={inputClass}
                placeholder="如：豪华大床房（海景）"
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="房型" htmlFor="room-type" required>
              <select
                id="room-type"
                required
                value={form.roomTypeId}
                onChange={(e) =>
                  setForm((f) => ({ ...f, roomTypeId: e.target.value }))
                }
                className={inputClass}
              >
                {roomTypes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="楼层" htmlFor="room-floor" required>
              <input
                id="room-floor"
                type="number"
                required
                min="1"
                value={form.floor}
                onChange={(e) =>
                  setForm((f) => ({ ...f, floor: e.target.value }))
                }
                className={inputClass}
              />
            </Field>
          </div>

          <Field label="备注" htmlFor="room-notes">
            <textarea
              id="room-notes"
              rows={2}
              value={form.notes}
              onChange={(e) =>
                setForm((f) => ({ ...f, notes: e.target.value }))
              }
              className={inputClass}
              placeholder="如：朝南、无障碍设施（选填）"
            />
          </Field>

          <p className="rounded-md bg-gray-50 px-3 py-2 text-xs text-gray-500">
            基础价格由「房型管理」维护（房间继承房型价格）。占用与清洁状态请到
            房间详情的房态操作中修改。
          </p>

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
        title={toggleTarget?.is_active ? "确认停用房间" : "确认启用房间"}
        message={
          toggleTarget?.is_active
            ? `确定要停用房间「${toggleTarget?.room_number ?? ""}」吗？停用后该房间不再参与可售与新预订，但历史预订、入住与工单记录保持不变，房号也不会被释放。`
            : `确定要恢复启用房间「${toggleTarget?.room_number ?? ""}」吗？启用后该房间重新参与可售。`
        }
        confirmLabel={toggleTarget?.is_active ? "停用" : "启用"}
        busy={busy}
        onConfirm={() => void toggleActive()}
        onCancel={() => setToggleTarget(null)}
      />

      {/* 删除确认 */}
      <ConfirmDialog
        open={deleteTarget !== null}
        title="确认删除房间"
        message={`确定要删除房间「${deleteTarget?.room_number ?? ""}」吗？仅当该房间从未被任何预订、入住、保洁或维修记录引用时才会成功；否则后端会拒绝并建议改用停用。`}
        confirmLabel="删除"
        busy={busy}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
