import { requestJson, type Transport } from "./client";
import type {
  ChannelCreate,
  ChannelListParams,
  ChannelOut,
  ChannelUpdate,
  Page,
} from "./types";

/**
 * 客源渠道主数据 API（alpha.9.6 F3）。
 *
 * - 默认 list 只返回启用渠道（前台选择来源渠道即可用）
 * - 渠道管理界面传 include_disabled=true 查看全部
 * - 权限：channel:read 读取；channel:write 管理（后端强制）
 */
export interface ChannelsApi {
  list(params?: ChannelListParams): Promise<Page<ChannelOut>>;
  get(id: number | string): Promise<ChannelOut>;
  create(body: ChannelCreate): Promise<ChannelOut>;
  patch(id: number | string, body: ChannelUpdate): Promise<ChannelOut>;
  enable(id: number | string): Promise<ChannelOut>;
  disable(id: number | string): Promise<ChannelOut>;
  remove(id: number | string): Promise<void>;
}

export function createChannelsApi(transport: Transport): ChannelsApi {
  return {
    list: (params) =>
      requestJson<Page<ChannelOut>>(transport, "/channels", {
        query: { ...params },
      }),
    get: (id) => requestJson<ChannelOut>(transport, `/channels/${id}`),
    create: (body) =>
      requestJson<ChannelOut>(transport, "/channels", { method: "POST", body }),
    patch: (id, body) =>
      requestJson<ChannelOut>(transport, `/channels/${id}`, {
        method: "PATCH",
        body,
      }),
    enable: (id) =>
      requestJson<ChannelOut>(transport, `/channels/${id}/enable`, {
        method: "POST",
      }),
    disable: (id) =>
      requestJson<ChannelOut>(transport, `/channels/${id}/disable`, {
        method: "POST",
      }),
    remove: (id) =>
      requestJson<void>(transport, `/channels/${id}`, { method: "DELETE" }),
  };
}
