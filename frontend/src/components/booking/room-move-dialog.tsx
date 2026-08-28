"use client";

/**
 * Room Move Dialog（Sprint 6 §26，可复用组件：Stay 详情页 + Front Desk Drawer）：
 * - 展示 Guest / Stay identification、当前房间、计划退房日期
 * - 目标房由 GET /stays/{id}/room-move-options 后端权威结果驱动
 *   （用户不得凭 UI 自己猜可用房；不可用房灰显 + 后端原因）
 * - 换房原因（§10 固定 7 枚举）+ 可选备注
 * - 确认前显示：当前房间 → 目标房间、剩余住宿日期、原房换房后状态；
 *   显式「确认换房」按钮（无确认不执行高影响操作）
 * - Desktop 与 mobile 均可用（Modal 自适应宽度）
 *
 * 实现：表单状态由内层 RoomMoveForm 在每次打开时经 key 重新挂载
 * （渲染期初始化 + effect 仅异步 setState，符合 Next 16
 * react-hooks/set-state-in-effect 约束）。
 */

import { useEffect, useMemo, useState } from "react";
import { ApiError, api } from "@/lib/api";
import type {
  RoomMoveOptionItem,
  RoomMoveOptionsOut,
  RoomMoveReason,
  StayOut,
} from "@/lib/api/types";
import {
  ROOM_MOVE_REASON_LABELS,
  ROOM_MOVE_REASONS,
} from "@/lib/room-move";
import { businessDate } from "@/lib/booking";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Modal } from "@/components/modal";
import { Loading } from "@/components/status-views";
import {
  AlertBanner,
  primaryButtonClass,
} from "@/components/booking/shared";

export interface RoomMoveDialogProps {
  stay: StayOut;
  open: boolean;
  onClose: () => void;
  /** 换房成功后回调（父级 targeted refetch / 关闭抽屉）。 */
  onMoved: () => void;
}

export default function RoomMoveDialog({
  stay,
  open,
  onClose,
  onMoved,
}: RoomMoveDialogProps) {
  return (
    <Modal open={open} title="换房" onClose={onClose}>
      {open ? (
        <RoomMoveForm
          key={stay.id}
          stay={stay}
          onClose={onClose}
          onMoved={onMoved}
        />
      ) : null}
    </Modal>
  );
}

