/**
 * Analytics API 客户端（Sprint 8）。
 *
 * 权限域（§35/§37，后端最终权威；前端按 permission 决定是否发起请求）：
 * - operations/* + forecast -> analytics:operations_read
 * - business/*              -> analytics:business_read
 * 无权限的 Domain 一律不 fetch（禁止 fetch -> 403 -> 静默隐藏，§35）。
 */

import { requestJson, type Transport } from "./client";
import type {
  BookingsOut,
  BusinessInventoryOut,
  BusinessProcurementOut,
  BusinessRoomsOut,
  ForecastOut,
  HousekeepingOut,
  MaintenanceOut,
  OperationsOverviewOut,
  RoomMovesOut,
} from "./types";
import type { ComparisonMode } from "@/lib/analytics";

export interface AnalyticsPeriodParams {
  from: string;
  to: string;
  compare?: boolean;
  /** 对比语义（D1）：equal_length / previous_calendar_month / previous_month_elapsed */
  comparison_mode?: ComparisonMode;
}

export interface AnalyticsApi {
  operationsOverview(
    params: AnalyticsPeriodParams,
  ): Promise<OperationsOverviewOut>;
  operationsBookings(params: AnalyticsPeriodParams): Promise<BookingsOut>;
  operationsHousekeeping(
    params: AnalyticsPeriodParams,
  ): Promise<HousekeepingOut>;
  operationsMaintenance(
    params: AnalyticsPeriodParams,
  ): Promise<MaintenanceOut>;
  operationsRoomMoves(params: AnalyticsPeriodParams): Promise<RoomMovesOut>;
  businessRooms(params: AnalyticsPeriodParams): Promise<BusinessRoomsOut>;
  businessInventory(
    params: AnalyticsPeriodParams,
  ): Promise<BusinessInventoryOut>;
  businessProcurement(
    params: AnalyticsPeriodParams,
  ): Promise<BusinessProcurementOut>;
  forecast(): Promise<ForecastOut>;
}

export function createAnalyticsApi(transport: Transport): AnalyticsApi {
  return {
    operationsOverview: (params) =>
      requestJson<OperationsOverviewOut>(transport, "/analytics/operations/overview", {
        query: { ...params },
      }),
    operationsBookings: (params) =>
      requestJson<BookingsOut>(transport, "/analytics/operations/bookings", {
        query: { ...params },
      }),
    operationsHousekeeping: (params) =>
      requestJson<HousekeepingOut>(transport, "/analytics/operations/housekeeping", {
        query: { ...params },
      }),
    operationsMaintenance: (params) =>
      requestJson<MaintenanceOut>(transport, "/analytics/operations/maintenance", {
        query: { ...params },
      }),
    operationsRoomMoves: (params) =>
      requestJson<RoomMovesOut>(transport, "/analytics/operations/room-moves", {
        query: { ...params },
      }),
    businessRooms: (params) =>
      requestJson<BusinessRoomsOut>(transport, "/analytics/business/rooms", {
        query: { ...params },
      }),
    businessInventory: (params) =>
      requestJson<BusinessInventoryOut>(transport, "/analytics/business/inventory", {
        query: { ...params },
      }),
    businessProcurement: (params) =>
      requestJson<BusinessProcurementOut>(transport, "/analytics/business/procurement", {
        query: { ...params },
      }),
    forecast: () =>
      requestJson<ForecastOut>(transport, "/analytics/forecast"),
  };
}
