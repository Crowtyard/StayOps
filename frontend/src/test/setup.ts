/**
 * Vitest 全局 setup：
 * - jest-dom 匹配器（toBeInTheDocument / toHaveTextContent 等）
 * - React Testing Library 渲染清理（globals 关闭时需手动注册）
 */

import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});
