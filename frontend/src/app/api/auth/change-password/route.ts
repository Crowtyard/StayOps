import { cookies } from "next/headers";
import { backendUrl, DEFAULT_TIMEOUT_MS } from "@/lib/api/client";
import { AUTH_COOKIE } from "@/lib/server/auth";
import type { MeOut } from "@/lib/api/types";

/**
 * POST /api/auth/change-password
 * 自助修改密码（D2 首次安装强制改密）：Cookie 中的 Token 由服务端附加，
 * 浏览器不接触 Token；成功后后端清除 must_change_password 并返回最新用户信息。
 */
export async function POST(request: Request) {
  const cookieStore = await cookies();
  const token = cookieStore.get(AUTH_COOKIE)?.value;
  if (!token) {
    return Response.json({ detail: "未登录" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ detail: "请求格式有误" }, { status: 400 });
  }

  const payload = (body ?? {}) as {
    current_password?: unknown;
    new_password?: unknown;
  };
  if (
    typeof payload.current_password !== "string" ||
    typeof payload.new_password !== "string"
  ) {
    return Response.json({ detail: "请求格式有误" }, { status: 400 });
  }

  let res: Response;
  try {
    res = await fetch(`${backendUrl()}/api/v1/auth/change-password`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        current_password: payload.current_password,
        new_password: payload.new_password,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch {
    return Response.json({ detail: "服务暂时不可用，请稍后重试" }, { status: 502 });
  }

  if (res.ok) {
    const user = (await res.json()) as MeOut;
    return Response.json(user);
  }

  if (res.status === 401) {
    cookieStore.delete(AUTH_COOKIE);
    return Response.json({ detail: "登录已失效，请重新登录" }, { status: 401 });
  }

  const detail = await readDetail(res);
  return Response.json(
    { detail: detail ?? "修改密码失败，请稍后重试" },
    { status: res.status },
  );
}

async function readDetail(res: Response): Promise<string | null> {
  try {
    const text = await res.text();
    if (!text) return null;
    const parsed = JSON.parse(text) as { detail?: unknown };
    if (typeof parsed.detail === "string") return parsed.detail;
    // FastAPI 422：detail 为数组
    if (Array.isArray(parsed.detail) && parsed.detail.length > 0) {
      return "新密码不符合要求（至少 8 位）";
    }
    return null;
  } catch {
    return null;
  }
}
