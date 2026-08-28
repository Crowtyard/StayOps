"use client";

/**
 * 右侧抽屉外壳（Front Desk 专用，不跳离 /front-desk）：
 * - 遮罩点击 / Esc 关闭；role=dialog + aria-modal
 * - 数据由调用方传入，抽屉自身不拥有 Booking Business Logic
 */

import { useEffect } from "react";
import { IconX } from "@/components/icons";

export interface DrawerProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}

export default function Drawer({ open, title, onClose, children }: DrawerProps) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        aria-label="关闭侧栏"
        className="absolute inset-0 bg-gray-900/40"
        onClick={onClose}
        tabIndex={-1}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="absolute inset-y-0 right-0 flex w-full max-w-md flex-col bg-white shadow-2xl"
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-gray-200 px-5 py-3.5">
          <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100"
          >
            <IconX className="size-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {children}
        </div>
      </div>
    </div>
  );
}
