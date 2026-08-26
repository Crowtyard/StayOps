import { requestJson, type Transport } from "./client";
import type { AuditLogListParams, AuditLogOut, Page } from "./types";

export interface AuditLogsApi {
  list(params?: AuditLogListParams): Promise<Page<AuditLogOut>>;
}

export function createAuditLogsApi(transport: Transport): AuditLogsApi {
  return {
    list: (params) =>
      requestJson<Page<AuditLogOut>>(transport, "/audit-logs", {
        query: { ...params },
      }),
  };
}
