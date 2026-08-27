"use client";

/**
 * /reservations/new 新建预订：
 * - 必须先查询真实 GET /availability 并选择可用房间（无可用 → 不允许提交）
 * - Guest 搜索 / 创建、日期、来源、金额、币种、备注
 * - 成功跳转 /reservations/[id]；409/422 展示后端原文
 * - 权限：reservation:write（页面 403 → Forbidden）
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ApiError, api } from "@/lib/api";
import type { ReservationCreate, ReservationUpdate } from "@/lib/api/types";
import { Forbidden } from "@/components/status-views";
import { useUser } from "@/components/app-shell";
import ReservationForm from "@/components/booking/reservation-form";
import { SectionCard } from "@/components/booking/shared";

export default function NewReservationView() {
  const router = useRouter();
  const user = useUser();
  const permissions = useMemo(() => new Set(user?.permissions ?? []), [user]);
  const [forbidden, setForbidden] = useState(false);

  const canReadReservation = permissions.has("reservation:read");
  const canWriteReservation = permissions.has("reservation:write");

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
          permissions={permissions}
          submitLabel="创建预订"
          onSubmit={handleSubmit}
        />
      </SectionCard>
    </div>
  );
}
