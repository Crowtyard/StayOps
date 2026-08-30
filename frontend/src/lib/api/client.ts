/**
 * 统一 API Client 核心：
 * - 错误归一化（401/403/404/409/422/5xx/network → ApiError）
 * - 超时、JSON 编解码、查询串构建
 * - 浏览器端经 BFF（/api/bff/*，Cookie 随同源请求自动携带，浏览器不接触 Token）
 * - 服务端直连 BACKEND_API_URL（/api/v1/*，显式附加 Bearer）
 */

export type ApiErrorKind =
  | "unauthorized" // 401 登录失效
  | "forbidden" // 403 无权限
  | "not_found" // 404 资源不存在
  | "conflict" // 409 唯一键冲突 / 非法状态转换
  | "validation" // 422 参数校验失败
  | "server" // 500 / 502 等服务器或上游错误
  | "network" // 网络不可达 / 超时
  | "unknown";

const KIND_BY_STATUS: Record<number, ApiErrorKind> = {
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  422: "validation",
  // BFF 上游不可达（网关类错误）视为 network：“服务暂时不可用”
  502: "network",
  503: "network",
};

const DEFAULT_MESSAGES: Record<ApiErrorKind, string> = {
  unauthorized: "登录已失效，请重新登录",
  forbidden: "无权限执行该操作",
  not_found: "请求的资源不存在",
  conflict: "操作与当前状态冲突",
  validation: "请求参数有误",
  server: "服务器内部错误，请稍后重试",
  network: "服务暂时不可用，请稍后重试",
  unknown: "请求失败，请稍后重试",
};

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;

  constructor(kind: ApiErrorKind, status: number | null, message: string) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
  }
}

/** 解析 FastAPI 错误体 {"detail": string} 或 {"detail": [{loc,msg,...}]} */
function messageFromDetail(detail: unknown): string | null {
  if (typeof detail === "string" && detail.trim() !== "") {
    return detail;
  }
  if (Array.isArray(detail)) {
    const parts = detail
      .map((item) => {
        const msg =
          typeof item?.msg === "string" ? item.msg : JSON.stringify(item);
        const loc = Array.isArray(item?.loc)
          ? item.loc.filter((p: unknown) => p !== "body").join(".")
          : null;
        return loc ? `${loc}: ${msg}` : msg;
      })
      .filter(Boolean);
    if (parts.length > 0) {
      return parts.join("；");
    }
  }
  return null;
}

/** 从响应状态与已解析的 JSON 数据构造 ApiError（实现见下方） */

export type Transport = (path: string, init: RequestInit) => Promise<Response>;

export const DEFAULT_TIMEOUT_MS = 15000;

/**
 * AI Manager Chat 独立超时（Desktop D1 compatibility fix）。
 *
 * 背景：真实 DeepSeek 多轮工具调用（如「近七天的运营情况怎么样」）实测
 * 后端总耗时 15.7s，超过通用 BFF 的 DEFAULT_TIMEOUT_MS=15s，导致 BFF 在
 * 后端即将完成时中止（502「服务暂时不可用」）。后端 S9 provider 超时为
 * 60s（deepseek_request_timeout_seconds），本值 = 60s + 50% 余量（90s），
 * 有界、不全局放宽、不改 DeepSeek/Analytics。
 */
export const AI_CHAT_TIMEOUT_MS = 90_000;

/** BFF 层超时判定：仅 POST /ai-manager/chat 使用 AI 长请求超时。 */
export function bffTimeoutFor(
  pathSegments: readonly string[],
  method: string,
): number {
  if (
    method === "POST" &&
    pathSegments[0] === "ai-manager" &&
    pathSegments[1] === "chat"
  ) {
    return AI_CHAT_TIMEOUT_MS;
  }
  return DEFAULT_TIMEOUT_MS;
}

export interface RequestOptions {
  method?: string;
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /** 覆盖默认超时（毫秒）；仅对需要长请求的端点显式使用 */
  timeoutMs?: number;
}

export function buildQueryString(
  query?: Record<string, string | number | boolean | null | undefined>,
): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.append(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

async function requestJson<T>(
  transport: Transport,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...options.headers,
  };

  let body: BodyInit | undefined;
  if (options.body !== undefined && options.body !== null) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  const timeoutController = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);
  const externalSignal = options.signal;
  const onExternalAbort = () => timeoutController.abort();
  if (externalSignal) {
    if (externalSignal.aborted) timeoutController.abort();
    else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  let res: Response;
  try {
    res = await transport(`${path}${buildQueryString(options.query)}`, {
      method,
      headers,
      body,
      signal: timeoutController.signal,
      cache: "no-store",
    });
  } catch {
    // AbortSignal.timeout / fetch 网络失败
    const aborted =
      timeoutController.signal.aborted &&
      !(externalSignal ? externalSignal.aborted : false);
    throw new ApiError(
      "network",
      null,
      aborted ? "请求超时，请稍后重试" : DEFAULT_MESSAGES.network,
    );
  } finally {
    clearTimeout(timeoutId);
    if (externalSignal) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }

  if (res.status === 204) {
    return undefined as T;
  }

  let data: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    throw await errorFromResponseWithData(res.status, data);
  }

  return data as T;
}

async function errorFromResponseWithData(
  status: number,
  data: unknown,
): Promise<ApiError> {
  let detail: unknown = null;
  if (data && typeof data === "object" && "detail" in data) {
    detail = (data as { detail: unknown }).detail;
  }
  const kind =
    KIND_BY_STATUS[status] ?? (status >= 500 ? "server" : "unknown");
  const message =
    messageFromDetail(detail) ?? DEFAULT_MESSAGES[kind] ?? DEFAULT_MESSAGES.unknown;
  return new ApiError(kind, status, message);
}

/* ------------------------------------------------------------------ */
/* 浏览器端 Transport：经同源 BFF 转发（Cookie 自动携带）                */
/* ------------------------------------------------------------------ */

export function browserTransport(path: string, init: RequestInit): Promise<Response> {
  return fetch(`/api/bff${path}`, init);
}

/* ------------------------------------------------------------------ */
/* 服务端 Transport：直连后端，附加 Bearer（仅在 Node 服务端使用）        */
/* ------------------------------------------------------------------ */

export function backendUrl(): string {
  const url = process.env.BACKEND_API_URL;
  if (!url) {
    throw new Error(
      "缺少环境变量 BACKEND_API_URL（服务端内部地址，见 frontend/.env.example）",
    );
  }
  return url.replace(/\/+$/, "");
}

export function serverTransport(token: string | null) {
  const base = backendUrl();
  return (path: string, init: RequestInit): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }
    return fetch(`${base}/api/v1${path}`, { ...init, headers });
  };
}

export { requestJson };