function RoomMoveForm({
  stay,
  onClose,
  onMoved,
}: {
  stay: StayOut;
  onClose: () => void;
  onMoved: () => void;
}) {
  const [options, setOptions] = useState<RoomMoveOptionsOut | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [targetRoomId, setTargetRoomId] = useState<number | null>(null);
  const [reason, setReason] = useState<RoomMoveReason>("GUEST_REQUEST");
  const [notes, setNotes] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<
    { kind: "success" | "conflict"; text: string } | null
  >(null);

  // 挂载即加载后端权威目标房候选（仅异步回调中 setState）
  useEffect(() => {
    let cancelled = false;
    api.stays
      .roomMoveOptions(stay.id)
      .then((data) => {
        if (!cancelled) setOptions(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoadError(
            err instanceof ApiError
              ? err
              : new ApiError("unknown", null, "加载换房目标失败"),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [stay.id]);

  const eligibleOptions = useMemo(
    () => (options?.items ?? []).filter((o) => o.eligible),
    [options],
  );
  const selected = useMemo(
    () => (options?.items ?? []).find((o) => o.room_id === targetRoomId) ?? null,
    [options, targetRoomId],
  );
  const currentRoomNumber = stay.room_number ?? `#${stay.room_id}`;
  const remainingNights = useMemo(() => {
    const today = businessDate();
    const end = stay.planned_check_out_date;
    const [ty, tm, td] = today.split("-").map(Number);
    const [ey, em, ed] = end.split("-").map(Number);
    return Math.max(
      0,
      Math.round(
        (Date.UTC(ey, em - 1, ed) - Date.UTC(ty, tm - 1, td)) / 86_400_000,
      ),
    );
  }, [stay.planned_check_out_date]);

  async function runMove() {
    if (busy || targetRoomId == null) return;
    setBusy(true);
    setBanner(null);
    try {
      await api.stays.roomMove(stay.id, {
        target_room_id: targetRoomId,
        reason,
        notes: notes.trim() === "" ? null : notes.trim(),
      });
      setBanner({ kind: "success", text: "换房完成" });
      onMoved();
      onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        setBanner({ kind: "conflict", text: err.message });
      } else {
        setBanner({ kind: "conflict", text: "换房失败，请稍后重试" });
      }
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Guest / Stay identification（无 PII 泄漏：guest_name 由后端裁剪） */}
      <div className="rounded-md border border-gray-200 px-3 py-2.5 text-sm">
        <p className="font-medium text-gray-900">{stay.stay_no}</p>
        <p className="mt-0.5 text-xs text-gray-500">
          当前房间 {currentRoomNumber} · 计划退房 {stay.planned_check_out_date}
          {stay.guest_name ? ` · ${stay.guest_name}` : ""}
        </p>
      </div>

      {banner ? (
        <AlertBanner kind={banner.kind}>{banner.text}</AlertBanner>
      ) : null}

      {loadError ? (
        <p role="alert" className="text-sm text-red-600">
          {loadError.message}
        </p>
      ) : options === null ? (
        <Loading text="正在加载可选房间…" />
      ) : (
        <>
          {/* 目标房：后端权威候选（不可用房灰显 + 原因，用户不得自行猜测） */}
          <div>
            <label
              htmlFor="room-move-target"
              className="mb-1.5 block text-xs font-medium text-gray-600"
            >
              目标房间
            </label>
            <select
              id="room-move-target"
              value={targetRoomId ?? ""}
              onChange={(e) =>
                setTargetRoomId(e.target.value ? Number(e.target.value) : null)
              }
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none"
            >
              <option value="">请选择目标房间</option>
              {options.items.map((item: RoomMoveOptionItem) => (
                <option
                  key={item.room_id}
                  value={item.room_id}
                  disabled={!item.eligible}
                >
                  {item.room_number}
                  {item.eligible
                    ? ` · ${item.room_type_name ?? ""}`
                    : `（不可换入：${item.reason ?? "不可用"}）`}
                </option>
              ))}
            </select>
            {eligibleOptions.length === 0 ? (
              <p className="mt-1.5 text-xs text-amber-700">
                当前没有可换入的房间
              </p>
            ) : null}
          </div>

          <div>
            <label
              htmlFor="room-move-reason"
              className="mb-1.5 block text-xs font-medium text-gray-600"
            >
              换房原因
            </label>
            <select
              id="room-move-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value as RoomMoveReason)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none"
            >
              {ROOM_MOVE_REASONS.map((r) => (
                <option key={r} value={r}>
                  {ROOM_MOVE_REASON_LABELS[r]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="room-move-notes"
              className="mb-1.5 block text-xs font-medium text-gray-600"
            >
              备注（可选）
            </label>
            <textarea
              id="room-move-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={500}
              rows={2}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none"
            />
          </div>

          {/* 确认前摘要：当前房间 → 目标房间、剩余住宿日期、原房换房后状态 */}
          {selected ? (
            <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm">
              <p className="font-medium text-gray-900">
                确认换房：{currentRoomNumber} → {selected.room_number}
              </p>
              <p className="mt-1 text-xs text-gray-600">
                剩余住宿 {remainingNights} 晚（至{" "}
                {stay.planned_check_out_date}）
              </p>
              <p className="mt-1 text-xs text-gray-600">
                原房 {currentRoomNumber} 换房后将变为「可售 + 待清扫」
                （如有阻断性维修则停用），并自动创建保洁任务
              </p>
            </div>
          ) : null}

          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => setConfirming(true)}
              disabled={busy || targetRoomId == null}
              className={primaryButtonClass}
            >
              确认换房
            </button>
          </div>
        </>
      )}

      <ConfirmDialog
        open={confirming}
        title="确认换房"
        message={
          selected
            ? `确定将 ${stay.stay_no} 从 ${currentRoomNumber} 换到 ${selected.room_number} 吗？`
            : ""
        }
        confirmLabel="确认换房"
        busy={busy}
        onConfirm={() => void runMove()}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}
