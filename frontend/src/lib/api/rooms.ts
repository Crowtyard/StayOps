import { requestJson, type Transport } from "./client";
import type {
  Page,
  RoomCreate,
  RoomListParams,
  RoomOut,
  RoomStatusChange,
  RoomSummaryOut,
  RoomUpdate,
} from "./types";

export interface RoomsApi {
  list(params?: RoomListParams): Promise<Page<RoomOut>>;
  get(id: number | string): Promise<RoomOut>;
  create(body: RoomCreate): Promise<RoomOut>;
  update(id: number | string, body: RoomUpdate): Promise<RoomOut>;
  /** alpha.9.6 F1：局部更新（与 update 同一后端实现） */
  patch(id: number | string, body: RoomUpdate): Promise<RoomOut>;
  /** alpha.9.6 F1：房间数量统计（后端 COUNT 计算） */
  summary(): Promise<RoomSummaryOut>;
  /** alpha.9.6 F1：停用房间（软停用，不释放房号） */
  disable(id: number | string): Promise<RoomOut>;
  /** alpha.9.6 F1：恢复启用房间 */
  enable(id: number | string): Promise<RoomOut>;
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
    patch: (id, body) =>
      requestJson<RoomOut>(transport, `/rooms/${id}`, { method: "PATCH", body }),
    summary: () => requestJson<RoomSummaryOut>(transport, "/rooms/summary"),
    disable: (id) =>
      requestJson<RoomOut>(transport, `/rooms/${id}/disable`, {
        method: "POST",
      }),
    enable: (id) =>
      requestJson<RoomOut>(transport, `/rooms/${id}/enable`, { method: "POST" }),
    remove: (id) =>
      requestJson<void>(transport, `/rooms/${id}`, { method: "DELETE" }),
    changeStatus: (id, body) =>
      requestJson<RoomOut>(transport, `/rooms/${id}/status`, {
        method: "POST",
        body,
      }),
  };
}
