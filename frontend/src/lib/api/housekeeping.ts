import { requestJson, type Transport } from "./client";
import type { HousekeepingAssigneeOut, HousekeepingTaskListParams, HousekeepingTaskOut, HousekeepingTaskUpdate, Page } from "./types";

export interface HousekeepingApi {
  list(params?: HousekeepingTaskListParams): Promise<Page<HousekeepingTaskOut>>;
  get(id: number | string): Promise<HousekeepingTaskOut>;
  create(payload: {
    room_id: number;
    priority?: "NORMAL" | "URGENT";
    notes?: string | null;
  }): Promise<HousekeepingTaskOut>;
  update(id: number | string, payload: HousekeepingTaskUpdate): Promise<HousekeepingTaskOut>;
  assignees(): Promise<HousekeepingAssigneeOut[]>;
  start(id: number | string): Promise<HousekeepingTaskOut>;
  submitInspection(id: number | string): Promise<HousekeepingTaskOut>;
  pass(id: number | string): Promise<HousekeepingTaskOut>;
  rework(id: number | string): Promise<HousekeepingTaskOut>;
  cancel(id: number | string): Promise<HousekeepingTaskOut>;
}

export function createHousekeepingApi(transport: Transport): HousekeepingApi {
  return {
    list: (params) =>
      requestJson<Page<HousekeepingTaskOut>>(transport, "/housekeeping/tasks", {
        query: { ...params },
      }),
    get: (id) => requestJson<HousekeepingTaskOut>(transport, `/housekeeping/tasks/${id}`),
    create: (payload) =>
      requestJson<HousekeepingTaskOut>(transport, "/housekeeping/tasks", {
        method: "POST",
        body: payload,
      }),
    update: (id, payload) =>
      requestJson<HousekeepingTaskOut>(transport, `/housekeeping/tasks/${id}`, {
        method: "PATCH",
        body: payload,
      }),
    assignees: () =>
      requestJson<HousekeepingAssigneeOut[]>(transport, "/housekeeping/assignees"),
    start: (id) =>
      requestJson<HousekeepingTaskOut>(transport, `/housekeeping/tasks/${id}/start`, {
        method: "POST",
      }),
    submitInspection: (id) =>
      requestJson<HousekeepingTaskOut>(
        transport,
        `/housekeeping/tasks/${id}/submit-inspection`,
        { method: "POST" },
      ),
    pass: (id) =>
      requestJson<HousekeepingTaskOut>(transport, `/housekeeping/tasks/${id}/pass`, {
        method: "POST",
      }),
    rework: (id) =>
      requestJson<HousekeepingTaskOut>(transport, `/housekeeping/tasks/${id}/rework`, {
        method: "POST",
      }),
    cancel: (id) =>
      requestJson<HousekeepingTaskOut>(transport, `/housekeeping/tasks/${id}/cancel`, {
        method: "POST",
      }),
  };
}
