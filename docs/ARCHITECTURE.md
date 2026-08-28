# StayOps 架构

## 顶层架构

- `frontend/` — Next.js 16 + TypeScript（strict）+ Tailwind 前端
- `backend/` — FastAPI + Python 后端
- `infra/docker/` — Docker 部署配置
- `docs/` — 项目文档
- `tests/` — 测试

## 后端结构（Sprint 5 · 更新）

```text
backend/app/
  models/            # Guest / Reservation / Stay（Booking 域）
                     # HousekeepingTask（Sprint 3：任务/枚举/来源/优先级）
                     # MaintenanceWorkOrder 新增（Sprint 5：工单/枚举/阻断语义）
  schemas/           # guest / reservation / stay / availability
                     # housekeeping（Create/Update strict、AssigneeOut）
                     # maintenance 新增（Create/Update strict、Assign/Resolve/Verify/Rework、AssigneeOut）
  core/              # business_date.py（Property Business Date，Asia/Shanghai）
                     # booking_state_machine.py（Reservation / Stay 状态机）
                     # housekeeping_state_machine.py（Task 状态机 + 房态联动映射）
                     # maintenance_state_machine.py 新增（MWO 状态机 + BLOCKING 语义）
                     # db_conflict.py 新增（23P01/40P01/40001 并发仲裁窄分类，Sprint 4 D1 复用）
  services/booking.py    # 可售性引擎、预订生命周期、Check-in/Check-out 事务、
                         # 权限裁剪序列化；Check-out 事务内调用 create_checkout_task；
                         # Sprint 5：Availability/Check-in/Checkout 感知 Active Blocking MWO
  services/housekeeping.py # 任务生命周期（创建/派单/PATCH/五个 action）、
                         # Task↔Room 原子联动、审计同事务、Active Task 唯一
  services/maintenance.py  # 新增：工单生命周期（报修/派单/PATCH/六个 action）、
                         # blocks_room ↔ Room 可售性原子联动（Room → MWO 固定锁顺序）、
                         # Last Blocking 规则、MANUAL OOS 保护、审计同事务
  api/routes/        # guests / availability / reservations / stays
                     # housekeeping（/housekeeping/tasks + /housekeeping/assignees）
                     # maintenance 新增（/maintenance/orders + /maintenance/assignees）
                     # reservations 列表 overlap_from / overlap_to（Sprint 4）
  alembic/versions/77ec5f0c543e_add_housekeeping_domain.py  # Housekeeping 域迁移
  alembic/versions/a7f3e4c1d902_add_maintenance_domain.py   # 新增：Maintenance 域迁移
                     # （MWO 表/枚举/Sequence/rooms.unavailability_source 回填/CHECK 约束/部分索引）
```

- 预订域业务集中在 `services/booking.py`（routes 保持薄），决策见 docs/DECISIONS.md（S2-T1 第 9 条）。
- Double Booking 最终仲裁在数据库（排他约束 `ex_reservations_room_daterange` + btree_gist），应用层预检仅为快速路径。
- Active Task 唯一最终仲裁在数据库（部分唯一索引 `uq_housekeeping_tasks_active_room`），应用层预检仅为快速路径。
- Check-out 与 Housekeeping Task 创建为同一数据库事务（原子不变式：退房必有翻房任务）。
- 后端是 PII / 权限的最终边界：响应按 guest:read / reservation:read 裁剪字段（不只是前端隐藏）。Housekeeping 域不关联 Guest / Reservation，天然无 PII。
- **Maintenance（Sprint 5）**：MaintenanceWorkOrder 为第三独立业务领域（维修状态 ≠ 占用 ≠ 清洁）；
  Active Blocking（blocks_room + OPEN/ASSIGNED/IN_PROGRESS/RESOLVED）参与 Availability /
  Check-in / Checkout 最终判断；工单 ↔ Room 可售性事务固定锁顺序 Room → MWO；
  只能解除自己造成的 OOS（source=MAINTENANCE 且 active blocking MWO=0），
  MANUAL OOS / blocked 永不被 Maintenance 解除；Cleaning 维度不受 Maintenance 影响。
  Maintenance 域不关联 Guest / Reservation，天然无 PII。

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

