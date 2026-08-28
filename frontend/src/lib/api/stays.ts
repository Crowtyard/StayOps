import { requestJson, type Transport } from "./client";
import type {
  Page,
  RoomMoveCreate,
  RoomMoveOptionsOut,
  StayListParams,
  StayOut,
} from "./types";

export interface StaysApi {
  list(params?: StayListParams): Promise<Page<StayOut>>;
  get(id: number | string): Promise<StayOut>;
  checkOut(id: number | string): Promise<StayOut>;
  /** Sprint 6 §9：目标房候选（后端权威结果驱动 UI）。 */
  roomMoveOptions(id: number | string): Promise<RoomMoveOptionsOut>;
  /** Sprint 6 §9：原子换房（专用 Action API，不允许 PATCH Stay.room_id）。 */
  roomMove(id: number | string, payload: RoomMoveCreate): Promise<StayOut>;
}

export function createStaysApi(transport: Transport): StaysApi {
  return {
    list: (params) =>
      requestJson<Page<StayOut>>(transport, "/stays", {
        query: { ...params },
      }),
    get: (id) => requestJson<StayOut>(transport, `/stays/${id}`),
    checkOut: (id) =>
      requestJson<StayOut>(transport, `/stays/${id}/check-out`, {
        method: "POST",
      }),
    roomMoveOptions: (id) =>
      requestJson<RoomMoveOptionsOut>(
        transport,
        `/stays/${id}/room-move-options`,
      ),
    roomMove: (id, payload) =>
      requestJson<StayOut>(transport, `/stays/${id}/room-move`, {
        method: "POST",
        body: payload,
      }),
  };
}
