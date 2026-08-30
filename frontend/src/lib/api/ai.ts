/**
 * AI Manager API 客户端（Sprint 9）。
 *
 * 安全约定：
 * - 浏览器绝不保存/接触 API Key（只在 /settings/ai 表单输入，经 BFF 转后端）
 * - GET /settings/ai 只返回 configured / key_masked（sk-****abcd）
 * - Chat 为普通 request/response（Alpha.9 不做 Streaming，§25）
 */

import { requestJson, type Transport } from "./client";

export interface AISettings {
  provider: string;
  configured: boolean;
  key_masked: string | null;
  model: string | null;
}

export interface AISettingsUpdate {
  api_key?: string;
  model?: string;
}

export interface AITestResult {
  ok: boolean;
  model: string | null;
  latency_ms: number | null;
  usage?: Record<string, number> | null;
}

export interface AIChatResult {
  conversation_id: number;
  answer: string;
  model: string | null;
  usage?: Record<string, number> | null;
}

export interface AIMessageItem {
  id: number;
  role: "user" | "assistant";
  content: string;
  model: string | null;
  created_at: string;
}

export interface AIMessagesResult {
  items: AIMessageItem[];
}

export interface AiApi {
  getSettings(): Promise<AISettings>;
  saveSettings(payload: AISettingsUpdate): Promise<AISettings>;
  deleteKey(): Promise<AISettings>;
  testConnection(payload?: { api_key?: string }): Promise<AITestResult>;
  chat(payload: {
    conversation_id?: number;
    message: string;
  }): Promise<AIChatResult>;
  messages(conversationId: number): Promise<AIMessagesResult>;
}

export function createAiApi(transport: Transport): AiApi {
  return {
    getSettings: () =>
      requestJson<AISettings>(transport, "/settings/ai"),
    saveSettings: (payload) =>
      requestJson<AISettings>(transport, "/settings/ai", {
        method: "PUT",
        body: payload,
      }),
    deleteKey: () =>
      requestJson<AISettings>(transport, "/settings/ai/key", { method: "DELETE" }),
    testConnection: (payload) =>
      requestJson<AITestResult>(transport, "/settings/ai/test", {
        method: "POST",
        body: payload ?? {},
      }),
    chat: (payload) =>
      requestJson<AIChatResult>(transport, "/ai-manager/chat", {
        method: "POST",
        body: payload,
      }),
    messages: (conversationId) =>
      requestJson<AIMessagesResult>(
        transport,
        `/ai-manager/conversations/${conversationId}/messages`,
      ),
  };
}
