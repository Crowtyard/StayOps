import { requestJson, type Transport } from "./client";
import type { Page, PageParams, UserCreate, UserOut, UserUpdate } from "./types";

export interface UsersApi {
  list(params?: PageParams): Promise<Page<UserOut>>;
  get(id: number | string): Promise<UserOut>;
  create(body: UserCreate): Promise<UserOut>;
  update(id: number | string, body: UserUpdate): Promise<UserOut>;
  remove(id: number | string): Promise<void>;
  assignRoles(id: number | string, roleIds: number[]): Promise<UserOut>;
}

export function createUsersApi(transport: Transport): UsersApi {
  return {
    list: (params) =>
      requestJson<Page<UserOut>>(transport, "/users", { query: { ...params } }),
    get: (id) => requestJson<UserOut>(transport, `/users/${id}`),
    create: (body) =>
      requestJson<UserOut>(transport, "/users", { method: "POST", body }),
    update: (id, body) =>
      requestJson<UserOut>(transport, `/users/${id}`, { method: "PUT", body }),
    remove: (id) =>
      requestJson<void>(transport, `/users/${id}`, { method: "DELETE" }),
    assignRoles: (id, roleIds) =>
      requestJson<UserOut>(transport, `/users/${id}/roles`, {
        method: "POST",
        body: { role_ids: roleIds },
      }),
  };
}
