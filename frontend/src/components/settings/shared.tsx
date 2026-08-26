"use client";

/**
 * /settings/* 页面共享工具：
 * - usePageFetch：分页列表加载（Loading/Empty/Error/401→登录/403→无权限 语义统一）
 * - listErrorView：错误渲染（403 无权限、离线“服务暂时不可用”、其余可重试）
 * - SettingsHeader / Field / ActionMessage：统一页面头部、表单字段与操作反馈
 */

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ApiError } from "@/lib/api";
import type { Page } from "@/lib/api/types";
import { ErrorView, Forbidden } from "@/components/status-views";

export function usePageFetch<T>(
  load: () => Promise<Page<T>>,
  deps: readonly unknown[],
): {
  items: T[] | null;
  total: number | null;
  error: ApiError | null;
  reload: () => void;
} {
  const router = useRouter();
  const [items, setItems] = useState<T[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [key, setKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((page) => {
        if (cancelled) return;
        setItems(page.items);
        setTotal(page.total);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.kind === "unauthorized") {
          router.replace("/login");
          return;
        }
        setError(
          err instanceof ApiError ? err : new ApiError("unknown", null, "加载失败"),
        );
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, load, ...deps]);

  return {
    items,
    total,
    error,
    reload: () => {
      setError(null);
      setKey((k) => k + 1);
    },
  };
}

/** 列表加载错误统一渲染：403 → 无权限（不跳登录）；网络 → 离线可重试；其余 → 可重试 */
export function listErrorView(
  error: ApiError,
  onRetry: () => void,
): React.ReactNode {
  if (error.kind === "forbidden") {
    return <Forbidden text="无权限访问该页面" />;
  }
  return (
    <ErrorView
      message={error.message}
      offline={error.kind === "network"}
      onRetry={onRetry}
    />
  );
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

export const inputClass =
  "block w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900";

export function SettingsHeader({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">{title}</h1>
        <p className="mt-1 text-sm text-gray-500">{description}</p>
      </div>
      {action}
    </div>
  );
}

export function Field({
  label,
  htmlFor,
  required,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        htmlFor={htmlFor}
        className="mb-1.5 block text-sm font-medium text-gray-700"
      >
        {label}
        {required ? <span className="text-red-500"> *</span> : null}
      </label>
      {children}
      {hint ? <p className="mt-1 text-xs text-gray-500">{hint}</p> : null}
    </div>
  );
}

export function ActionMessage({
  message,
}: {
  message: { kind: "success" | "error"; text: string } | null;
}) {
  if (!message) return null;
  return (
    <p
      role={message.kind === "error" ? "alert" : "status"}
      className={`rounded-md px-3 py-2 text-sm ring-1 ring-inset ${
        message.kind === "success"
          ? "bg-emerald-50 text-emerald-800 ring-emerald-200"
          : "bg-red-50 text-red-700 ring-red-200"
      }`}
    >
      {message.text}
    </p>
  );
}

/** 数据表通用外壳（可横向滚动） */
export function TableShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm">
      <table className="min-w-full divide-y divide-gray-200 text-sm">
        {children}
      </table>
    </div>
  );
}
