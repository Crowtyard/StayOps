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

Sprint 3 新增（7 条；辅助集中在 `housekeeping-helpers.ts`；房间号段 105-110 / 209 / 210，
不与 Sprint 1/2 用例重叠）：

- `housekeeping.spec.ts`（3 条）：翻房 Golden Path UI 全链路（FRONT_DESK 预订→入住→退房 →
  自动任务 PENDING → UI 派单 → HOUSEKEEPING 开始清扫/提交验房/通过 → 房间 clean →
  下一笔入住 SUCCESS，房间 210）；Rework 闭环（INSPECTION → 返工 → 重新清扫 → 通过，
  每步 Task 与 Room.cleaning_status 一致，房间 209）；手动任务（FRONT_DESK 创建 dirty 房任务 →
  重复创建 409 → admin 取消 → 房间回置 dirty，房间 109）
- `housekeeping-safety.spec.ts`（4 条，HTTP 层）：Check-in clean gating
  （dirty/cleaning/inspection/rework → 409、clean → SUCCESS → 自动任务 → 完成链，
  房间 105-109）；RBAC 矩阵（FRONT_DESK 创建/派单、不可 start/cancel；HOUSEKEEPING
  执行工作流、不可创建/修改/取消；MAINTENANCE 403；assignees 端点）；并发
  （Duplicate Active Task / Concurrent Start / PASS vs REWORK 各 1 SUCCESS + 1 × 409，
  无矛盾终态）；PII（任务响应与审计无 Guest 身份/联系方式/预订数据）

Sprint 4 新增（10 条；辅助集中在 `front-desk-helpers.ts`；超期在住状态准备
`setup_overdue_stay.py`（真实 UPDATE planned_check_out_date，见文件头说明）；
房间号段 110 / 202 / 206 / 207 / 208，不与 Sprint 1-3 用例重叠）：

- `front-desk.spec.ts`（10 条）：
  1. Room Diary：28 房全量 + 楼层分组 + 7 天窗口 + Today Summary 五卡
  2. Golden Path（房间 110）：空白格快速新建（预填 room/check_in/check_out=+1）→
     时间线 1 晚条宽实测 ≈64px（[ci,co) 语义）→ Drawer 字段完整 → Check-in →
     房间栏刷新 在住 → Check-out → 可售+待清扫 + 自动保洁任务指示，
     COMPLETED 不再作为占用条
  3. 相邻预订（房间 202）：[d+1,d+3) 与 [d+3,d+5) boundingBox 实测首尾相接
     （gap ≤ 2px、各 2 列宽），无 off-by-one
  4. Attention 三条规则（房间 206/207/208）：脏房到店(A) / 超期在住(B，
     状态准备见 setup_overdue_stay.py) / 停用房未来预订(C)；需关注计数 = 3，
     抽屉内问题 + 下一步入口齐全
  5. Housekeeping 集成（房间 206）：脏房到店 → Attention → 房间尚未准备完成 +
     任务（Task No/status）+ 查看保洁任务 → 真实 start/submit/pass 闭环 →
     刷新 clean → Check-in 成功
  6. 搜索定位：房号 → Room Drawer（本地匹配，零 PII 请求）；预订单号 →
     Reservation Drawer（日期/晚数正确）
  7. PII：无 guest:read 自定义角色用户——时间线条无姓名、姓名/手机号搜索受限提示、
     预订单号搜索可用、Drawer 显示 ID 而非姓名
  8. RBAC：HOUSEKEEPING / FINANCE 无前台导航入口，直连 /front-desk → 无权限（不跳登录）
- 响应式（2 条）：Mobile 390×844 → FrontDeskTodayBoard（Room Diary 不渲染，
  `[data-room-cell]=0`）；Tablet 900×720 → 紧凑 Room Diary 可用（28 房 + 7 天列）
