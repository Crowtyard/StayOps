import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * Vitest 单元/组件测试配置（与 Next.js 构建互不干扰）：
 * - jsdom 环境 + React 插件（自动 JSX 转换）
 * - 路径别名与 tsconfig 一致（@/* → src/*）
 * - setup 文件引入 jest-dom 匹配器与 RTL cleanup
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    clearMocks: true,
  },
});