## 前端结构（T3b / S2-T2 / S3）

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
    (main)/housekeeping                   # S3：保洁运营工作台（状态视图 + 快捷操作 + 新建任务）
    (main)/housekeeping/[id]              # S3：保洁任务详情（派单/优先级/备注 + 操作确认）
    (main)/maintenance                    # S5：维修运营工作台（状态视图 + 筛选/搜索 + 快捷操作 + 现场报修）
    (main)/maintenance/[id]               # S5：维修工单详情（派工/编辑 + 六个 action 确认）
    (main)/maintenance/new                # S5：现场报修表单（Mobile Friendly，?room_id&source 预填）
    (main)/front-desk                     # S4：前台运营指挥台（Today Summary + Search + Room Diary + 右侧 Drawer）
    (main)/settings/{users,roles,room-types,audit-logs}/page.tsx   # 管理页（T3b）
  components/                             # AppShell(侧边导航+顶栏+手机Drawer)、状态徽标、
                                          # 确认对话框、Modal、Loading/Empty/Error/Forbidden 视图
  components/booking/                     # S2-T2：guest-picker（搜索/创建）、availability-picker（可售房间）、
                                          # reservation-form（新建/编辑共用，S4 增加 create 模式 prefill）、shared（字段/提示条）
  components/front-desk/                  # S4：front-desk-view（指挥台编排 + 权限门控 + 轮询）、
                                          # use-front-desk-data（4 个批量 List API 组合，无 N+1）、
                                          # room-diary（时间线网格 + sticky 房间栏 + 空白格快捷菜单）、
                                          # today-summary / search-box / drawer / drawer-views
                                          # （Arrivals/Departures/Attention/Reservation/Room Quick View）、
                                          # front-desk-today-board（<768px 移动端）
  components/housekeeping-*.tsx           # S3：工作台视图 / 任务详情视图
  components/maintenance/                 # S5：maintenance-workspace-view（工作台）、
                                          # maintenance-work-order-detail-view（详情）、report-form（现场报修）
  components/settings/                    # 四个管理页视图 + 共享工具（分页加载/表单/表格）
  lib/api/                                # 统一 API Client（client.ts + guests/reservations/stays/
                                          # availability + housekeeping（S3）+ maintenance（S5）等资源模块 + 错误归一化）
  lib/booking.ts                          # S2-T2：业务日期（Asia/Shanghai）、日期校验、状态标签、金额展示
  lib/front-desk.ts                       # S4：时间线几何（[ci,co) 裁剪与像素定位）、Today Summary /
                                          # Attention 四规则纯函数（A/B/C/M）、预订条 PII 安全文案、quickCreateHref
  lib/housekeeping.ts                     # S3：任务状态/优先级/来源展示元数据 + 房态联动映射（展示层）
  lib/maintenance.ts                      # S5：工单状态/分类/严重度/来源展示元数据 + Active Blocking 判断（展示层）
  lib/server/                             # 服务端 Cookie 读取 / 后端直连 Client
  test/setup.ts                           # Vitest 全局 setup（jest-dom + RTL cleanup）
