import { requestJson, type Transport } from "./client";
import type {
  MaintenanceAssigneeOut,
  MaintenanceWorkOrderCreate,
  MaintenanceWorkOrderListParams,
  MaintenanceWorkOrderOut,
  MaintenanceWorkOrderUpdate,
  Page,
} from "./types";

export interface MaintenanceApi {
  list(params?: MaintenanceWorkOrderListParams): Promise<Page<MaintenanceWorkOrderOut>>;
  get(id: number | string): Promise<MaintenanceWorkOrderOut>;
  create(payload: MaintenanceWorkOrderCreate): Promise<MaintenanceWorkOrderOut>;
  update(id: number | string, payload: MaintenanceWorkOrderUpdate): Promise<MaintenanceWorkOrderOut>;
  assignees(): Promise<MaintenanceAssigneeOut[]>;
  assign(id: number | string, userId: number): Promise<MaintenanceWorkOrderOut>;
  start(id: number | string): Promise<MaintenanceWorkOrderOut>;
  resolve(id: number | string, notes?: string | null): Promise<MaintenanceWorkOrderOut>;
  verify(id: number | string, notes?: string | null): Promise<MaintenanceWorkOrderOut>;
  rework(id: number | string, notes?: string | null): Promise<MaintenanceWorkOrderOut>;
  cancel(id: number | string): Promise<MaintenanceWorkOrderOut>;
}

export function createMaintenanceApi(transport: Transport): MaintenanceApi {
  return {
    list: (params) =>
      requestJson<Page<MaintenanceWorkOrderOut>>(transport, "/maintenance/orders", {
        query: { ...params },
      }),
    get: (id) => requestJson<MaintenanceWorkOrderOut>(transport, `/maintenance/orders/${id}`),
    create: (payload) =>
      requestJson<MaintenanceWorkOrderOut>(transport, "/maintenance/orders", {
        method: "POST",
        body: payload,
      }),
    update: (id, payload) =>
      requestJson<MaintenanceWorkOrderOut>(transport, `/maintenance/orders/${id}`, {
        method: "PATCH",
        body: payload,
      }),
    assignees: () =>
      requestJson<MaintenanceAssigneeOut[]>(transport, "/maintenance/assignees"),
    assign: (id, userId) =>
      requestJson<MaintenanceWorkOrderOut>(transport, `/maintenance/orders/${id}/assign`, {
        method: "POST",
        body: { assigned_to_user_id: userId },
      }),
    start: (id) =>
      requestJson<MaintenanceWorkOrderOut>(transport, `/maintenance/orders/${id}/start`, {
        method: "POST",
      }),
    resolve: (id, notes) =>
      requestJson<MaintenanceWorkOrderOut>(transport, `/maintenance/orders/${id}/resolve`, {
        method: "POST",
        body: notes ? { resolution_notes: notes } : {},
      }),
    verify: (id, notes) =>
      requestJson<MaintenanceWorkOrderOut>(transport, `/maintenance/orders/${id}/verify`, {
        method: "POST",
        body: notes ? { verification_notes: notes } : {},
      }),
    rework: (id, notes) =>
      requestJson<MaintenanceWorkOrderOut>(transport, `/maintenance/orders/${id}/rework`, {
        method: "POST",
        body: notes ? { verification_notes: notes } : {},
      }),
    cancel: (id) =>
      requestJson<MaintenanceWorkOrderOut>(transport, `/maintenance/orders/${id}/cancel`, {
        method: "POST",
      }),
  };
}
