# StayOps V1.0

```text
Product:                  StayOps
Current Development Version: V1.0
```

精品住宿智能运营系统 —— 面向济南历下区 CBD 中高端住宿项目（约 28 间客房）的内部运营管理系统。
（代码内部技术标识仍为 `stayops`：包名/数据库名/服务名不携带版本号。）

## 技术栈

- Frontend: Next.js + TypeScript
- Backend: FastAPI + Python
- Database: PostgreSQL
- Deployment: Docker Compose

## 快速开始（开发环境）

```bash
# 1. 准备环境变量
cp .env.example .env

# 2. 启动 PostgreSQL（需 Docker）
docker compose up -d postgres
```

后端（`backend/`，Sprint 1 已完成）：

```powershell
cd backend
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe -m alembic upgrade head
.venv\Scripts\python.exe -m app.seed          # 幂等种子数据
.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8000
```

- 健康检查：`http://localhost:8000/health`
- 开发管理员：`admin` / `Admin@123456`（仅开发环境）

前端（`frontend/`，Next.js 16 + TypeScript strict + Tailwind；认证采用 HttpOnly Cookie + BFF，详见 [docs/DECISIONS.md](docs/DECISIONS.md)）：

```powershell
cd frontend
pnpm.cmd install
Copy-Item .env.example .env.local   # BACKEND_API_URL / NEXT_PUBLIC_APP_NAME
pnpm.cmd dev                        # http://localhost:3000
```

> 前后端需分别启动；后端需先运行在 `http://127.0.0.1:8000`（见上文）。前端不接触 Token：登录后 JWT 只存在 HttpOnly Cookie，其余 API 统一走 `/api/bff/*` 由服务端附加 Bearer 转发。

前端质量命令：`pnpm.cmd lint`、`pnpm.cmd typecheck`、`pnpm.cmd test`（Vitest）、`pnpm.cmd build`。

## 测试

```powershell
# 后端 pytest（独立测试库 stayops_test，202 用例 = 87 基线 + 76 Booking + 4 严格 PATCH + 35 Housekeeping）
cd backend
.venv\Scripts\python.exe -m pytest -q

# 前端单元/组件测试（Vitest，170 用例 = 74 基线 + 65 Booking UI + 31 Housekeeping UI）
cd frontend
pnpm.cmd test

# Playwright E2E（独立 stayops_test 库 + 专用端口 8001/3001，36 用例 = Sprint 1 基线 10 + S2-T3 新增 19 + S3 新增 7；不触碰开发数据）
cd frontend
Copy-Item e2e\test-creds.example e2e\.env.test-creds   # 首次：填入测试库凭据（gitignored）
pnpm.cmd test:e2e
```

> pytest 与 Playwright E2E 共享 `stayops_test` 库且互斥，两者不得并行运行。
> E2E 覆盖（S2-T3）：Golden Path（预订→重叠 409→当天入住/退房→审计无 PII）、
> Early Checkout（COMPLETED 释放剩余日期）、Booking RBAC、PII 三层防护（HOUSEKEEPING）、
> 并发专项（Double Booking / 并发 Check-in / Check-out 各 1 SUCCESS + 1 × 409）、
> 失败处理（409/404/401 语义）。
> E2E 覆盖（S3）：翻房 Golden Path（退房自动任务 → 派单 → 清扫链 → 通过 → 下一笔入住成功）、
> Rework 闭环、手动任务与取消、Check-in clean gating、保洁 RBAC / 并发 / PII；
> 详见 [frontend/e2e/README.md](frontend/e2e/README.md)。

详见 [tests/README.md](tests/README.md)、[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 预订运营（Sprint 2 · S2-T2）

- 页面：`/reservations`（列表/筛选/分页）、`/reservations/new`（Guest 搜索创建 + Availability 选房）、`/reservations/[id]`（CONFIRMED 编辑、Cancel / No-show / Check-in）、`/stays`（在住列表）、`/stays/[id]`（Check-out）
- 扩展：`/dashboard`（今日到店 / 今日离店 / 当前在住 / 未来 7 天预订）、`/rooms/[id]`（当前 Stay / 下一笔预订）
- 导航按权限显示：`reservation:read` → 预订、`stay:read` → 在住；HOUSEKEEPING 等角色不可见且直连 403
- 业务日期统一 Asia/Shanghai；日期区间 `[check_in_date, check_out_date)`；409/422 展示后端原文

## 保洁运营（Sprint 3）

- 页面：`/housekeeping`（保洁运营工作台：待清扫/清扫中/待验房/返工/已完成状态视图、任务卡片、快捷操作、新建任务）、`/housekeeping/[id]`（任务详情：派单/优先级/备注 + 操作确认）
- 退房自动生成翻房任务（同一事务）：`Check-out → Task PENDING → 派单 → 开始清扫 → 提交验房 → 通过/返工 → COMPLETED + Room clean`，下一笔预订即可入住
- Active Task 数据库级唯一（部分唯一索引）；Task 状态与 Room.cleaning_status 原子联动
- 导航按权限显示：`housekeeping_task:read` → 保洁；RBAC：MANAGER 全部、FRONT_DESK read+write、HOUSEKEEPING read+work+inspect
- 任务不保存任何 Guest PII；Check-in 要求 `cleaning_status = clean`（dirty/cleaning/inspection/rework → 409）

## 文档

- [PRD](docs/PRD.md) — 产品需求
- [SPRINTS](docs/SPRINTS.md) — Sprint 计划
- [ARCHITECTURE](docs/ARCHITECTURE.md) — 架构
- [DATABASE](docs/DATABASE.md) — 数据库
- [API](docs/API.md) — API 约定
- [DECISIONS](docs/DECISIONS.md) — 架构决策记录

## 开发规则

所有 AI Coding Agent 与开发者必须先阅读 [AGENTS.md](AGENTS.md)。

> 当前状态：Sprint 1 完成并冻结（v1.0.0-alpha.1）；Sprint 2 完成（Booking & Stay Core Flow），Final Acceptance PASS；
> Sprint 3 完成（Housekeeping Operations & Room Turnover：退房自动翻房任务 / 派单 / 清扫链 / 返工闭环 / 保洁工作台 / 保洁 RBAC / 并发安全），
> Kun Fast QA PASS，v1.0.0-alpha.3 已发布。

## Current Release

Version: v1.0.0-alpha.3

Status: Sprint 3 Fast QA PASS

This is the third stable Alpha development baseline of StayOps（Housekeeping Operations & Room Turnover）。

Sprint 3 implementation complete; Kun Fast QA PASS（pytest 202 / Vitest 170 / Playwright 36 全绿）; v1.0.0-alpha.3 released.

Not intended for production deployment.
