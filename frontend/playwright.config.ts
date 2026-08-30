/**
 * Playwright E2E 配置（真实 FastAPI，禁止 Mock）：
 * - 独立测试库 stayops_test：webServer 启动 E2E 后端（127.0.0.1:8001，
 *   启动时重建测试库）与 E2E 前端（localhost:3001，BACKEND_API_URL 指向 8001）
 * - 不触碰开发环境（127.0.0.1:8000 / localhost:3000）
 * - 凭据经 frontend/e2e/.env.test-creds（gitignored）读取并注入 worker 环境
 */

import { defineConfig } from "@playwright/test";
import { loadTestCredentials } from "./e2e/creds";

const FRONTEND_PORT = 3001;
const BACKEND_PORT = 8001;

const creds = loadTestCredentials();
// config 在 runner 进程加载后再 fork worker，worker 继承此处写入的环境变量
process.env.E2E_ADMIN_USERNAME = creds.adminUsername;
process.env.E2E_ADMIN_PASSWORD = creds.adminPassword;
process.env.E2E_FRONT_DESK_USERNAME = creds.frontdeskUsername;
process.env.E2E_FRONT_DESK_PASSWORD = creds.frontdeskPassword;
process.env.E2E_HOUSEKEEPING_USERNAME = creds.housekeepingUsername;
process.env.E2E_HOUSEKEEPING_PASSWORD = creds.housekeepingPassword;
process.env.E2E_MANAGER_USERNAME = creds.managerUsername;
process.env.E2E_MANAGER_PASSWORD = creds.managerPassword;
process.env.E2E_MAINTENANCE_USERNAME = creds.maintenanceUsername;
process.env.E2E_MAINTENANCE_PASSWORD = creds.maintenancePassword;
process.env.E2E_FINANCE_USERNAME = creds.financeUsername;
process.env.E2E_FINANCE_PASSWORD = creds.financePassword;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  // 共享一个测试库，串行执行保证确定性
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${FRONTEND_PORT}`,
    trace: "retain-on-failure",
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: [
    {
      // E2E 后端：单进程入口（重建 stayops_test + 内嵌 uvicorn），
      // 由 Playwright 干净地管理整个进程树
      command: "..\\backend\\.venv\\Scripts\\python.exe e2e\\run_test_backend.py",
      url: `http://127.0.0.1:${BACKEND_PORT}/health`,
      reuseExistingServer: false,
      timeout: 240_000,
    },
    {
      command: `node node_modules/next/dist/bin/next dev -p ${FRONTEND_PORT}`,
      env: {
        ...(process.env as Record<string, string>),
        BACKEND_API_URL: `http://127.0.0.1:${BACKEND_PORT}`,
        PORT: String(FRONTEND_PORT),
        // 独立构建目录，避免与默认 3000 端口的开发服务器共享 .next
        NEXT_DIST_DIR: ".next-e2e",
      },
      url: `http://localhost:${FRONTEND_PORT}/login`,
      reuseExistingServer: false,
      timeout: 240_000,
    },
  ],
});
