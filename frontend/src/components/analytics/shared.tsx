"use client";

import type { ReactNode } from "react";

/** 分析区块卡片（标题 + 说明 + 内容） */
export function SectionCard({
  title,
  hint,
  children,
  className = "",
}: {
  title: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-lg border border-gray-200 bg-white p-4 ${className}`}>
      <div className="mb-3 flex items-baseline gap-2">
        <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
        {hint ? <p className="text-xs text-gray-400">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

/** 纯文本表格（重要数值不只靠颜色表达，§51） */
export function TextTable({
  columns,
  rows,
  emptyText = "暂无数据",
}: {
  columns: { key: string; label: string; align?: "left" | "right" }[];
  rows: Record<string, ReactNode>[];
  emptyText?: string;
}) {
  if (rows.length === 0) {
    return <p className="py-6 text-center text-sm text-gray-400">{emptyText}</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[420px] text-left text-sm">
        <thead>
          <tr className="border-b border-gray-200 text-xs text-gray-500">
            {columns.map((c) => (
              <th
                key={c.key}
                className={`px-2 py-2 font-medium ${c.align === "right" ? "text-right" : ""}`}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-gray-100 last:border-0">
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={`px-2 py-2 tabular-nums text-gray-700 ${
                    c.align === "right" ? "text-right" : ""
                  }`}
                >
                  {row[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 权限说明条（未授权 Domain 不请求、不显示数据，§35） */
export function PermissionNote({ text }: { text: string }) {
  return (
    <p className="rounded-md bg-gray-50 px-3 py-2 text-xs text-gray-500">{text}</p>
  );
}
