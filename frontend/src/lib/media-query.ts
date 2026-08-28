"use client";

/**
 * matchMedia 响应式钩子（useSyncExternalStore 实现）：
 * - SSR / 水合期间使用服务端快照（false），水合后自动切换到客户端快照
 *   （React 对 useSyncExternalStore 不产生水合不一致错误）
 * - 不违反 Next 16 `react-hooks/set-state-in-effect`（无 effect 内同步 setState）
 * - jsdom 无 matchMedia 时回退 false（桌面树，测试默认桌面）
 */

import { useCallback, useSyncExternalStore } from "react";

function subscribe(query: string, onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const mql = window.matchMedia(query);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function snapshot(query: string): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(query).matches;
}

/** query 如 "(max-width: 767px)"。 */
export function useMediaQuery(query: string): boolean {
  const subscribeToQuery = useCallback(
    (onChange: () => void) => subscribe(query, onChange),
    [query],
  );
  const getSnapshot = useCallback(() => snapshot(query), [query]);
  return useSyncExternalStore(subscribeToQuery, getSnapshot, () => false);
}
