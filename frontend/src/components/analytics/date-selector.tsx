"use client";

import {
  ANALYTICS_PRESETS,
  type AnalyticsPresetKey,
  type AnalyticsRange,
} from "@/lib/analytics";

/** 顶部统一 Date Selector（§43）：预设 + 自定义 + 对比开关 */
export default function DateSelector({
  preset,
  onPresetChange,
  customFrom,
  customTo,
  onCustomFromChange,
  onCustomToChange,
  rangeError,
  compare,
  onCompareChange,
  range,
}: {
  preset: AnalyticsPresetKey;
  onPresetChange: (key: AnalyticsPresetKey) => void;
  customFrom: string;
  customTo: string;
  onCustomFromChange: (value: string) => void;
  onCustomToChange: (value: string) => void;
  rangeError: string | null;
  compare: boolean;
  onCompareChange: (value: boolean) => void;
  range: AnalyticsRange | null;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-gray-200 bg-white p-3 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex flex-wrap items-center gap-2">
        {ANALYTICS_PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => onPresetChange(p.key)}
            aria-pressed={preset === p.key}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900 ${
              preset === p.key
                ? "bg-gray-900 text-white"
                : "border border-gray-300 text-gray-700 hover:bg-gray-50"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {preset === "custom" ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label className="flex items-center gap-1.5">
            <span className="text-gray-500">从</span>
            <input
              type="date"
              value={customFrom}
              onChange={(e) => onCustomFromChange(e.target.value)}
              aria-label="自定义开始日期"
              className="rounded-md border border-gray-300 px-2 py-1.5"
            />
          </label>
          <label className="flex items-center gap-1.5">
            <span className="text-gray-500">至</span>
            <input
              type="date"
              value={customTo}
              onChange={(e) => onCustomToChange(e.target.value)}
              aria-label="自定义结束日期"
              className="rounded-md border border-gray-300 px-2 py-1.5"
            />
          </label>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        {range ? (
          <p className="text-xs text-gray-500 tabular-nums">
            {range.from} ~ {range.to}
            <span className="ml-1 text-gray-400">（{range.to} 不含）</span>
          </p>
        ) : null}
        <label className="flex items-center gap-1.5 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={compare}
            onChange={(e) => onCompareChange(e.target.checked)}
            className="size-4 accent-gray-900"
          />
          与上一周期对比
        </label>
      </div>

      {rangeError ? (
        <p className="w-full text-xs text-red-600" role="alert">
          {rangeError}
        </p>
      ) : null}
    </div>
  );
}
