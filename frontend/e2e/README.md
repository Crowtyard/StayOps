# E2E 测试（Playwright）

真实 FastAPI 端到端测试，禁止 Mock。使用独立测试库 `stayops_test`，通过独立端口隔离：

- 后端：`127.0.0.1:8001`（`stayops_test` 库，启动时重建：迁移 + 28 间种子房）
- 前端：`localhost:3001`（`BACKEND_API_URL=http://127.0.0.1:8001`，独立构建目录 `.next-e2e`）

不触碰开发环境（`127.0.0.1:8000` / `localhost:3000` / `stayops` 库）。

## 准备

1. 首次：复制凭据模板并填真实值（勿提交）：
   ```powershell
   Copy-Item e2e\test-creds.example e2e\.env.test-creds
   ```
   `.env.test-creds` 已被 `.gitignore` 忽略。
2. 浏览器：`npx playwright install chromium`（本仓库依赖 @playwright/test 1.62，对应 chromium-1234）。

## 运行

```powershell
pnpm.cmd test:e2e
```

Playwright 会自动启动后端（`e2e/run_test_backend.py`，单进程内嵌 uvicorn，重建测试库）
与前端（`node node_modules/next/dist/bin/next dev`，独立构建目录 `.next-e2e`）。

E2E 专用账号（FRONT_DESK / HOUSEKEEPING）由 `e2e/setup-users.ts` 在测试
`beforeAll` 中幂等创建（保证在服务就绪后执行）。

## 覆盖场景

1. 管理员登录并进入 Dashboard
2. Rooms 基础链路（28 房棋盘、详情、状态修改、刷新保持）
3. SUPER_ADMIN 可访问用户与角色管理
4. FRONT_DESK 无法访问角色管理（导航不可见 + 直连 403）
5. HOUSEKEEPING 无权限访问用户管理
6. 用户管理真实读取（列表来自后端）
7. 角色和权限真实读取
8. 房型真实读取
9. Audit Log 能看到实际房态变更记录
10. 退出登录后受保护页面重新要求认证
