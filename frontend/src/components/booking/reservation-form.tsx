"use client";

/**
 * ReservationForm：新建 / 编辑预订共用表单。
 * - 日期区间 [check_in_date, check_out_date)，check_out > check_in（422 级校验）
 * - WALK_IN：check_in_date 固定为 Property Business Date 今天（Asia/Shanghai）
 * - 新建：先查真实 Availability 并选择可用房间（无可用不允许提交）
 * - 编辑（CONFIRMED）：修改日期/房间/房型重新执行 Availability；提交仅含变更字段
 * - 后端 409 / 422 原样展示（409 冲突条 + 后端 detail；422 表单错误），不吞掉
 * - 防重复提交：提交期间禁用按钮；后端并发安全仍是最终保证
 * - 状态机不在前端复制：状态只能经专用 action 端点变更，本表单不含 status
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, api } from "@/lib/api";
import type {
  GuestOut,
  ReservationCreate,
  ReservationOut,
  ReservationSource,
  ReservationUpdate,
  RoomTypeOut,
} from "@/lib/api/types";
import {
  RESERVATION_SOURCES,
  SOURCE_LABELS,
  businessDate,
  validateDateRange,
} from "@/lib/booking";
import AvailabilityPicker from "@/components/booking/availability-picker";
import GuestPicker from "@/components/booking/guest-picker";
import {
  AlertBanner,
  Field,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
} from "@/components/booking/shared";

export interface ReservationFormProps {
  mode: "create" | "edit";
  /** 编辑模式初始预订（CONFIRMED） */
  initial?: ReservationOut | null;
  /**
   * Sprint 4 快速新建预填（仅 create 模式）：来自 /front-desk 空白日期格。
   * Backend Availability 仍会重新验证；预填只改善输入效率，不构成业务授权。
   */
  prefill?: {
    roomId?: number;
    roomTypeId?: number;
    checkIn?: string;
    checkOut?: string;
  };
  permissions: Set<string>;
  submitLabel: string;
  onSubmit: (
    payload: ReservationCreate | ReservationUpdate,
  ) => Promise<unknown>;
  onSuccess?: (result: unknown) => void;
  /** 取消（编辑模式返回详情只读态） */
  onCancel?: () => void;
}

interface Banner {
  kind: "error" | "conflict" | "success";
  text: string;
}

