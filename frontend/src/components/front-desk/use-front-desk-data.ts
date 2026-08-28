"use client";

/**
 * Sprint 4 Front Desk 数据加载 Hook：
 * 批量组合既有 List API（禁止每房间单独请求，避免 N+1）：
 * - GET /rooms（page_size=100 循环翻页拉全，28 间规模）
 * - GET /reservations?overlap_from&overlap_to（时间线窗口批量拉取，Sprint 4 后端扩展）
 * - GET /stays?status=ACTIVE（当前在住，stay:read）
 * - GET /housekeeping/tasks（保洁任务，housekeeping_task:read；展示层过滤进行中）
 *
 * 权限边界：无权限不请求、不显示（403 由后端最终裁决）。
 * 注意力中心（三条规则）与 Today Summary 完全由本 bundle 在客户端组合计算，
 * 不新增聚合 API（见 docs/DECISIONS.md Sprint 4）。
 */

import { useEffect, useState } from "react";
import { ApiError, api } from "@/lib/api";
import type {
  HousekeepingTaskOut,
  Page,
  ReservationOut,
  RoomOut,
  StayOut,
} from "@/lib/api/types";

export interface FrontDeskBundle {
  rooms: RoomOut[] | null;
  /** 窗口内全部状态预订（UI 层按 TIMELINE_STATUSES 过滤展示）。 */
  reservations: ReservationOut[] | null;
  /** ACTIVE 在住。 */
  stays: StayOut[] | null;
  /** 全部保洁任务（展示层过滤进行中）。 */
  tasks: HousekeepingTaskOut[] | null;
  /** 权限允许加载的必选数据（rooms + reservations + 可选域）是否已就绪。 */
  ready: boolean;
  error: ApiError | null;
  forbidden: boolean;
}

/** 循环翻页拉全（page_size=100；本项目规模分页有限，仍不假设只有一页）。 */
async function fetchAllPages<T>(
  fetchPage: (page: number) => Promise<Page<T>>,
): Promise<T[]> {
  const all: T[] = [];
  let page = 1;
  for (;;) {
    const result = await fetchPage(page);
    all.push(...result.items);
    if (result.page * result.page_size >= result.total) break;
    page += 1;
  }
  return all;
}

export function useFrontDeskData(
  permissions: Set<string>,
  reloadKey: number,
  winStart: string,
  winEndDate: string,
): FrontDeskBundle {
  const canRoom = permissions.has("room:read");
  const canReservation = permissions.has("reservation:read");
  const canStay = permissions.has("stay:read");
  const canHousekeeping = permissions.has("housekeeping_task:read");

  const [rooms, setRooms] = useState<RoomOut[] | null>(null);
  const [reservations, setReservations] = useState<ReservationOut[] | null>(
    null,
  );
  const [stays, setStays] = useState<StayOut[] | null>(null);
  const [tasks, setTasks] = useState<HousekeepingTaskOut[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const jobs: Promise<void>[] = [];

    if (canRoom) {
      jobs.push(
        fetchAllPages((page) =>
          api.rooms.list({ page, page_size: 100 }),
        )
          .then((items) => {
            if (!cancelled) setRooms(items);
          })
          .catch((err: unknown) => {
            if (!cancelled) throw err;
          }),
      );
    }
    if (canReservation) {
      jobs.push(
        fetchAllPages((page) =>
          api.reservations.list({
            page,
            page_size: 100,
            overlap_from: winStart,
            overlap_to: winEndDate,
          }),
        )
          .then((items) => {
            if (!cancelled) setReservations(items);
          })
          .catch((err: unknown) => {
            if (!cancelled) throw err;
          }),
      );
    }
    if (canStay) {
      jobs.push(
        fetchAllPages((page) =>
          api.stays.list({ page, page_size: 100, status: "ACTIVE" }),
        )
          .then((items) => {
            if (!cancelled) setStays(items);
          })
          .catch((err: unknown) => {
            if (!cancelled) throw err;
          }),
      );
    }
    if (canHousekeeping) {
      jobs.push(
        fetchAllPages((page) =>
          api.housekeeping.list({ page, page_size: 100 }),
        )
          .then((items) => {
            if (!cancelled) setTasks(items);
          })
          .catch((err: unknown) => {
            if (!cancelled) throw err;
          }),
      );
    }

    Promise.all(jobs)
      .then(() => {
        if (!cancelled) {
          setError(null);
          setForbidden(false);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError) {
          if (err.kind === "forbidden") {
            setForbidden(true);
            return;
          }
          setError(err);
          return;
        }
        setError(new ApiError("unknown", null, "加载失败"));
      });

    return () => {
      cancelled = true;
    };
  }, [
    permissions,
    reloadKey,
    winStart,
    winEndDate,
    canRoom,
    canReservation,
    canStay,
    canHousekeeping,
  ]);

  const ready =
    rooms !== null &&
    reservations !== null &&
    (!canStay || stays !== null) &&
    (!canHousekeeping || tasks !== null);

  return { rooms, reservations, stays, tasks, ready, error, forbidden };
}
