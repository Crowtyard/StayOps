import { requestJson, type Transport } from "./client";
import type { Page, PageParams, PermissionOut } from "./types";

export interface PermissionsApi {
  list(params?: PageParams): Promise<Page<PermissionOut>>;
}

export function createPermissionsApi(transport: Transport): PermissionsApi {
  return {
    list: (params) =>
      requestJson<Page<PermissionOut>>(transport, "/permissions", {
        query: { ...params },
      }),
  };
}
