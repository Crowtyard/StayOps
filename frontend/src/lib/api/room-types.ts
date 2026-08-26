import { requestJson, type Transport } from "./client";
import type {
  Page,
  PageParams,
  RoomTypeCreate,
  RoomTypeOut,
  RoomTypeUpdate,
} from "./types";

export interface RoomTypesApi {
  list(params?: PageParams): Promise<Page<RoomTypeOut>>;
  get(id: number | string): Promise<RoomTypeOut>;
  create(body: RoomTypeCreate): Promise<RoomTypeOut>;
  update(id: number | string, body: RoomTypeUpdate): Promise<RoomTypeOut>;
  remove(id: number | string): Promise<void>;
}

export function createRoomTypesApi(transport: Transport): RoomTypesApi {
  return {
    list: (params) =>
      requestJson<Page<RoomTypeOut>>(transport, "/room-types", {
        query: { ...params },
      }),
    get: (id) => requestJson<RoomTypeOut>(transport, `/room-types/${id}`),
    create: (body) =>
      requestJson<RoomTypeOut>(transport, "/room-types", { method: "POST", body }),
    update: (id, body) =>
      requestJson<RoomTypeOut>(transport, `/room-types/${id}`, {
        method: "PUT",
        body,
      }),
    remove: (id) =>
      requestJson<void>(transport, `/room-types/${id}`, { method: "DELETE" }),
  };
}
