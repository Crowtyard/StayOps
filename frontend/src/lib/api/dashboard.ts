import { requestJson, type Transport } from "./client";
import type { RoomStatusOut } from "./types";

/**
 * Dashboard API（alpha.9.6 F2：首页房态概览按日期显示）。
 *
 * 核心业务规则全部在后端（GET /dashboard/room-status）：
 * 前端不得自行拉全部预订后计算房态。
 */
export interface DashboardApi {
  roomStatus(params?: { date?: string }): Promise<RoomStatusOut>;
}

export function createDashboardApi(transport: Transport): DashboardApi {
  return {
    roomStatus: (params) =>
      requestJson<RoomStatusOut>(transport, "/dashboard/room-status", {
        query: params?.date ? { date: params.date } : {},
      }),
  };
}
