# Changelog

All notable changes to StayOps will be documented in this file.

## [v1.0.0-alpha.4] - 2026-08-28

### Added

- Sprint 4: Front Desk Command Center & Room Diary（前台运营指挥台与房态日历，`/front-desk`）
- Today Summary（今日到店 / 今日离店 / 当前在住 / 空净房 / 需关注，卡片点击 → 右侧 Drawer）
- Room Diary：28 间房全量（无分页）× 1/7/14/30 天时间线；楼层分组、楼层/房型筛选、
  左侧房间栏固定（sticky）+ 日期区横向滚动（键盘可聚焦）；房间双状态（占用 + 清洁）同时展示
- Reservation Timeline 严格 `[check_in_date, check_out_date)`（无 off-by-one；相邻预订首尾相接）；
  默认只展示 CONFIRMED / CHECKED_IN（CANCELLED / NO_SHOW / COMPLETED 不作为占用条）
- 预订条：Guest name（guest:read）/ status / source；tooltip 受 RBAC/PII 控制
- Reservation Quick View Drawer（Room/Guest/Dates/Nights/Source/Amount/状态/占用/清洁/保洁任务 +
  Check-in / Edit / Cancel / No-show / Full Detail，全部复用 Sprint 2 API）
- §11 未准备房间：今日到店且非 clean → 隐藏 Check-in 主操作，显示「房间尚未准备完成」+
  Active HousekeepingTask（Task No/status/assignee）+ 查看保洁任务（后端 409 仍为最终权威）
- 点击空白日期格：新建预订（复用 `/reservations/new` 并预填 room_id / check_in /
  check_out=check_in+1，Backend Availability 仍重新验证）/ 查看房间
- 统一搜索：房号（本地匹配）/ Guest name / phone / reservation_no（复用现有 search API）；
  结果点击定位房间 / 定位日期 / 打开 Drawer；无 guest:read 时姓名/手机号搜索受限
- Attention Center 三条固定规则（A 脏房到店 / B 超期在住 / C 锁房未来预订），
  每项给出房间 / 问题 / 业务 / 下一步（无通用 Rule Engine）
- Room Quick View Drawer（双状态 + current stay + active housekeeping task +
  next reservation + 完整房间详情）
- Mobile（<768px）FrontDeskTodayBoard（不渲染完整 Room Diary）；768–1023 紧凑 Diary、≥1024 完整
- 写操作后 targeted refetch；60s 轻量轮询（Drawer 打开时暂停）
- Backend：`GET /reservations` 新增 `overlap_from` / `overlap_to` 日期窗口重叠查询
  （`check_in < overlap_to AND check_out > overlap_from`；只给一端或 to<=from → 422；
  只读扩展，不改变写操作）
- 前台导航入口（需 room:read + reservation:read 同时满足，不用角色名判断）

### Fixed

- D1（Kun Fast QA Blocking Defect）：并发 Double Booking 时 PostgreSQL 排他约束检查
  偶发 DeadlockDetected（40P01）逃逸为 500。修复（窄分类）：booking.py 在
  create/update/cancel/no-show/check-in/check-out 的 flush/commit 路径统一捕获
  OperationalError → rollback；仅 40P01（deadlock_detected）与 40001
  （serialization_failure）→ 409（create/update 映射 Double Booking 语义，其余映射
  各自通用冲突文案）；23P01 → 409 既有行为不变；其它任何 OperationalError
  （57014 query_canceled、无 pgcode、连接故障、库不可用等）→ 原样 re-raise，
  保持基础设施错误语义，绝不转换/吞掉。恢复「1 SUCCESS + 1 × 409」契约，
  数据完整性不变（每轮数据库 exactly 1 条）。新增 7 条 pytest（确定性映射 +
  57014/无 pgcode 原异常传播 + 事务回滚验证 + 25 轮真实并发无 500）；
  独立压测 50 轮服务层 + 50 轮 HTTP 层均 0 × 500 且每轮 exactly 1 条。

### Verified

- Backend pytest: 220 passed（202 Sprint 3 基线保留 + 11 overlap 窗口查询 + 7 D1 修复）
- Frontend Vitest: 240 passed（170 Sprint 3 基线保留 + 70 Front Desk）
- Playwright E2E: 46 passed（36 Sprint 3 基线保留 + front-desk 1 spec 10 条）
- lint / typecheck / build PASS
- Clean-environment bootstrap verified（空库 → alembic upgrade head → seed → setup users →
  FastAPI :8001 → Next.js :3001 → Full Playwright）

### Status

Sprint 4 implementation complete; D1（Fast QA Blocking）已修复；Kun Fast QA 复审 PASS（S4-D1 Re-QA：pytest 220 / Vitest 240 / Playwright 连续两轮 46 全绿；独立并发压测 100 轮 0 × 500）; v1.0.0-alpha.4 released.

## [v1.0.0-alpha.3] - 2026-08-28

### Added

