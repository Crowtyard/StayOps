"use client";

import { IconAlert, IconRefresh } from "@/components/icons";

export function Loading({ text = "加载中…" }: { text?: string }) {
  return (
    <div
      className="flex items-center justify-center gap-3 py-16 text-sm text-gray-500"
      role="status"
      aria-live="polite"
    >
      <span
        className="size-5 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600"
        aria-hidden="true"
      />
      {text}
    </div>
  );
}

export function Empty({ text = "暂无数据" }: { text?: string }) {
  return (
    <div className="py-16 text-center text-sm text-gray-500" role="status">
      {text}
    </div>
  );
}

export interface ErrorViewProps {
  /** 后端不可达时显示“服务暂时不可用” */
  message?: string;
  offline?: boolean;
  onRetry?: () => void;
}

export function Forbidden({ text = "无权限访问该页面" }: { text?: string }) {
  return (
    <div
      className="flex flex-col items-center gap-3 py-16 text-center"
      role="alert"
      aria-live="assertive"
    >
      <span className="flex size-10 items-center justify-center rounded-full bg-amber-100 text-amber-600">
        <IconAlert className="size-5" />
      </span>
      <p className="text-sm text-gray-900">{text}</p>
      <p className="text-xs text-gray-500">
        如需访问，请联系管理员为您分配相应权限
      </p>
    </div>
  );
}

export function ErrorView({ message, offline, onRetry }: ErrorViewProps) {
  const text =
    message ?? (offline ? "服务暂时不可用，请稍后重试" : "加载失败，请稍后重试");
  return (
    <div
      className="flex flex-col items-center gap-4 py-16 text-center"
      role="alert"
      aria-live="assertive"
    >
      <span className="flex size-10 items-center justify-center rounded-full bg-red-100 text-red-600">
        <IconAlert className="size-5" />
      </span>
      <p className="text-sm text-gray-700">{text}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-2 rounded-md bg-gray-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-gray-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900"
        >
          <IconRefresh className="size-4" />
          重新加载
        </button>
      ) : null}
    </div>
  );
}
