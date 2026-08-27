# Changelog

All notable changes to StayOps will be documented in this file.

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
