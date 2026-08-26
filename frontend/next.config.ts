import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // E2E 专用实例可用 NEXT_DIST_DIR=.next-e2e 隔离构建目录，
  // 避免与本地正在运行的开发服务器（默认 .next，端口 3000）相互干扰。
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
