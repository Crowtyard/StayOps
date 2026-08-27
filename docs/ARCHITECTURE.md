# StayOps 架构

## 顶层架构

- `frontend/` — Next.js 16 + TypeScript（strict）+ Tailwind 前端
- `backend/` — FastAPI + Python 后端
- `infra/docker/` — Docker 部署配置
- `docs/` — 项目文档
- `tests/` — 测试

## 后端结构（Sprint 2 · S2-T1 更新）

```text
backend/app/
  models/            # Guest / Reservation / Stay 新增（Booking 域，枚举 + 关系）
  schemas/           # guest / reservation / stay / availability 新增
  core/              # 新增 business_date.py（Property Business Date，Asia/Shanghai）
                     # 新增 booking_state_machine.py（Reservation / Stay 状态机）
  services/booking.py   # 新增 service 层：可售性引擎、预订生命周期、
                        # Check-in/Check-out 事务、权限裁剪序列化
  api/routes/        # 新增 guests / availability / reservations / stays
  alembic/versions/16debb5c57f8_add_booking_domain.py   # Booking 域迁移
```

- 预订域业务集中在 `services/booking.py`（routes 保持薄），决策见 docs/DECISIONS.md（S2-T1 第 9 条）。
- Double Booking 最终仲裁在数据库（排他约束 `ex_reservations_room_daterange` + btree_gist），应用层预检仅为快速路径。
- 后端是 PII / 权限的最终边界：响应按 guest:read / reservation:read 裁剪字段（不只是前端隐藏）。

## 通信架构：HttpOnly Cookie + BFF

浏览器不接触 JWT。前端所有后端调用统一经过 Next.js Route Handler：

```text
Browser ──→ /api/auth/login|logout|me（认证 BFF，读写 HttpOnly Cookie）
        └─→ /api/bff/[...path]（通用代理，服务端读 Cookie 附加 Bearer）
              └─→ FastAPI /api/v1/*（BACKEND_API_URL，业务权限唯一裁决点）
```

- 登录成功 → JWT 写入 `stayops_token` Cookie（httpOnly / sameSite=lax / path=/；生产 secure）
- 401 前端清状态跳 /login；403 显示“无权限”，不与登录失效混淆
- 服务端直连后端（Server Components 登录守卫 / 认证 BFF）时不经过 `/api/bff`

## 前端结构（T3b / S2-T2）

```text
frontend/src/
  app/
    api/auth/{login,logout,me}/route.ts   # 认证 BFF（Cookie 读写）
    api/bff/[...path]/route.ts            # 通用代理（透传状态码与 detail）
    login/page.tsx                        # 登录页
    (main)/layout.tsx                     # 受保护布局：服务端登录守卫 + AppShell
    (main)/dashboard|rooms|rooms/[id]     # 首页概览 / 房态棋盘 / 房间详情
    (main)/reservations                   # S2-T2：预订列表（筛选/分页）
    (main)/reservations/new               # S2-T2：新建预订（Guest 搜索创建 + Availability）
    (main)/reservations/[id]              # S2-T2：预订详情（编辑/Cancel/No-show/Check-in）
    (main)/stays                          # S2-T2：在住列表（stay:read 导航落点）
    (main)/stays/[id]                     # S2-T2：在住详情（Check-out）
    (main)/settings/{users,roles,room-types,audit-logs}/page.tsx   # 管理页（T3b）
  components/                             # AppShell(侧边导航+顶栏+手机Drawer)、状态徽标、
                                          # 确认对话框、Modal、Loading/Empty/Error/Forbidden 视图
  components/booking/                     # S2-T2：guest-picker（搜索/创建）、availability-picker（可售房间）、
                                          # reservation-form（新建/编辑共用）、shared（字段/提示条）
  components/settings/                    # 四个管理页视图 + 共享工具（分页加载/表单/表格）
  lib/api/                                # 统一 API Client（client.ts + guests/reservations/stays/
                                          # availability 等资源模块 + 错误归一化）
  lib/booking.ts                          # S2-T2：业务日期（Asia/Shanghai）、日期校验、状态标签、金额展示
  lib/server/                             # 服务端 Cookie 读取 / 后端直连 Client
  test/setup.ts                           # Vitest 全局 setup（jest-dom + RTL cleanup）
```

- 页面数据由 Client Component 在挂载后经 `/api/bff` 拉取（Loading/Empty/Error 三态）；
  登录态由服务端布局读取 Cookie 校验（未登录 307 → /login）
