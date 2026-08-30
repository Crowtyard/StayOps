"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ApiError, api } from "@/lib/api";
import {
  QUICK_PROMPTS,
  aiErrorMessage,
  clearConversationId,
  loadConversationId,
  saveConversationId,
  type ChatMessage,
} from "@/lib/ai";
import { useUser } from "@/components/app-shell";
import { IconAI, IconRefresh, IconSend, IconX } from "@/components/icons";
import Markdown from "@/components/ai/markdown";

/**
 * /ai-manager 视图（Sprint 9 §8/§28/§38/§42）：
 * - 顶部：AI 店长 + 只读分析说明
 * - 主体：Chat（消息列表 / 输入 / 发送 / loading / error / retry / 新对话）
 * - 快捷问题（§9）；未配置 DeepSeek API 时友好提示（§28）
 * - Markdown 经安全渲染器（禁止 dangerouslySetInnerHTML，§38）
 */
export default function AiManagerView() {
  const user = useUser();
  const canManage =
    (user?.permissions.includes("ai_manager:manage") ?? false) || false;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);
  const [conversationId, setConversationId] = useState<number | null>(() =>
    loadConversationId(),
  );
  // 初始无会话时无需恢复历史（避免 effect 内同步 setState）
  const [historyLoaded, setHistoryLoaded] = useState<boolean>(
    () => loadConversationId() === null,
  );
  const bottomRef = useRef<HTMLDivElement>(null);

  // 页面刷新后恢复会话（§21：历史消息只读接口）
  useEffect(() => {
    if (conversationId === null) {
      return;
    }
    let cancelled = false;
    api.ai
      .messages(conversationId)
      .then((res) => {
        if (cancelled) return;
        setMessages(
          res.items.map((m) => ({
            id: String(m.id),
            role: m.role,
            content: m.content,
          })),
        );
      })
      .catch((err) => {
        // 历史不可恢复：仅当会话明确不存在（404）时从新对话开始
        if (cancelled) return;
        if (err instanceof ApiError && err.kind === "not_found") {
          clearConversationId();
          setConversationId(null);
        }
      })
      .finally(() => {
        if (!cancelled) setHistoryLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ behavior: "smooth", block: "end" });
  }, [messages, sending]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || sending) return;
      setInput("");
      setError(null);
      setNotConfigured(false);
      setMessages((prev) => [
        ...prev,
        { id: `u-${Date.now()}`, role: "user", content: trimmed },
      ]);
      setSending(true);
      try {
        const res = await api.ai.chat({
          conversation_id: conversationId ?? undefined,
          message: trimmed,
        });
        saveConversationId(res.conversation_id);
        setConversationId(res.conversation_id);
        setMessages((prev) => [
          ...prev,
          {
            id: `a-${Date.now()}`,
            role: "assistant",
            content: res.answer,
          },
        ]);
      } catch (err) {
        const detail =
          err instanceof ApiError ? err.message : "请求失败，请稍后重试";
        if (detail.includes("AI_NOT_CONFIGURED")) {
          setNotConfigured(true);
        }
        setError(aiErrorMessage(detail));
      } finally {
        setSending(false);
      }
    },
    [sending, conversationId],
  );

  const retry = useCallback(() => {
    const last = [...messages].reverse().find((m) => m.role === "user");
    if (last) void send(last.content);
  }, [messages, send]);

  const newConversation = useCallback(() => {
    setMessages([]);
    setConversationId(null);
    clearConversationId();
    setError(null);
    setNotConfigured(false);
  }, []);

  return (
    <div className="mx-auto flex h-[calc(100vh-7rem)] max-w-3xl flex-col">
      {/* 顶部 */}
      <div className="border-b border-gray-200 pb-3">
        <div className="flex items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-md bg-gray-900 text-white">
            <IconAI className="size-4.5" />
          </span>
          <h1 className="text-lg font-semibold text-gray-900">AI 店长</h1>
          {conversationId !== null ? (
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">
              会话 #{conversationId}
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-xs text-gray-500">
          基于 StayOps 当前经营与运营数据进行分析。AI
          仅提供分析和建议，不会自动修改业务数据。
        </p>
      </div>

      {/* 消息列表 */}
      <div
        className="flex-1 space-y-4 overflow-y-auto py-4"
        aria-live="polite"
        data-testid="ai-message-list"
      >
        {historyLoaded && messages.length === 0 && !sending ? (
          <div className="py-10 text-center text-sm text-gray-400">
            <p className="mb-2">你好，我是 StayOps AI 店长。</p>
            <p>可以问我经营情况、房间、维修、保洁、库存或采购问题。</p>
          </div>
        ) : null}
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[85%] rounded-lg px-3.5 py-2.5 ${
                msg.role === "user"
                  ? "bg-gray-900 text-white"
                  : "border border-gray-200 bg-white text-gray-800"
              }`}
            >
              {msg.role === "user" ? (
                <p className="whitespace-pre-wrap break-words text-sm">
                  {msg.content}
                </p>
              ) : (
                <Markdown content={msg.content} />
              )}
            </div>
          </div>
        ))}
        {sending ? (
          <div className="flex justify-start">
            <div
              className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3.5 py-2.5 text-sm text-gray-500"
              role="status"
            >
              <span
                className="size-4 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600"
                aria-hidden="true"
              />
              正在分析…
            </div>
          </div>
        ) : null}
        <div ref={bottomRef} />
      </div>

      {/* 错误 */}
      {error ? (
        <div
          className="mb-2 flex items-start justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700"
          role="alert"
        >
          <span>{error}</span>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={retry}
              className="inline-flex items-center gap-1 rounded-md border border-red-300 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-100"
            >
              <IconRefresh className="size-3.5" />
              重试
            </button>
            <button
              type="button"
              aria-label="关闭错误提示"
              onClick={() => setError(null)}
              className="rounded p-1 text-red-500 hover:bg-red-100"
            >
              <IconX className="size-3.5" />
            </button>
          </div>
        </div>
      ) : null}

      {/* 未配置 */}
      {notConfigured ? (
        <div
          className="mb-2 rounded-md border border-amber-200 bg-amber-50 px-3.5 py-3 text-sm text-amber-800"
          data-testid="ai-not-configured"
        >
          <p className="font-medium">尚未配置 DeepSeek API</p>
          <p className="mt-1 text-xs text-amber-700">
            配置后即可向 AI 店长提问经营与运营问题。
          </p>
          {canManage ? (
            <Link
              href="/settings/ai"
              className="mt-2 inline-block rounded-md border border-amber-300 px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100"
            >
              前往 AI 设置
            </Link>
          ) : null}
        </div>
      ) : null}

      {/* 快捷问题（§9） */}
      {messages.length === 0 ? (
        <div className="mb-2 flex flex-wrap gap-2">
          {QUICK_PROMPTS.map((prompt) => (
            <button
              key={prompt}
              type="button"
              onClick={() => void send(prompt)}
              disabled={sending}
              className="rounded-full border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {prompt}
            </button>
          ))}
        </div>
      ) : null}

      {/* 输入区 */}
      <div className="border-t border-gray-200 pt-3">
        <div className="flex items-end gap-2">
          <button
            type="button"
            onClick={newConversation}
            disabled={sending}
            className="shrink-0 rounded-md border border-gray-300 px-3 py-2.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            title="开始新对话"
          >
            新对话
          </button>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(input);
              }
            }}
            placeholder="询问经营情况、房间、维修、保洁、库存或采购…"
            disabled={sending || notConfigured}
            className="min-w-0 flex-1 rounded-md border border-gray-300 px-3 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-gray-900 focus:outline-none disabled:opacity-50"
            aria-label="消息输入"
          />
          <button
            type="button"
            onClick={() => void send(input)}
            disabled={sending || notConfigured || !input.trim()}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-gray-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-40"
            aria-label="发送消息"
          >
            <IconSend className="size-4" />
            {sending ? "发送中…" : "发送"}
          </button>
        </div>
      </div>
    </div>
  );
}
