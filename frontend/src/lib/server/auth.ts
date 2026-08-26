/**
 * 服务端认证与 API 访问（仅 Server Components / Route Handlers 使用）：
 * 从 HttpOnly Cookie 读 Token，直连后端 /api/v1 验证与取数。
 */

import { cookies } from "next/headers";
import { ApiError, requestJson, serverTransport } from "@/lib/api/client";
import { createApiClient, type ApiClient } from "@/lib/api";
import type { MeOut } from "@/lib/api/types";

/** HttpOnly Cookie 名称（与 /api/auth/login、/api/auth/logout 保持一致） */
export const AUTH_COOKIE = "stayops_token";

export async function getAccessToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(AUTH_COOKIE)?.value ?? null;
}

/** 服务端直连后端的 API Client */
export function createServerApi(token: string | null): ApiClient {
  return createApiClient(serverTransport(token));
}

/** 服务端调用 GET /api/v1/auth/me */
async function fetchCurrentUser(token: string): Promise<MeOut> {
  return requestJson<MeOut>(serverTransport(token), "/auth/me");
}

export interface CurrentUserResult {
  user: MeOut | null;
  /** 认证失败（401/403）或后端不可达等错误 */
  error: ApiError | null;
}

/** 读取当前用户；无 Cookie 视为未登录（401） */
export async function getCurrentUser(): Promise<CurrentUserResult> {
  const token = await getAccessToken();
  if (!token) {
    return {
      user: null,
      error: new ApiError("unauthorized", 401, "未登录"),
    };
  }
  try {
    const user = await fetchCurrentUser(token);
    return { user, error: null };
  } catch (err) {
    if (err instanceof ApiError) {
      return { user: null, error: err };
    }
    return {
      user: null,
      error: new ApiError("unknown", null, "读取当前用户失败"),
    };
  }
}
