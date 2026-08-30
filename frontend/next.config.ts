import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // E2E 专用实例可用 NEXT_DIST_DIR=.next-e2e 隔离构建目录，
  // 避免与本地正在运行的开发服务器（默认 .next，端口 3000）相互干扰。
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Desktop 生产构建（desktop/scripts/build-frontend.mjs）显式开启
  // output: standalone（NEXT_OUTPUT_STANDALONE=1）；默认构建行为
  // （next start / 既有开发流程）保持不变。
  ...(process.env.NEXT_OUTPUT_STANDALONE === "1"
    ? { output: "standalone" as const }
    : {}),
};

export default nextConfig;
