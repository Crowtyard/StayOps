# Changelog

All notable changes to StayOps will be documented in this file.

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
