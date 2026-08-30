/**
 * AI Manager 前端展示层（Sprint 9）。
 *
 * - AI_* 业务错误码 -> 可读中文文案（§7/§28/§42 Flow D）
 * - 快捷问题（§9）
 * - 会话持久化辅助（conversation_id 仅存 sessionStorage，不是密钥）
 */

export const AI_ERROR_MESSAGES: Record<string, string> = {
  AI_NOT_CONFIGURED: "尚未配置 DeepSeek API",
  AI_AUTH_FAILED: "DeepSeek API Key 无效或没有访问权限",
  AI_RATE_LIMITED: "DeepSeek 请求频率超限，请稍后重试",
  AI_PROVIDER_UNAVAILABLE: "DeepSeek 服务暂时不可用，请稍后重试",
  AI_TIMEOUT: "DeepSeek 请求超时，请重试",
  AI_RESPONSE_INVALID: "DeepSeek 返回了无法解析的响应",
  AI_TOOL_ROUNDS_EXCEEDED: "分析工具调用次数超限，已安全终止本次回答",
};

/** 从后端 detail（形如 "AI_TIMEOUT: xxx"）提取用户可读文案 */
export function aiErrorMessage(detail: string): string {
  const code = detail.split(":")[0]?.trim() ?? "";
  return AI_ERROR_MESSAGES[code] ?? detail;
}

/** 快捷问题（§9）：点击后作为正常用户问题发送 */
export const QUICK_PROMPTS: readonly string[] = [
  "总结最近30天经营情况",
  "未来7天需要关注什么？",
  "哪些房间最近维修最多？",
  "为什么最近换房次数增加？",
  "现在有哪些库存风险？",
  "最近采购情况怎么样？",
];

const CONVERSATION_KEY = "stayops_ai_conversation_id";

export function loadConversationId(): number | null {
  if (typeof window === "undefined") return null;
  const raw = window.sessionStorage.getItem(CONVERSATION_KEY);
  const value = raw ? Number(raw) : NaN;
  return Number.isInteger(value) && value > 0 ? value : null;
}

export function saveConversationId(id: number): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(CONVERSATION_KEY, String(id));
}

export function clearConversationId(): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(CONVERSATION_KEY);
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}
