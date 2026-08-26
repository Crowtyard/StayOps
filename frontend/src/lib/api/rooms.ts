import { requestJson, type Transport } from "./client";
import type {
  Page,
  RoomCreate,
  RoomListParams,
  RoomOut,
  RoomStatusChange,
  RoomUpdate,
} from "./types";

export interface RoomsApi {
  list(params?: RoomListParams): Promise<Page<RoomOut>>;
  get(id: number | string): Promise<RoomOut>;
  create(body: RoomCreate): Promise<RoomOut>;
  update(id: number | string, body: RoomUpdate): Promise<RoomOut>;
  remove(id: number | string): Promise<void>;
  changeStatus(id: number | string, body: RoomStatusChange): Promise<RoomOut>;
}

export function createRoomsApi(transport: Transport): RoomsApi {
  return {
    list: (params) =>
      requestJson<Page<RoomOut>>(transport, "/rooms", { query: { ...params } }),
    get: (id) => requestJson<RoomOut>(transport, `/rooms/${id}`),
    create: (body) =>
      requestJson<RoomOut>(transport, "/rooms", { method: "POST", body }),
    update: (id, body) =>
      requestJson<RoomOut>(transport, `/rooms/${id}`, { method: "PUT", body }),
    remove: (id) =>
      requestJson<void>(transport, `/rooms/${id}`, { method: "DELETE" }),
    changeStatus: (id, body) =>
      requestJson<RoomOut>(transport, `/rooms/${id}/status`, {
        method: "POST",
        body,
      }),
  };
}
