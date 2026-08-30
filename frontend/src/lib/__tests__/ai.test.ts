/**
 * AI Manager 前端 lib 测试（Sprint 9）：
 * - AI_* 错误码 -> 中文文案（§7/§42 Flow D）
 * - 快捷问题（§9）
 * - conversation_id 会话持久化（sessionStorage，非密钥）
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AI_ERROR_MESSAGES,
  QUICK_PROMPTS,
  aiErrorMessage,
  clearConversationId,
  loadConversationId,
  saveConversationId,
} from "@/lib/ai";

describe("aiErrorMessage", () => {
  it("maps AI_* codes to readable Chinese messages", () => {
    expect(aiErrorMessage("AI_NOT_CONFIGURED: 尚未配置 DeepSeek API")).toBe(
      "尚未配置 DeepSeek API",
    );
    expect(aiErrorMessage("AI_TIMEOUT: x")).toBe("DeepSeek 请求超时，请重试");
    expect(aiErrorMessage("AI_AUTH_FAILED: x")).toContain("API Key 无效");
    expect(aiErrorMessage("AI_RATE_LIMITED: x")).toContain("频率超限");
    expect(aiErrorMessage("AI_PROVIDER_UNAVAILABLE: x")).toContain("暂时不可用");
    expect(aiErrorMessage("AI_RESPONSE_INVALID: x")).toContain("无法解析");
    expect(aiErrorMessage("AI_TOOL_ROUNDS_EXCEEDED: x")).toContain("已安全终止");
  });

  it("falls back to original message for unknown errors", () => {
    expect(aiErrorMessage("数据库拒绝执行：x")).toBe("数据库拒绝执行：x");
  });

  it("covers exactly the documented codes", () => {
    expect(Object.keys(AI_ERROR_MESSAGES).sort()).toEqual(
      [
        "AI_NOT_CONFIGURED",
        "AI_AUTH_FAILED",
        "AI_RATE_LIMITED",
        "AI_PROVIDER_UNAVAILABLE",
        "AI_TIMEOUT",
        "AI_RESPONSE_INVALID",
        "AI_TOOL_ROUNDS_EXCEEDED",
      ].sort(),
    );
  });
});

describe("QUICK_PROMPTS", () => {
  it("provides the six documented quick prompts", () => {
    expect(QUICK_PROMPTS).toHaveLength(6);
    expect(QUICK_PROMPTS[0]).toContain("总结最近30天经营情况");
    expect(QUICK_PROMPTS.some((p) => p.includes("未来7天需要关注"))).toBe(true);
    expect(QUICK_PROMPTS.some((p) => p.includes("维修最多"))).toBe(true);
    expect(QUICK_PROMPTS.some((p) => p.includes("换房次数增加"))).toBe(true);
    expect(QUICK_PROMPTS.some((p) => p.includes("库存风险"))).toBe(true);
    expect(QUICK_PROMPTS.some((p) => p.includes("采购情况"))).toBe(true);
  });
});

describe("conversation id persistence", () => {
  beforeEach(() => clearConversationId());
  afterEach(() => clearConversationId());

  it("saves and loads conversation id from sessionStorage", () => {
    expect(loadConversationId()).toBeNull();
    saveConversationId(42);
    expect(loadConversationId()).toBe(42);
  });

  it("clears conversation id", () => {
    saveConversationId(42);
    clearConversationId();
    expect(loadConversationId()).toBeNull();
  });

  it("ignores invalid stored values", () => {
    window.sessionStorage.setItem("stayops_ai_conversation_id", "abc");
    expect(loadConversationId()).toBeNull();
    window.sessionStorage.setItem("stayops_ai_conversation_id", "-1");
    expect(loadConversationId()).toBeNull();
  });
});
