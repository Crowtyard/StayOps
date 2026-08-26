/**
 * 认证模块（浏览器端）：
 * 直接调用前端自身 Route Handler /api/auth/*，
 * Token 只存在 HttpOnly Cookie 中，浏览器代码不接触 Token。
 */

import { ApiError } from "./client";
import type { MeOut } from "./types";

const AUTH_BASE = "/api/auth";

async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${AUTH_BASE}${path}`, {
      ...init,
      headers: { Accept: "application/json", ...init?.headers },
      cache: "no-store",
    });
  } catch {
    throw new ApiError("network", null, "服务暂时不可用，请稍后重试");
  }
  return res;
}

async function parseError(res: Response, fallback: string): Promise<ApiError> {
  let detail: unknown = null;
  try {
    const text = await res.text();
    if (text) {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && "detail" in parsed) {
        detail = (parsed as { detail: unknown }).detail;
      }
    }
  } catch {
    // 忽略非 JSON 响应
  }
  if (res.status === 401) {
    return new ApiError("unauthorized", 401, fallback);
  }
  if (res.status >= 500) {
    return new ApiError("server", res.status, "服务暂时不可用，请稍后重试");
  }
  const message = typeof detail === "string" && detail ? detail : fallback;
  return new ApiError("unknown", res.status, message);
}

/** 登录成功后返回当前用户（角色 + 权限），失败抛 ApiError */
export async function login(username: string, password: string): Promise<MeOut> {
  const res = await authFetch("/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });

  if (res.ok) {
    const data = (await res.json()) as MeOut;
    return data;
  }

  if (res.status === 401 || res.status === 422) {
    throw new ApiError("unauthorized", res.status, "用户名或密码错误");
  }
  throw await parseError(res, "登录失败，请稍后重试");
}

/** 退出登录（清 Cookie） */
export async function logout(): Promise<void> {
  const res = await authFetch("/logout", { method: "POST" });
  if (!res.ok) {
    throw await parseError(res, "退出失败，请稍后重试");
  }
}

/** 读取当前登录用户（Cookie → /api/auth/me） */
export async function me(): Promise<MeOut> {
  const res = await authFetch("/me");
  if (res.ok) {
    return (await res.json()) as MeOut;
  }
  throw await parseError(res, "登录已失效，请重新登录");
}