```

- 页面数据由 Client Component 在挂载后经 `/api/bff` 拉取（Loading/Empty/Error 三态）；
  登录态由服务端布局读取 Cookie 校验（未登录 307 → /login）
- 导航按 `auth/me` 返回的权限 code 动态显示（S2-T2：`reservation:read` → 预订、`stay:read` → 在住；
  S3：`housekeeping_task:read` → 保洁；S4：`room:read` + `reservation:read` 同时满足 → 前台；
  S5：`maintenance_order:read` → 维修）；
  403 统一渲染“无权限访问该页面”（不跳登录，与 401 区分）
- 管理页写操作权限（user:write / role:write / room_type:write 等）由后端 RBAC 裁决，前端仅按权限显隐按钮
- Booking 操作（cancel / no-show / check-in / check-out）按 Reservation.status 值 + 权限显隐按钮，前端不复制后端状态机；后端 409 detail 原样展示
- PII 双边界：后端响应已按 guest:read / reservation:read 裁剪（裁剪字段以键缺失呈现，见 S2-T1），前端再按权限隐藏对应区块（不渲染 Guest 姓名/联系方式/金额）
- Housekeeping 操作（start / submit / pass / rework / cancel）按 Task.status 值 + 权限显隐按钮，
  前端不复制后端状态机；派单候选人经 `GET /housekeeping/assignees`（housekeeping_task:write，
  不要求 user:read）；任务页面不含任何 Guest / Reservation 数据
- **Maintenance（S5）**：操作（assign / start / resolve / verify / rework / cancel）按
  MWO.status 值 + 权限显隐按钮，前端不复制后端状态机；工单页面不含任何 Guest / Reservation 数据；
  报修表单 Mobile Friendly 并支持 `?room_id&source` 预填；保洁任务详情「发现设施问题 → 报修」
  仅 `maintenance_order:write` 时显示（预填 room_id + source=HOUSEKEEPING，不复制保洁备注）；
  Front Desk Room/Reservation Quick View 展示 Active MWO + status + blocks_room + assignee
  + 查看维修（`maintenance_order:read` 才请求与展示）
  - Front Desk（S5 修复）：Attention 新增 Rule M「预订存在维修风险」
    （CONFIRMED + check_in ≥ 今日 + Active Blocking MWO，与 Room occupancy 无关；
    一条预订一条卡片、多工单合并计数；M 优先抑制同预订 Rule C；仅
    maintenance_order:read 时加载 workOrders，无权限不请求不显示）；
    桌面 Attention Drawer 与 Mobile Today Board 共享 computeAttention 并渲染
    「查看维修 →」直达链接
- **Front Desk（S4 + S5 最小集成）**：页面数据 = `GET /rooms` + `GET /reservations?overlap_from&overlap_to`
  + `GET /stays?status=ACTIVE` + `GET /housekeeping/tasks` + `GET /maintenance/orders`
  （S5，仅 `maintenance_order:read` 时请求）批量 List API 客户端组合
  （无 N+1，无聚合端点）；时间线严格 `[check_in, check_out)` 渲染，双状态（占用 + 清洁）不合并；
  空白格快速新建复用 `/reservations/new`（URL 预填），Backend Availability 仍重新验证；
  写操作后 targeted refetch + 60s 轻量轮询（Drawer 打开时暂停）；
  <768px 渲染 FrontDeskTodayBoard（不渲染完整 Room Diary），768–1023 紧凑、≥1024 完整

## 测试架构（T3b / S2-T2）

- **Vitest 单元/组件测试**（`frontend/vitest.config.mts`，jsdom + @testing-library/react，`pnpm test`）：
  测试文件与源码同目录（`src/**/__tests__/*.test.ts(x)`）；API 层经 `vi.mock` 替换为假实现、
  真实 `ApiError` 语义保留；`next/navigation` / `next/link` 按需 mock。
  S2-T2 新增 Booking 域用例（139 = Sprint 1 基线 74 + S2-T2 新增 65），
  S3 新增 Housekeeping 域用例（170 = 139 + 31：lib 元数据 / 工作台 / 任务详情 /
  导航 / Dashboard 概览 / Room Detail 任务卡），
  S4 新增 Front Desk 用例（240 = 170 + 70：lib 时间线几何与三规则 / Room Diary /
  Command Center 集成 / Today Board / 快速新建预填 / 前台导航矩阵），
   S5 新增 Maintenance 用例（300 = 240 + 60：lib 元数据 / 维修工作台 / 工单详情 /
   现场报修表单 / 保洁快捷报修 / 前台维修集成 / 维修导航矩阵），
  测试日期一律基于 Asia/Shanghai 业务日期动态生成（`businessDate()` / `addDays`，禁止硬编码年月日）。
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
  - S3 新增 2 个 spec（辅助集中在 `e2e/housekeeping-helpers.ts`）：
    `housekeeping`（翻房 Golden Path UI 全链路 + 下一笔入住成功，房间 210；
    Rework 闭环每步房态一致，房间 209；手动任务/重复 409/admin 取消，房间 109）、
    `housekeeping-safety`（Check-in clean gating 四状态 409 + clean 成功，房间 105-109；
    RBAC 矩阵 + assignees；Duplicate Active Task / Concurrent Start / PASS vs REWORK 并发；
    PII 无泄漏）
  - S4 新增 `front-desk.spec.ts` 10 条（辅助集中在 `e2e/front-desk-helpers.ts`，
    超期在住状态准备 `e2e/setup_overdue_stay.py`，房间 110/202/206/207/208）：
    28 房 Diary + Today Summary；Golden Path（空白格快速新建 → [ci,co) 时间线区间 →
    Drawer → Check-in → 刷新 → Check-out → dirty + 保洁任务）；相邻预订首尾相接
    （boundingBox 实测 1 晚 = 64px、gap ≤ 2px）；Attention 三规则 + 维修风险（脏房到店 / 超期在住 /
    停用房未来预订）；Housekeeping 集成（脏房到店 → 任务可见 → 完成清扫 → 刷新 clean →
    Check-in 成功）；搜索定位（房号 / 预订单号）；PII（无 guest:read 姓名隐藏 + 搜索受限）；
    RBAC（HOUSEKEEPING / FINANCE 无入口 + 直连 403）；Mobile（390×844 Today Board，
    Room Diary 不渲染）；Tablet（900×720 紧凑 Diary）
  - S5 新增 `maintenance.spec.ts` 3 条 + `maintenance-safety.spec.ts` 11 条
    （辅助集中在 `e2e/maintenance-helpers.ts`，账号 MANAGER / MAINTENANCE 由
    `setup-users.ts` 幂等创建，房间 301-308 测试开始前经 admin API 归一化）：
    Golden Path UI 全链路（保洁发现 → 阻断报修 → MANAGER 派工 → MAINTENANCE 维修 →
    MANAGER 验收 → 房间恢复 → 清洁后 Check-in Ready + 全链路审计）；PRE_OPENING
    报修与来源筛选；Mobile 390×844 报修表单；occupied blocker（不覆盖在住）+
    Checkout 停用；future reservation 保留；multiple blockers / Last Blocking；
    Rework / Cancel / Manual OOS 保护；Check-in 409；RBAC 矩阵 + FINANCE；
    PII（工单无 Guest 数据 + MAINTENANCE 无 Booking PII 出口）；完成 ≠ 清洁；
    S5 缺陷修复（occupied + 未来预订 + blocking MWO → 前台主动维修风险 Attention）
  - 各 spec 使用专属房间号段保证用例间确定性；既有 auth/rbac/rooms/settings 4 个 spec 与
    `playwright.config.ts` 隔离机制保持不变
- **后端 pytest**（`backend/`，285 用例 = Sprint 1 基线 87 + S2-T1 Booking 76 + S2T1-BLK-01 严格 PATCH 4 + S3 Housekeeping 35 + S4 overlap 窗口查询 11 + S4 D1 死锁窄分类 7 + S5 Maintenance 65）：独立测试库 `stayops_test`（与 E2E 同库策略），
  会话级 DROP/CREATE + 迁移 + seed，用例级事务回滚隔离；并发用例（Double Booking / Check-in / Check-out / 业务单号 / Duplicate Active Task / Concurrent Start / PASS vs REWORK / D1 25 轮双订 / S5 同房双阻断创建 / 并发 verify / cancel vs verify）用两线程 + 独立 Session 真实提交验证。
  pytest 与 Playwright E2E 共享 `stayops_test` 且互斥（不得并行运行）。

## 原则

- 前后端分离，通过 REST API 通信
- 业务权限在后端验证（前端隐藏按钮不算权限控制）
- 数据库 Schema 变更一律使用 Migration
- 重大架构决策记录到 `DECISIONS.md`
