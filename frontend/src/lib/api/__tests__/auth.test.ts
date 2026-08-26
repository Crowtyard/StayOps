/**
 * 认证状态处理测试：
 * - 浏览器端 login/logout/me（对 /api/auth/* 的调用、错误语义）
 * - 服务端登录守卫 getCurrentUser（HttpOnly Cookie 读取、401/网络错误）
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { login, logout, me } from "@/lib/api/auth";

const ME_FIXTURE = {
  id: 1,
  username: "admin",
  display_name: "管理员",
  email: null,
  phone: null,
  is_active: true,
  created_at: "2026-08-25T09:00:00Z",
  updated_at: "2026-08-25T09:00:00Z",
  roles: [{ id: 1, name: "SUPER_ADMIN" }],
  permissions: ["user:read", "role:read"],
};

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("login（浏览器端 /api/auth/login）", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("登录成功返回当前用户（角色 + 权限）", async () => {
    vi.mocked(fetch).mockResolvedValue(ok(ME_FIXTURE));
    const user = await login("admin", "Admin@123456");
    expect(user.username).toBe("admin");
    expect(user.permissions).toContain("user:read");
    expect(fetch).toHaveBeenCalledWith(
      "/api/auth/login",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse(
      vi.mocked(fetch).mock.calls[0][1]?.body as string,
    );
    expect(body).toEqual({ username: "admin", password: "Admin@123456" });
  });

  it("凭据错误（401）→ 用户名或密码错误", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ detail: "用户名或密码错误" }), {
        status: 401,
      }),
    );
    const err = await login("admin", "wrong").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe("用户名或密码错误");
  });

  it("参数校验失败（422）→ 同样提示用户名或密码错误（不泄露细节）", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ detail: [{ msg: "字段必填" }] }), {
        status: 422,
      }),
    );
    const err = await login("", "").catch((e: unknown) => e);
    expect((err as ApiError).message).toBe("用户名或密码错误");
  });

  it("网络失败 → 服务暂时不可用", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("fetch failed"));
    const err = await login("admin", "Admin@123456").catch((e: unknown) => e);
    expect((err as ApiError).kind).toBe("network");
    expect((err as ApiError).message).toBe("服务暂时不可用，请稍后重试");
  });
});

describe("logout（清 HttpOnly Cookie）", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("成功退出（POST /api/auth/logout）", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 200 }));
    await expect(logout()).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith(
      "/api/auth/logout",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("服务端错误 → 抛出 ApiError", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 500 }));
    await expect(logout()).rejects.toBeInstanceOf(ApiError);
  });
});

describe("me（读取当前用户）", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("返回当前用户", async () => {
    vi.mocked(fetch).mockResolvedValue(ok(ME_FIXTURE));
    const user = await me();
    expect(user.roles[0].name).toBe("SUPER_ADMIN");
  });

  it("401 → unauthorized", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ detail: "未登录" }), { status: 401 }),
    );
    const err = await me().catch((e: unknown) => e);
    expect((err as ApiError).kind).toBe("unauthorized");
  });
});
