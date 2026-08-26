/**
 * 服务端登录守卫 getCurrentUser（(main) 布局使用）：
 * - 无 Cookie → 未登录（unauthorized）
 * - Cookie 有效 → 返回用户
 * - 后端不可达 → network（布局渲染离线壳，不跳登录）
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { cookieStoreGet } = vi.hoisted(() => ({
  cookieStoreGet: vi.fn<(name: string) => { value: string } | undefined>(),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: cookieStoreGet }),
}));

import { getCurrentUser } from "@/lib/server/auth";

const ME_FIXTURE = {
  id: 1,
  username: "admin",
  display_name: null,
  email: null,
  phone: null,
  is_active: true,
  created_at: "2026-08-25T09:00:00Z",
  updated_at: "2026-08-25T09:00:00Z",
  roles: [{ id: 1, name: "SUPER_ADMIN" }],
  permissions: ["user:read"],
};

describe("getCurrentUser（服务端登录守卫）", () => {
  beforeEach(() => {
    vi.stubEnv("BACKEND_API_URL", "http://127.0.0.1:8000");
    vi.stubGlobal("fetch", vi.fn());
    cookieStoreGet.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("无 stayops_token Cookie → 未登录", async () => {
    cookieStoreGet.mockReturnValue(undefined);
    const { user, error } = await getCurrentUser();
    expect(user).toBeNull();
    expect(error?.kind).toBe("unauthorized");
  });

  it("Cookie 有效且后端校验通过 → 返回用户", async () => {
    cookieStoreGet.mockReturnValue({ value: "jwt-token" });
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(ME_FIXTURE), { status: 200 }),
    );
    const { user, error } = await getCurrentUser();
    expect(error).toBeNull();
    expect(user?.username).toBe("admin");
    // 服务端直连后端并附加 Bearer
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toBe("http://127.0.0.1:8000/api/v1/auth/me");
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer jwt-token");
  });

  it("后端返回 401 → error.kind = unauthorized（布局据此跳 /login）", async () => {
    cookieStoreGet.mockReturnValue({ value: "expired-token" });
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ detail: "Token 无效或已过期" }), {
        status: 401,
      }),
    );
    const { user, error } = await getCurrentUser();
    expect(user).toBeNull();
    expect(error?.kind).toBe("unauthorized");
  });

  it("账号禁用（403）→ error.kind = forbidden（同样跳 /login）", async () => {
    cookieStoreGet.mockReturnValue({ value: "jwt-token" });
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ detail: "账号已禁用" }), { status: 403 }),
    );
    const { user, error } = await getCurrentUser();
    expect(user).toBeNull();
    expect(error?.kind).toBe("forbidden");
  });

  it("后端不可达 → error.kind = network（渲染离线壳而非强制跳转）", async () => {
    cookieStoreGet.mockReturnValue({ value: "jwt-token" });
    vi.mocked(fetch).mockRejectedValue(new TypeError("fetch failed"));
    const { user, error } = await getCurrentUser();
    expect(user).toBeNull();
    expect(error?.kind).toBe("network");
  });
});