- 导航按 `auth/me` 返回的权限 code 动态显示（S2-T2 新增：`reservation:read` → 预订、`stay:read` → 在住）；403 统一渲染“无权限访问该页面”（不跳登录，与 401 区分）
- 管理页写操作权限（user:write / role:write / room_type:write 等）由后端 RBAC 裁决，前端仅按权限显隐按钮
- Booking 操作（cancel / no-show / check-in / check-out）按 Reservation.status 值 + 权限显隐按钮，前端不复制后端状态机；后端 409 detail 原样展示
- PII 双边界：后端响应已按 guest:read / reservation:read 裁剪（裁剪字段以键缺失呈现，见 S2-T1），前端再按权限隐藏对应区块（不渲染 Guest 姓名/联系方式/金额）

## 测试架构（T3b / S2-T2）

- **Vitest 单元/组件测试**（`frontend/vitest.config.mts`，jsdom + @testing-library/react，`pnpm test`）：
  测试文件与源码同目录（`src/**/__tests__/*.test.ts(x)`）；API 层经 `vi.mock` 替换为假实现、
  真实 `ApiError` 语义保留；`next/navigation` / `next/link` 按需 mock。
  S2-T2 新增 Booking 域用例（139 = Sprint 1 基线 74 + S2-T2 新增 65），测试日期一律基于
  Asia/Shanghai 业务日期动态生成（`businessDate()` / `addDays`，禁止硬编码年月日）。
- **Playwright E2E**（`frontend/playwright.config.ts`，`pnpm test:e2e`）：
  - 独立测试库 `stayops_test`：后端 webServer 直接运行单进程入口 `frontend/e2e/run_test_backend.py` ——
    `prepare_test_db.py` DROP/CREATE 测试库 → alembic upgrade → 幂等 seed（28 间种子房）→
    在本进程内于 `127.0.0.1:8001` 启动 FastAPI（`DATABASE_URL` 指向测试库）
  - E2E 前端：`node node_modules/next/dist/bin/next dev -p 3001`（`BACKEND_API_URL=http://127.0.0.1:8001`，`NEXT_DIST_DIR=.next-e2e` 独立构建目录）
  - `setup-users.ts` 在测试 `beforeAll` 中以 admin 直连后端创建 FRONT_DESK / HOUSEKEEPING 测试账号（幂等）
  - 凭据仅存 gitignored 的 `frontend/e2e/.env.test-creds`（模板 `test-creds.example`），经环境变量注入 worker
  - 单 worker 串行执行保证共享测试库确定性；不触碰开发环境（127.0.0.1:8000 / localhost:3000）
  - S2-T3 新增 7 个 spec（辅助集中在 `e2e/booking-helpers.ts`，动态日期 = Asia/Shanghai）：
    `golden-path`（预订 → 重叠 409 → 当天入住/退房 → 审计无 PII，房间 203）、
    `early-checkout`（REV-FINAL-03：COMPLETED 释放剩余日期，房间 204）、
    `booking-rbac`（SUPER_ADMIN / FRONT_DESK / HOUSEKEEPING 导航与 403）、
    `booking-pii`（HOUSEKEEPING 三层无 PII：UI / 网络响应 / 直连 403，房间 201）、
    `concurrency`（Double Booking / 并发 Check-in / 并发 Check-out 各 1 SUCCESS + 1 × 409，
    两个独立 APIRequestContext + Promise.all，房间 301-303）、
    `failures`（dirty/occupied/未来入住/已取消/已退房 409 + 404/401 语义，房间 304-308）、
    `regression`（Sprint 1 补充冒烟，房间 103；与既有 10 条互补，不替代）
  - 各 spec 使用专属房间号段保证用例间确定性；既有 auth/rbac/rooms/settings 4 个 spec 与
    `playwright.config.ts` 隔离机制保持不变
- **后端 pytest**（`backend/`，167 用例 = Sprint 1 基线 87 + S2-T1 Booking 76 + S2T1-BLK-01 严格 PATCH 4）：独立测试库 `stayops_test`（与 E2E 同库策略），
  会话级 DROP/CREATE + 迁移 + seed，用例级事务回滚隔离；并发用例（Double Booking / Check-in / Check-out / 业务单号）用两线程 + 独立 Session 真实提交验证。
  pytest 与 Playwright E2E 共享 `stayops_test` 且互斥（不得并行运行）。

## 原则

- 前后端分离，通过 REST API 通信
- 业务权限在后端验证（前端隐藏按钮不算权限控制）
- 数据库 Schema 变更一律使用 Migration
- 重大架构决策记录到 `DECISIONS.md`