export default function ReservationForm({
  mode,
  initial,
  prefill,
  permissions,
  submitLabel,
  onSubmit,
  onSuccess,
  onCancel,
}: ReservationFormProps) {
  const router = useRouter();
  const canReadGuest = permissions.has("guest:read");
  const canWriteGuest = permissions.has("guest:write");

  const [guest, setGuest] = useState<GuestOut | null>(null);
  const [checkIn, setCheckIn] = useState(
    initial?.check_in_date ?? prefill?.checkIn ?? "",
  );
  const [checkOut, setCheckOut] = useState(
    initial?.check_out_date ?? prefill?.checkOut ?? "",
  );
  const [roomTypeId, setRoomTypeId] = useState<number | null>(
    initial?.room_type_id ?? prefill?.roomTypeId ?? null,
  );
  const [roomId, setRoomId] = useState<number | null>(
    initial?.room_id ?? prefill?.roomId ?? null,
  );
  const [source, setSource] = useState<ReservationSource>(
    initial?.source ?? "DIRECT",
  );
  const [externalReference, setExternalReference] = useState(
    initial?.external_reference ?? "",
  );
  const [amount, setAmount] = useState(initial?.agreed_total_amount ?? "");
  const [currency, setCurrency] = useState(initial?.currency ?? "CNY");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [roomTypes, setRoomTypes] = useState<RoomTypeOut[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [guestError, setGuestError] = useState<string | null>(null);
  const [roomError, setRoomError] = useState<string | null>(null);

  // 编辑模式：拉取已关联 Guest 详情用于展示（需 guest:read；403 时仅显示 ID）
  useEffect(() => {
    if (mode !== "edit" || !initial || !canReadGuest) return;
    let cancelled = false;
    api.guests
      .get(initial.guest_id)
      .then((data) => {
        if (!cancelled) setGuest(data);
      })
      .catch(() => {
        // 无权限或不存在：保留 ID 关联展示
      });
    return () => {
      cancelled = true;
    };
  }, [mode, initial, canReadGuest]);

  // 房型选项（availability 筛选 + 展示）
  useEffect(() => {
    let cancelled = false;
    api.roomTypes
      .list({ page: 1, page_size: 100 })
      .then((page) => {
        if (!cancelled) setRoomTypes(page.items);
      })
      .catch(() => {
        // 房型列表失败不阻塞表单主体
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const dateRangeError = useMemo(
    () => validateDateRange(checkIn, checkOut),
    [checkIn, checkOut],
  );
  const datesValid =
    checkIn !== "" && checkOut !== "" && dateRangeError === null;

  function handleSourceChange(next: ReservationSource) {
    setSource(next);
    if (next === "WALK_IN") {
      // Walk-in 统一流程：check_in_date = Property Business Date 今天
      setCheckIn(businessDate());
    }
  }

  function handleRoomTypeChange(next: number | null) {
    setRoomTypeId(next);
    // 房型筛选变化后原房间可能不在筛选内：清空选择，强制重新挑选
    setRoomId(null);
  }

  function handleRoomChange(item: {
    room_id: number;
    room_type_id: number;
  }) {
    setRoomId(item.room_id);
    setRoomTypeId(item.room_type_id); // Room / Room Type 联动：房间自动带出房型
  }

  function validate(): string | null {
    const guestId = guest?.id ?? initial?.guest_id ?? null;
    if (guestId === null) {
      return "请选择客人";
    }
    if (checkIn === "" || checkOut === "") {
      return "请选择入住与退房日期";
    }
    if (dateRangeError) return dateRangeError;
    if (roomId === null) {
      return "请选择可用房间";
    }
    if (amount.trim() === "") {
      return "请填写约定金额";
    }
    const parsed = Number(amount);
    if (Number.isNaN(parsed) || parsed < 0) {
      return "金额必须为不小于 0 的数字";
    }
    return null;
  }

  function buildPayload(): ReservationCreate | ReservationUpdate | null {
    if (mode === "create") {
      return {
        guest_id: guest!.id,
        room_id: roomId!,
        room_type_id: roomTypeId!,
        check_in_date: checkIn,
        check_out_date: checkOut,
        source,
        external_reference: externalReference.trim() || null,
        agreed_total_amount: amount,
        currency: currency.trim() || "CNY",
        notes: notes.trim() || null,
      };
    }
    // 编辑：仅提交发生变化的字段（空 payload 后端会 422，禁止）
    const payload: ReservationUpdate = {};
    if (guest && guest.id !== initial?.guest_id) payload.guest_id = guest.id;
    if (roomId !== null && roomId !== initial?.room_id) payload.room_id = roomId;
    if (
      roomTypeId !== null &&
      roomTypeId !== initial?.room_type_id
    ) {
      payload.room_type_id = roomTypeId;
    }
    if (checkIn !== initial?.check_in_date) payload.check_in_date = checkIn;
    if (checkOut !== initial?.check_out_date) payload.check_out_date = checkOut;
    if (source !== initial?.source) payload.source = source;
    const refValue = externalReference.trim() || null;
    if (refValue !== (initial?.external_reference ?? null)) {
      payload.external_reference = refValue;
    }
    const amountValue = amount.trim();
    if (amountValue !== "" && amountValue !== (initial?.agreed_total_amount ?? null)) {
      payload.agreed_total_amount = amountValue;
    }
    const currencyValue = currency.trim() || "CNY";
    if (currencyValue !== (initial?.currency ?? "CNY")) {
      payload.currency = currencyValue;
    }
    const notesValue = notes.trim() || null;
    if (notesValue !== (initial?.notes ?? null)) payload.notes = notesValue;
    return Object.keys(payload).length === 0 ? null : payload;
  }

  async function handleSubmit() {
    if (submitting) return;
    setBanner(null);
    setGuestError(null);
    setRoomError(null);
    const problem = validate();
    if (problem) {
      setBanner({ kind: "error", text: problem });
      return;
    }
    const payload = buildPayload();
    if (payload === null) {
      setBanner({ kind: "error", text: "没有需要保存的变更" });
      return;
    }
    setSubmitting(true);
    try {
      const result = await onSubmit(payload);
      setBanner({ kind: "success", text: "已保存" });
      onSuccess?.(result);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.kind === "unauthorized") {
          router.replace("/login");
          return;
        }
        if (err.kind === "conflict") {
          // 409：展示后端业务冲突原文（Double Booking / 房间不可用等）
          setBanner({ kind: "conflict", text: err.message });
          return;
        }
        // 422 等：字段/表单错误（含 Room/Room Type 不一致文案）
        setBanner({ kind: "error", text: err.message });
        return;
      }
      setBanner({ kind: "error", text: "提交失败，请稍后重试" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-5">
      {banner ? (
        banner.kind === "success" ? (
          <AlertBanner kind="success">{banner.text}</AlertBanner>
        ) : banner.kind === "conflict" ? (
          <AlertBanner kind="conflict">冲突：{banner.text}</AlertBanner>
        ) : (
          <AlertBanner kind="error">{banner.text}</AlertBanner>
        )
      ) : null}

      <GuestPicker
        value={guest?.id ?? initial?.guest_id ?? null}
        selected={guest}
        onChange={setGuest}
        canSearch={canReadGuest}
        canCreate={canWriteGuest}
        error={guestError}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="入住日期"
          required
          error={null}
          hint={
            source === "WALK_IN"
              ? "散客入住日期固定为业务日期今天（Asia/Shanghai）"
              : undefined
          }
        >
          <input
            type="date"
            value={checkIn}
            min={businessDate()}
            disabled={source === "WALK_IN" || submitting}
            onChange={(e) => setCheckIn(e.target.value)}
            className={inputClass}
            aria-label="入住日期"
          />
        </Field>
        <Field label="退房日期" required error={dateRangeError ?? null}>
          <input
            type="date"
            value={checkOut}
            disabled={submitting}
            onChange={(e) => setCheckOut(e.target.value)}
            className={inputClass}
            aria-label="退房日期"
          />
        </Field>
      </div>

      <AvailabilityPicker
        checkIn={checkIn}
        checkOut={checkOut}
        roomTypeId={roomTypeId}
        value={roomId}
        onChange={handleRoomChange}
        onRoomTypeChange={handleRoomTypeChange}
        roomTypes={roomTypes}
        datesValid={datesValid}
        disabled={submitting}
      />
      {roomError ? (
        <p role="alert" className="text-sm text-red-600">
          {roomError}
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="来源" error={null}>
          <select
            value={source}
            disabled={submitting}
            onChange={(e) => handleSourceChange(e.target.value as ReservationSource)}
            className={inputClass}
            aria-label="预订来源"
          >
            {RESERVATION_SOURCES.map((s) => (
              <option key={s} value={s}>
                {SOURCE_LABELS[s]}（{s}）
              </option>
            ))}
          </select>
        </Field>
        <Field label="外部订单号" error={null}>
          <input
            value={externalReference}
            disabled={submitting}
            onChange={(e) => setExternalReference(e.target.value)}
            placeholder="人工记录外部订单号（可选）"
            className={inputClass}
            aria-label="外部订单号"
          />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="约定金额" required error={null}>
          <input
            value={amount}
            disabled={submitting}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="如 428.00"
            className={inputClass}
            aria-label="约定金额"
          />
        </Field>
        <Field label="币种" error={null}>
          <input
            value={currency}
            disabled={submitting}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            maxLength={3}
            className={inputClass}
            aria-label="币种"
          />
        </Field>
      </div>

      <Field label="备注" error={null}>
        <textarea
          value={notes}
          disabled={submitting}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder="预订备注（可选）"
          className={inputClass}
          aria-label="预订备注"
        />
      </Field>

      <div className="flex justify-end gap-2.5">
        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className={secondaryButtonClass}
          >
            取消编辑
          </button>
        ) : null}
        <button
          type="button"
          onClick={handleSubmit}
          disabled={submitting}
          className={primaryButtonClass}
        >
          {submitting ? "提交中…" : submitLabel}
        </button>
      </div>
    </div>
  );
}
