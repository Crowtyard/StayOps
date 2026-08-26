import { cookies } from "next/headers";
import { backendUrl, DEFAULT_TIMEOUT_MS } from "@/lib/api/client";
import { AUTH_COOKIE } from "@/lib/server/auth";
import type { MeOut, TokenResponse } from "@/lib/api/types";

/**
 * POST /api/auth/login
 * 转发后端登录，成功后把 access_token 写入 HttpOnly Cookie，
 * 并顺带读取 /auth/me 返回用户+角色+权限（浏览器端不接触 Token）。
 */
export async function POST(request: Request) {
  let username: string;
  let password: string;
  try {
    const body = (await request.json()) as { username?: unknown; password?: unknown };
    username = typeof body?.username === "string" ? body.username : "";
    password = typeof body?.password === "string" ? body.password : "";
  } catch {
    return Response.json({ detail: "请求格式有误" }, { status: 400 });
  }

  if (!username || !password) {
    return Response.json({ detail: "请输入用户名和密码" }, { status: 422 });
  }

  const base = backendUrl();

  let loginRes: Response;
  try {
    loginRes = await fetch(`${base}/api/v1/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Forwarded-For": clientIp(request),
      },
      body: JSON.stringify({ username, password }),
      cache: "no-store",
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch {
    return Response.json(
      { detail: "服务暂时不可用，请稍后重试" },
      { status: 502 },
    );
  }

  if (!loginRes.ok) {
    const status = loginRes.status;
    const detail = await readDetail(loginRes);
    if (status === 401) {
      return Response.json({ detail: "用户名或密码错误" }, { status: 401 });
    }
    if (status === 403) {
      return Response.json({ detail: detail ?? "账号已禁用" }, { status: 403 });
    }
    if (status === 422) {
      return Response.json({ detail: "用户名或密码错误" }, { status: 422 });
    }
    return Response.json({ detail: detail ?? "登录失败，请稍后重试" }, { status });
  }

  const token = (await loginRes.json()) as TokenResponse;
  if (!token.access_token) {
    return Response.json(
      { detail: "服务暂时不可用，请稍后重试" },
      { status: 502 },
    );
  }

  // 写入 HttpOnly Cookie（生产环境 secure=true）
  const cookieStore = await cookies();
  cookieStore.set(AUTH_COOKIE, token.access_token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: Math.max(1, token.expires_in ?? 12 * 3600),
  });

  // 读取当前用户信息一并返回，减少一次浏览器往返
  try {
    const meRes = await fetch(`${base}/api/v1/auth/me`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token.access_token}`,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (meRes.ok) {
      const user = (await meRes.json()) as MeOut;
      return Response.json(user);
    }
  } catch {
    // 用户信息读取失败不影响已登录状态，交由客户端再次调用 /api/auth/me
  }

  return Response.json({ detail: "服务暂时不可用，请稍后重试" }, { status: 502 });
}

function clientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return request.headers.get("x-real-ip") ?? "127.0.0.1";
}

async function readDetail(res: Response): Promise<string | null> {
  try {
    const text = await res.text();
    if (!text) return null;
    const parsed = JSON.parse(text) as { detail?: unknown };
    return typeof parsed.detail === "string" ? parsed.detail : null;
  } catch {
    return null;
  }
}
