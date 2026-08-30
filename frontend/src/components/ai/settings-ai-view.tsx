"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "@/lib/api";
import type { AISettings } from "@/lib/api/ai";
import { aiErrorMessage } from "@/lib/ai";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Forbidden, Loading } from "@/components/status-views";

/**
 * /settings/ai 视图（Sprint 9 §40）：
 * - DeepSeek 状态：configured / key_masked（sk-****abcd）/ model
 * - [Update API Key]（type=password，保存后清空输入框）
 * - [Test Connection]（可携带新 Key 只测不存）
 * - [Remove Key]（确认后删除）
 * - 前端永不显示/存储完整 Key（§5）
 */
export default function SettingsAiView() {
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [settings, setSettings] = useState<AISettings | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [notice, setNotice] = useState<{
    kind: "ok" | "err";
    text: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.ai
      .getSettings()
      .then((data) => {
        if (cancelled) return;
        setSettings(data);
        setModel(data.model ?? "");
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.kind === "forbidden") {
          setForbidden(true);
        } else {
          setNotice({
            kind: "err",
            text: err instanceof ApiError ? err.message : "加载失败，请稍后重试",
          });
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    setNotice(null);
    try {
      const payload: { api_key?: string; model?: string } = {};
      if (apiKey.trim()) payload.api_key = apiKey.trim();
      if (model.trim()) payload.model = model.trim();
      if (Object.keys(payload).length === 0) {
        setNotice({ kind: "err", text: "没有需要保存的变更" });
        return;
      }
      const data = await api.ai.saveSettings(payload);
      setSettings(data);
      setModel(data.model ?? "");
      setApiKey(""); // 保存后清空输入框（§40）
      setNotice({
        kind: "ok",
        text: apiKey.trim() ? "API Key 已安全保存（仅保存在服务端）" : "配置已保存",
      });
    } catch (err) {
      setNotice({
        kind: "err",
        text: err instanceof ApiError ? aiErrorMessage(err.message) : "保存失败",
      });
    } finally {
      setSaving(false);
    }
  }, [saving, apiKey, model]);

  const testConnection = useCallback(async () => {
    if (testing) return;
    setTesting(true);
    setNotice(null);
    try {
      const result = await api.ai.testConnection({
        api_key: apiKey.trim() || undefined,
      });
      setNotice({
        kind: "ok",
        text: `连接成功（${result.model ?? "DeepSeek"}，延迟 ${result.latency_ms ?? "?"}ms）`,
      });
    } catch (err) {
      setNotice({
        kind: "err",
        text:
          err instanceof ApiError
            ? aiErrorMessage(err.message)
            : "连接测试失败",
      });
    } finally {
      setTesting(false);
    }
  }, [testing, apiKey]);

  const removeKey = useCallback(async () => {
    if (removing) return;
    setRemoving(true);
    setNotice(null);
    try {
      const data = await api.ai.deleteKey();
      setSettings(data);
      setApiKey("");
      setNotice({ kind: "ok", text: "API Key 已删除" });
    } catch (err) {
      setNotice({
        kind: "err",
        text: err instanceof ApiError ? err.message : "删除失败",
      });
    } finally {
      setRemoving(false);
      setConfirmOpen(false);
    }
  }, [removing]);

  if (loading) return <Loading text="加载 AI 设置…" />;
  if (forbidden) return <Forbidden />;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-gray-900">AI 设置</h1>
        <p className="mt-1 text-sm text-gray-500">
          配置 DeepSeek API Key 与模型。API Key 仅保存在服务端
          （加密存储），前端任何时候都无法读取完整 Key。
        </p>
      </div>

      {/* 当前状态 */}
      <section
        className="rounded-lg border border-gray-200 bg-white p-5"
        data-testid="ai-settings-status"
      >
        <h2 className="text-sm font-semibold text-gray-900">DeepSeek 状态</h2>
        <dl className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <dt className="text-xs text-gray-500">Provider</dt>
            <dd className="mt-0.5 text-sm font-medium text-gray-900">
              {settings?.provider ?? "deepseek"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">API Key</dt>
            <dd className="mt-0.5 text-sm font-medium text-gray-900">
              {settings?.configured ? (
                <span className="inline-flex items-center gap-1.5 text-emerald-700">
                  <span
                    className="size-2 rounded-full bg-emerald-500"
                    aria-hidden="true"
                  />
                  已配置 · {settings.key_masked}
                </span>
              ) : (
                <span className="text-gray-400">未配置</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">Model</dt>
            <dd className="mt-0.5 text-sm font-medium text-gray-900">
              {settings?.model ?? "deepseek-chat（默认）"}
            </dd>
          </div>
        </dl>
      </section>

      {/* 配置表单 */}
      <section className="rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-gray-900">更新配置</h2>
        <div className="mt-4 space-y-4">
          <div>
            <label
              htmlFor="ai-api-key"
              className="block text-xs font-medium text-gray-600"
            >
              DeepSeek API Key
            </label>
            <input
              id="ai-api-key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={settings?.configured ? "输入新 Key 以替换（不显示当前 Key）" : "sk-…"}
              autoComplete="off"
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-gray-900 focus:outline-none"
            />
            <p className="mt-1 text-xs text-gray-400">
              保存后输入框自动清空；页面不会显示完整 Key。
            </p>
          </div>
          <div>
            <label
              htmlFor="ai-model"
              className="block text-xs font-medium text-gray-600"
            >
              Model
            </label>
            <input
              id="ai-model"
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="deepseek-chat"
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-gray-900 focus:outline-none"
            />
          </div>
          <div className="flex flex-wrap gap-2.5">
            <button
              type="button"
              onClick={save}
              disabled={saving || (!apiKey.trim() && !model.trim())}
              className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-40"
            >
              {saving ? "保存中…" : "保存"}
            </button>
            <button
              type="button"
              onClick={testConnection}
              disabled={testing}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40"
            >
              {testing ? "测试中…" : "Test Connection"}
            </button>
            {settings?.configured ? (
              <button
                type="button"
                onClick={() => setConfirmOpen(true)}
                disabled={removing}
                className="rounded-md border border-red-200 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-40"
              >
                {removing ? "删除中…" : "Remove Key"}
              </button>
            ) : null}
          </div>
        </div>
      </section>

      {notice ? (
        <div
          role="status"
          data-testid="ai-settings-notice"
          className={`rounded-md border px-3.5 py-2.5 text-sm ${
            notice.kind === "ok"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-red-200 bg-red-50 text-red-700"
          }`}
        >
          {notice.text}
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmOpen}
        title="删除 API Key"
        message="删除后 AI 店长将不可用，直到重新配置。确定删除吗？"
        confirmLabel="删除"
        busy={removing}
        onConfirm={removeKey}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
