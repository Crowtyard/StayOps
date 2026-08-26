import { requestJson, type Transport } from "./client";
import type {
  Page,
  PageParams,
  RoleCreate,
  RoleOut,
  RoleUpdate,
} from "./types";

export interface RolesApi {
  list(params?: PageParams): Promise<Page<RoleOut>>;
  get(id: number | string): Promise<RoleOut>;
  create(body: RoleCreate): Promise<RoleOut>;
  update(id: number | string, body: RoleUpdate): Promise<RoleOut>;
  remove(id: number | string): Promise<void>;
  setPermissions(id: number | string, permissionIds: number[]): Promise<RoleOut>;
}

export function createRolesApi(transport: Transport): RolesApi {
  return {
    list: (params) =>
      requestJson<Page<RoleOut>>(transport, "/roles", { query: { ...params } }),
    get: (id) => requestJson<RoleOut>(transport, `/roles/${id}`),
    create: (body) =>
      requestJson<RoleOut>(transport, "/roles", { method: "POST", body }),
    update: (id, body) =>
      requestJson<RoleOut>(transport, `/roles/${id}`, { method: "PUT", body }),
    remove: (id) =>
      requestJson<void>(transport, `/roles/${id}`, { method: "DELETE" }),
    setPermissions: (id, permissionIds) =>
      requestJson<RoleOut>(transport, `/roles/${id}/permissions`, {
        method: "POST",
        body: { permission_ids: permissionIds },
      }),
  };
}
