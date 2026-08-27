import { requestJson, type Transport } from "./client";
import type {
  CheckInOut,
  Page,
  ReservationCreate,
  ReservationListParams,
  ReservationOut,
  ReservationUpdate,
} from "./types";

export interface ReservationsApi {
  list(params?: ReservationListParams): Promise<Page<ReservationOut>>;
  get(id: number | string): Promise<ReservationOut>;
  create(body: ReservationCreate): Promise<ReservationOut>;
  update(id: number | string, body: ReservationUpdate): Promise<ReservationOut>;
  cancel(id: number | string): Promise<ReservationOut>;
  noShow(id: number | string): Promise<ReservationOut>;
  checkIn(id: number | string): Promise<CheckInOut>;
}

export function createReservationsApi(transport: Transport): ReservationsApi {
  return {
    list: (params) =>
      requestJson<Page<ReservationOut>>(transport, "/reservations", {
        query: { ...params },
      }),
    get: (id) => requestJson<ReservationOut>(transport, `/reservations/${id}`),
    create: (body) =>
      requestJson<ReservationOut>(transport, "/reservations", {
        method: "POST",
        body,
      }),
    update: (id, body) =>
      requestJson<ReservationOut>(transport, `/reservations/${id}`, {
        method: "PATCH",
        body,
      }),
    cancel: (id) =>
      requestJson<ReservationOut>(transport, `/reservations/${id}/cancel`, {
        method: "POST",
      }),
    noShow: (id) =>
      requestJson<ReservationOut>(transport, `/reservations/${id}/no-show`, {
        method: "POST",
      }),
    checkIn: (id) =>
      requestJson<CheckInOut>(transport, `/reservations/${id}/check-in`, {
        method: "POST",
      }),
  };
}
