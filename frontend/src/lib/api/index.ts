/**
 * 统一 API Client 组装：
 * - 浏览器端 `api`：经 /api/bff/* 转发（HttpOnly Cookie 认证）
 * - 服务端 `createServerApi(token)`：直连后端并附加 Bearer
 */

import { browserTransport, type Transport } from "./client";
import { createAuditLogsApi, type AuditLogsApi } from "./audit-logs";
import { createAvailabilityApi, type AvailabilityApi } from "./availability";
import { createGuestsApi, type GuestsApi } from "./guests";
import { createHousekeepingApi, type HousekeepingApi } from "./housekeeping";
import { createPermissionsApi, type PermissionsApi } from "./permissions";
import { createReservationsApi, type ReservationsApi } from "./reservations";
import { createRolesApi, type RolesApi } from "./roles";
import { createRoomsApi, type RoomsApi } from "./rooms";
import { createRoomTypesApi, type RoomTypesApi } from "./room-types";
import { createStaysApi, type StaysApi } from "./stays";
import { createUsersApi, type UsersApi } from "./users";

export interface ApiClient {
  rooms: RoomsApi;
  roomTypes: RoomTypesApi;
  users: UsersApi;
  roles: RolesApi;
  permissions: PermissionsApi;
  auditLogs: AuditLogsApi;
  guests: GuestsApi;
  reservations: ReservationsApi;
  stays: StaysApi;
  availability: AvailabilityApi;
  housekeeping: HousekeepingApi;
}

export function createApiClient(transport: Transport): ApiClient {
  return {
    rooms: createRoomsApi(transport),
    roomTypes: createRoomTypesApi(transport),
    users: createUsersApi(transport),
    roles: createRolesApi(transport),
    permissions: createPermissionsApi(transport),
    auditLogs: createAuditLogsApi(transport),
    guests: createGuestsApi(transport),
    reservations: createReservationsApi(transport),
    stays: createStaysApi(transport),
    availability: createAvailabilityApi(transport),
    housekeeping: createHousekeepingApi(transport),
  };
}

/** 浏览器端统一 Client（客户端组件使用） */
export const api = createApiClient(browserTransport);

export * from "./client";
export * from "./types";
export { login, logout, me } from "./auth";
