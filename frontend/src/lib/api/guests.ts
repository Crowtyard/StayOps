import { requestJson, type Transport } from "./client";
import type {
  GuestCreate,
  GuestListParams,
  GuestOut,
  GuestUpdate,
  Page,
} from "./types";

export interface GuestsApi {
  list(params?: GuestListParams): Promise<Page<GuestOut>>;
  get(id: number | string): Promise<GuestOut>;
  create(body: GuestCreate): Promise<GuestOut>;
  update(id: number | string, body: GuestUpdate): Promise<GuestOut>;
}

export function createGuestsApi(transport: Transport): GuestsApi {
  return {
    list: (params) =>
      requestJson<Page<GuestOut>>(transport, "/guests", {
        query: { ...params },
      }),
    get: (id) => requestJson<GuestOut>(transport, `/guests/${id}`),
    create: (body) =>
      requestJson<GuestOut>(transport, "/guests", { method: "POST", body }),
    update: (id, body) =>
      requestJson<GuestOut>(transport, `/guests/${id}`, {
        method: "PATCH",
        body,
      }),
  };
}
