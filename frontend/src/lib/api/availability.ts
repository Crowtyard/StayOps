import { requestJson, type Transport } from "./client";
import type { AvailabilityOut, AvailabilityParams } from "./types";

export interface AvailabilityApi {
  query(params: AvailabilityParams): Promise<AvailabilityOut>;
}

export function createAvailabilityApi(transport: Transport): AvailabilityApi {
  return {
    query: (params) =>
      requestJson<AvailabilityOut>(transport, "/availability", {
        query: { ...params },
      }),
  };
}
