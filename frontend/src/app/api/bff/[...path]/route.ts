import { cookies } from "next/headers";
import { backendUrl, bffTimeoutFor } from "@/lib/api/client";
import { AUTH_COOKIE } from "@/lib/server/auth";

interface BffContext {
  params: Promise<{ path: string[] }>;
}

/**
 * 通用 BFF 代理：/api/bff/[...path] → {BACKEND_API_URL}/api/v1/[...path]
 * 服务端读取 HttpOnly Cookie 并附加 Authorization: Bearer 转发，
 * 浏览器端不接触 Token；透传状态码与响应体（FastAPI {"detail": ...}）。
 */

async function handle(request: Request, ctx: BffContext): Promise<Response> {
  const { path } = await ctx.params;

  if (path.length === 0) {
    return Response.json({ detail: "无效的代理路径" }, { status: 400 });
  }

  // 防路径穿越：只允许普通路径段（Next 已做 URI 解码）
  const segments = path.filter((s) => s && !s.includes(".."));
  const base = backendUrl();
  const url = new URL(`${base}/api/v1/${segments.join("/")}`);
  url.search = new URL(request.url).search;

  const cookieStore = await cookies();
  const token = cookieStore.get(AUTH_COOKIE)?.value;

  const headers = new Headers();
  headers.set("Accept", "application/json");
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  // 透传客户端 IP，供后端审计使用
  const xff = request.headers.get("x-forwarded-for");
  if (xff) headers.set("X-Forwarded-For", xff.split(",")[0]!.trim());
  else {
    const realIp = request.headers.get("x-real-ip");
    if (realIp) headers.set("X-Real-IP", realIp);
  }

  let body: string | null = null;
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    body = await request.text();
    if (body) {
      headers.set("Content-Type", "application/json");
    }
  }

  let upstream: Response;
  try {
    // Desktop D1 compatibility fix：仅 POST /ai-manager/chat 使用 AI 长超时
    // （真实 DeepSeek 工具调用实测 15.7s > 通用 15s）；其余请求保持 15s。
    const timeoutMs = bffTimeoutFor(segments, method);
    upstream = await fetch(url.toString(), {
      method,
      headers,
      body: body ?? undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return Response.json(
      { detail: "服务暂时不可用，请稍后重试" },
      { status: 502 },
    );
  }

  const upstreamText = await upstream.text();
  const responseHeaders = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType) responseHeaders.set("Content-Type", contentType);
  responseHeaders.set("X-Content-Type-Options", "nosniff");

  return new Response(upstreamText || null, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

export async function GET(request: Request, ctx: BffContext) {
  return handle(request, ctx);
}

export async function POST(request: Request, ctx: BffContext) {
  return handle(request, ctx);
}

export async function PUT(request: Request, ctx: BffContext) {
  return handle(request, ctx);
}

export async function PATCH(request: Request, ctx: BffContext) {
  return handle(request, ctx);
}

export async function DELETE(request: Request, ctx: BffContext) {
  return handle(request, ctx);
}
