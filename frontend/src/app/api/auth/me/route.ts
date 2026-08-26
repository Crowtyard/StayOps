import { cookies } from "next/headers";
import { backendUrl, DEFAULT_TIMEOUT_MS } from "@/lib/api/client";
import { AUTH_COOKIE } from "@/lib/server/auth";
import type { MeOut } from "@/lib/api/types";

/** GET /api/auth/me — 读 Cookie → 调后端 /auth/me，返回用户+角色+权限 */
export async function GET() {
  const cookieStore = await cookies();
  const token = cookieStore.get(AUTH_COOKIE)?.value;

  if (!token) {
    return Response.json({ detail: "未登录" }, { status: 401 });
  }

  let res: Response;
  try {
    res = await fetch(`${backendUrl()}/api/v1/auth/me`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch {
    return Response.json(
      { detail: "服务暂时不可用，请稍后重试" },
      { status: 502 },
    );
  }

  if (res.ok) {
    const user = (await res.json()) as MeOut;
    return Response.json(user);
  }

  if (res.status === 401) {
    // Token 失效：清除 Cookie，前端跳 /login
    cookieStore.delete(AUTH_COOKIE);
    return Response.json(
      { detail: "登录已失效，请重新登录" },
      { status: 401 },
    );
  }

  const detail = await readDetail(res);
  return Response.json(
    { detail: detail ?? "读取当前用户失败" },
    { status: res.status },
  );
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
