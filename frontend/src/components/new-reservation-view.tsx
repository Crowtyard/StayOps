"use client";

/**
 * /reservations/new 新建预订：
 * - 必须先查询真实 GET /availability 并选择可用房间（无可用 → 不允许提交）
 * - Guest 搜索 / 创建、日期、来源、金额、币种、备注
 * - 成功跳转 /reservations/[id]；409/422 展示后端原文
 * - 权限：reservation:write（页面 403 → Forbidden）
 * - Sprint 4 快速新建预填：/front-desk 空白日期格 →
 *   ?room_id=&room_type_id=&check_in_date=&check_out_date= 预填表单，
 *   复用现有表单，不新造第二套；Backend Availability 仍重新验证
 */

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ApiError, api } from "@/lib/api";
import type { ReservationCreate, ReservationUpdate } from "@/lib/api/types";
import { Forbidden, Loading } from "@/components/status-views";
import { useUser } from "@/components/app-shell";
import ReservationForm from "@/components/booking/reservation-form";
import { SectionCard } from "@/components/booking/shared";

function parseIdParam(value: string | null): number | null {
  if (!value) return null;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function NewReservationContent() {
  const router = useRouter();
  const user = useUser();
  const permissions = useMemo(() => new Set(user?.permissions ?? []), [user]);
  const [forbidden, setForbidden] = useState(false);

  const searchParams = useSearchParams();
  const roomIdParam = parseIdParam(searchParams.get("room_id"));
  const roomTypeIdParam = parseIdParam(searchParams.get("room_type_id"));
  const checkInParam = searchParams.get("check_in_date") ?? undefined;
  const checkOutParam = searchParams.get("check_out_date") ?? undefined;

  // 预填只给了 room_id 时补全 room_type_id（Room/RoomType 联动需要）
  const [derivedRoomTypeId, setDerivedRoomTypeId] = useState<number | null>(
    roomTypeIdParam,
  );
  useEffect(() => {
    if (roomIdParam === null || derivedRoomTypeId !== null) return;
    if (!permissions.has("room:read")) return;
    let cancelled = false;
    api.rooms
      .get(roomIdParam)
      .then((room) => {
        if (!cancelled) setDerivedRoomTypeId(room.room_type_id);
      })
      .catch(() => {
        // 房间不存在/无权限：预填房间失效，走普通新建流程
      });
    return () => {
      cancelled = true;
    };
  }, [roomIdParam, derivedRoomTypeId, permissions]);

  const canReadReservation = permissions.has("reservation:read");
  const canWriteReservation = permissions.has("reservation:write");
  const hasRoomRead = permissions.has("room:read");

  async function handleSubmit(payload: ReservationCreate | ReservationUpdate) {
    try {
      // mode="create" 表单只会产出 ReservationCreate 载荷
      const created = await api.reservations.create(payload as ReservationCreate);
      router.replace(`/reservations/${created.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.kind === "forbidden") {
        setForbidden(true);
        return;
      }
      throw err;
    }
  }

  if (forbidden || !canWriteReservation || !canReadReservation) {
    return <Forbidden text="无权限新建预订" />;
  }

  // 预填房间的房型未就绪时等待一次定向请求（毫秒级），避免表单校验误判
  const roomPrefillPending =
    roomIdParam !== null &&
    roomTypeIdParam === null &&
    derivedRoomTypeId === null &&
    hasRoomRead;
  if (roomPrefillPending) {
    return <Loading text="正在准备快速新建预填…" />;
  }

  const roomTypeId = roomTypeIdParam ?? derivedRoomTypeId;
  const prefill =
    roomIdParam !== null && roomTypeId !== null
      ? {
          roomId: roomIdParam,
          roomTypeId,
          checkIn: checkInParam,
          checkOut: checkOutParam,
        }
      : {
          // 房间预填不可用（无 room:read 或房间不存在）时仅预填日期
          checkIn: checkInParam,
          checkOut: checkOutParam,
        };

  return (
    <div className="mx-auto max-w-4xl">
      <Link
        href="/reservations"
        className="mb-4 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900"
      >
        ← 返回预订列表
      </Link>
      <div className="mb-5">
        <h1 className="text-xl font-semibold text-gray-900">新建预订</h1>
        <p className="mt-1 text-sm text-gray-500">
          选择日期后查询真实可售房间；重叠预订会被后端拒绝（409 冲突提示）
        </p>
      </div>

      <SectionCard title="预订信息">
        <ReservationForm
          mode="create"
          prefill={prefill}
          permissions={permissions}
          submitLabel="创建预订"
          onSubmit={handleSubmit}
        />
      </SectionCard>
    </div>
  );
}

export default function NewReservationView() {
  // useSearchParams 需要 Suspense 边界（Next 16 静态预渲染约束）
  return (
    <Suspense fallback={<Loading text="正在加载新建预订…" />}>
      <NewReservationContent />
    </Suspense>
  );
}
