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

Sprint 1 基线（10 条，未改动）：

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

Sprint 2 S2-T3 新增（19 条；辅助集中在 `booking-helpers.ts`，
日期一律 Asia/Shanghai 动态生成；各 spec 使用专属房间号段）：

- `golden-path.spec.ts`（1 条，房间 203）：FRONT_DESK 全链路——
  创建 Guest → Availability → 预订 `[today, today+2)` → 重叠预订 409
  （UI 禁选 + BFF 409 原文）→ 当天 Check-in（CHECKED_IN + ACTIVE + occupied）
  → 当天 Check-out（COMPLETED + CHECKED_OUT + available+dirty）→ 刷新保持
  → admin 审计四事件 + details 无 PII
- `early-checkout.spec.ts`（1 条，房间 204）：REV-FINAL-03——
  A=`[today, today+2)` 当天入住当天退房 → COMPLETED 释放剩余日期 →
  B=`[today+1, today+3)` 同房成功
- `booking-rbac.spec.ts`（3 条）：SUPER_ADMIN / FRONT_DESK 导航可见并可操作
  （创建 + 取消，房间 205）；HOUSEKEEPING 导航不可见 + 直连 URL Forbidden 不跳 /login
- `booking-pii.spec.ts`（3 条，房间 201）：HOUSEKEEPING 三层无 PII——
  UI（dirty/occupied/当前有客，无身份/联系方式/金额）、
  网络响应体（/api/bff/* 无 PII 标记）、直连 API（guests/reservations/stays/availability 全 403）
- `concurrency.spec.ts`（3 条，房间 301-303）：真实 HTTP 并发（两个独立
  APIRequestContext + Promise.all）——Double Booking / 并发 Check-in / 并发 Check-out
  各 1 SUCCESS + 1 × 409，最终一致状态 + 无重复退房审计
- `failures.spec.ts`（7 条，房间 304-308）：dirty / occupied / 未来入住 / 已取消 /
  已退房 409（UI 原文 + BFF 状态码）、404 语义、401 BFF
- `regression.spec.ts`（1 条，房间 103）：Sprint 1 补充冒烟（登录 / BFF /
  房态棋盘 / 状态修改 / 审计 / 登出守卫），与既有 10 条互补
