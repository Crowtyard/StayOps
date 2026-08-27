# Changelog

All notable changes to StayOps will be documented in this file.

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