- Sprint 3: Housekeeping Operations & Room Turnover（保洁运营与翻房闭环）
- HousekeepingTask 模型（Migration `77ec5f0c543e`：PG 枚举 hk_task_status / hk_task_source / hk_task_priority、Sequence housekeeping_task_no_seq、部分唯一索引 uq_housekeeping_tasks_active_room）
- Checkout 自动生成翻房任务（同一退房事务，失败整体回滚）
- Task 状态机（PENDING → IN_PROGRESS → INSPECTION → COMPLETED；INSPECTION → REWORK → IN_PROGRESS；取消）
- Task ↔ Room.cleaning_status 原子联动（与审计同事务）
- Active Task 数据库级唯一（一个 Room 至多一个进行中任务，并发创建 409）
- 手动任务创建（dirty 房间）+ 派单 / 改派 / 取消派单（GET /housekeeping/assignees 候选人端点）
- 保洁工作台 `/housekeeping` 与任务详情 `/housekeeping/[id]`；导航「保洁」
- Dashboard 保洁运营概览（待清扫 / 清扫中 / 待验房 / 返工）；Room Detail 保洁任务摘要
- Housekeeping RBAC（5 个新权限，共 31 个权限码；MANAGER 全部、FRONT_DESK read+write、HOUSEKEEPING read+work+inspect）
- Housekeeping 审计（create / assign / update / start / submit_inspection / pass / rework / cancel，无 PII）
- Check-in clean gating 保持（dirty / cleaning / inspection / rework → 409）
- Formal Playwright E2E：翻房 Golden Path / Rework 闭环 / 手动任务 / gating / 保洁 RBAC / 并发 / PII

### Verified

- Backend pytest: 202 passed（167 Sprint 2 基线保留）
- Frontend Vitest: 170 passed（139 Sprint 2 基线保留）
- Playwright E2E: 36 passed（29 Sprint 2 基线保留）
- Clean-environment bootstrap verified（空库 → alembic → seed → 全链路）

### Known Issues

（沿用既有非阻塞四项，本轮未改变）

- `/rooms/9999` returns an HTTP 200 page while the underlying BFF resource returns 404.
- Starlette/httpx TestClient deprecation warning remains.
- Playwright E2E credentials require local gitignored configuration.
- `/health` does not currently include PostgreSQL readiness checks.

### Status

Sprint 3 implementation complete; Kun Fast QA PASS（pytest 202 / Vitest 170 / Playwright 36 全绿）; `v1.0.0-alpha.3` released（Tag-only release convention）。

## [v1.0.0-alpha.2] - 2026-08-27

### Added

- Sprint 2: Booking & Stay Core Flow（预订、入住与退房核心链路）
- Guest management（创建 / 搜索 name-phone / 更新）
- Reservation（创建 / 编辑 CONFIRMED / cancel / no-show / check-in / 列表筛选与 search）
- Availability Engine（日期区间可售性，房型筛选，动态 Property Business Date Asia/Shanghai）
- Stay（check-in 创建 ACTIVE / check-out，Reservation COMPLETED 联动）
- Early Checkout（提前退房释放剩余日期）
- Booking RBAC（guest / reservation / stay 九权限，角色矩阵）
- PII protection（guest:read / reservation:read 后端裁剪 + 前端隐藏双保险）
- Booking Dashboard（今日到店 / 今日离店 / 当前在住 / 未来 7 天）与 Room Detail 集成
- Double Booking 并发保护（PostgreSQL daterange + EXCLUDE USING gist + btree_gist）
- Check-in / Check-out 原子事务
- Formal Playwright E2E（Golden Path / RBAC / PII / Concurrency / Failures / Early Checkout）

### Verified

- Backend pytest: 167 passed（87 Sprint 1 基线保留）
- Frontend Vitest: 139 passed（74 Sprint 1 基线保留）
- Playwright E2E: 29 passed（10 Sprint 1 基线保留）
- Sprint 2 Final Acceptance: PASS
- Clean-environment bootstrap verified（空库 → alembic → seed → 全链路）

### Known Issues

（沿用 Sprint 1 非阻塞四项，本轮未改变）

- `/rooms/9999` returns an HTTP 200 page while the underlying BFF resource returns 404.
- Starlette/httpx TestClient deprecation warning remains.
- Playwright E2E credentials require local gitignored configuration.
- `/health` does not currently include PostgreSQL readiness checks.

### Status

This release is an Alpha baseline and is not intended for production deployment.

## [v1.0.0-alpha.1] - 2026-08-26

### Added

- Next.js + TypeScript frontend
- FastAPI backend
- PostgreSQL database
- Alembic database migrations
- JWT authentication
- HttpOnly Cookie authentication through Next.js BFF
- RBAC role and permission system
- User management
- Role and permission management
- Room type management
- 28-room inventory
- Dual-dimensional room status model:
  - occupancy_status
  - cleaning_status
- Room status state machine
- Dashboard room overview
- Audit log system
- Vitest frontend test suite
- Playwright end-to-end test suite
- Docker PostgreSQL development environment
- Project documentation and agent development rules

### Verified

- Backend pytest: 87 passed
- Frontend Vitest: 74 passed
- Playwright E2E: 10 passed
- Clean-environment bootstrap verified
- Database migration and seed idempotency verified
- RBAC verified with multiple roles
- Failure and recovery scenarios verified
- Sprint 1 Final Acceptance: PASS

### Known Issues

- `/rooms/9999` returns an HTTP 200 page while the underlying BFF resource returns 404.
- Starlette/httpx TestClient deprecation warning remains.
- Playwright E2E credentials require local gitignored configuration.
- `/health` does not currently include PostgreSQL readiness checks.

### Status

This release is an Alpha baseline and is not intended for production deployment.
