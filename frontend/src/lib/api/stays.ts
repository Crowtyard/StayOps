import { requestJson, type Transport } from "./client";
import type { Page, StayListParams, StayOut } from "./types";

export interface StaysApi {
  list(params?: StayListParams): Promise<Page<StayOut>>;
  get(id: number | string): Promise<StayOut>;
  checkOut(id: number | string): Promise<StayOut>;
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
  };
}
