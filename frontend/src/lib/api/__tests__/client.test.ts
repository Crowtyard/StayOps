/**
 * API Client 错误归一化测试：
 * 覆盖 401/403/404/409/422/5xx/502/503/网络失败/超时与查询串构建，
 * 验证统一 ApiError（kind + 可读消息）与 FastAPI detail 解析。
 */

import { describe, expect, it, vi } from "vitest";
import {
  ApiError,
  buildQueryString,
  requestJson,
  type Transport,
} from "@/lib/api/client";

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function transportWith(body: unknown, status = 200): Transport {
  return vi.fn(async () => jsonResponse(body, status));
}

describe("buildQueryString", () => {
  it("跳过 undefined/null/空字符串并编码其余参数", () => {
    expect(
      buildQueryString({
        page: 1,
        page_size: 20,
        action: undefined,
        user_id: null,
        q: "",
        name: "标准大床房",
      }),
    ).toBe("?page=1&page_size=20&name=%E6%A0%87%E5%87%86%E5%A4%A7%E5%BA%8A%E6%88%BF");
  });

  it("无参数时返回空字符串", () => {
    expect(buildQueryString(undefined)).toBe("");
    expect(buildQueryString({})).toBe("");
  });
});

describe("requestJson 成功路径", () => {
  it("解析 JSON 响应并透传方法/请求体", async () => {
    const transport = transportWith({ items: [1, 2], total: 2 });
    const data = await requestJson<{ items: number[] }>(transport, "/rooms", {
      method: "POST",
      body: { room_number: "101" },
    });
    expect(data.items).toEqual([1, 2]);
    expect(transport).toHaveBeenCalledTimes(1);
    const [path, init] = vi.mocked(transport).mock.calls[0];
    expect(path).toBe("/rooms");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ room_number: "101" });
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
  });

  it("204 无内容返回 undefined", async () => {
    const transport = vi.fn(async () => new Response(null, { status: 204 }));
    const data = await requestJson(transport, "/users/1", { method: "DELETE" });
    expect(data).toBeUndefined();
  });
});

describe("requestJson 错误归一化", () => {
  it("401 → unauthorized（默认文案）", async () => {
    const err = await requestJson(
      transportWith({ detail: "未认证：缺少 Bearer Token" }, 401),
      "/users",
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe("unauthorized");
    expect((err as ApiError).status).toBe(401);
    expect((err as ApiError).message).toBe("未认证：缺少 Bearer Token");
  });

  it("403 → forbidden（显示后端 detail，不误判为登录失效）", async () => {
    const err = await requestJson(
      transportWith({ detail: "无权限执行该操作" }, 403),
      "/roles",
    ).catch((e: unknown) => e);
    expect((err as ApiError).kind).toBe("forbidden");
    expect((err as ApiError).status).toBe(403);
  });

  it("404 → not_found", async () => {
    const err = await requestJson(
      transportWith({ detail: "用户不存在" }, 404),
      "/users/999",
    ).catch((e: unknown) => e);
    expect((err as ApiError).kind).toBe("not_found");
  });

  it("409 → conflict（透传后端状态机/唯一键错误文案）", async () => {
    const err = await requestJson(
      transportWith({ detail: "非法占用状态转换: occupied -> blocked" }, 409),
      "/rooms/1/status",
      { method: "POST", body: { occupancy_status: "blocked" } },
    ).catch((e: unknown) => e);
    expect((err as ApiError).kind).toBe("conflict");
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).message).toBe(
      "非法占用状态转换: occupied -> blocked",
    );
  });

  it("422 → validation（数组 detail 归一化为可读消息，含字段定位）", async () => {
    const err = await requestJson(
      transportWith(
        {
          detail: [
            { loc: ["body", "username"], msg: "字段必填", type: "missing" },
            { loc: ["body", "password"], msg: "长度不足", type: "too_short" },
          ],
        },
        422,
      ),
      "/users",
      { method: "POST" },
    ).catch((e: unknown) => e);
    expect((err as ApiError).kind).toBe("validation");
    expect((err as ApiError).message).toContain("username: 字段必填");
    expect((err as ApiError).message).toContain("password: 长度不足");
  });

  it("500 → server", async () => {
    const err = await requestJson(
      transportWith({ detail: "Internal Server Error" }, 500),
      "/rooms",
    ).catch((e: unknown) => e);
    expect((err as ApiError).kind).toBe("server");
  });

  it("502/503（BFF 上游不可达）→ network（服务暂时不可用）", async () => {
    for (const status of [502, 503]) {
      const err = await requestJson(
        transportWith({ detail: "服务暂时不可用，请稍后重试" }, status),
        "/rooms",
      ).catch((e: unknown) => e);
      expect((err as ApiError).kind).toBe("network");
      expect((err as ApiError).message).toBe("服务暂时不可用，请稍后重试");
    }
  });

  it("网络失败（fetch 抛错）→ network", async () => {
    const transport = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const err = await requestJson(transport, "/rooms").catch(
      (e: unknown) => e,
    );
    expect((err as ApiError).kind).toBe("network");
    expect((err as ApiError).status).toBeNull();
    expect((err as ApiError).message).toBe("服务暂时不可用，请稍后重试");
  });

  it("外部 AbortSignal 触发 → network（不误报为超时文案）", async () => {
    const controller = new AbortController();
    const transport = vi.fn(async (_p: string, init: RequestInit) => {
      // 模拟 fetch 在信号中止时抛 AbortError
      await new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("The user aborted a request.", "AbortError")),
        );
      });
      return new Response("{}");
    });
    const promise = requestJson(transport, "/rooms", {
      signal: controller.signal,
    });
    controller.abort();
    const err = await promise.catch((e: unknown) => e);
    expect((err as ApiError).kind).toBe("network");
  });
});
