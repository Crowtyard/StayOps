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
# 后端 pytest（独立测试库 stayops_test，87 用例）
cd backend
.venv\Scripts\python.exe -m pytest -q

# 前端单元/组件测试（Vitest，74 用例）
cd frontend
pnpm.cmd test

# Playwright E2E（独立 stayops_test 库 + 专用端口 8001/3001，10 用例；不触碰开发数据）
cd frontend
Copy-Item e2e\test-creds.example e2e\.env.test-creds   # 首次：填入测试库凭据（gitignored）
pnpm.cmd test:e2e
```

详见 [tests/README.md](tests/README.md)、[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 文档

- [PRD](docs/PRD.md) — 产品需求
- [SPRINTS](docs/SPRINTS.md) — Sprint 计划
- [ARCHITECTURE](docs/ARCHITECTURE.md) — 架构
- [DATABASE](docs/DATABASE.md) — 数据库
- [API](docs/API.md) — API 约定
- [DECISIONS](docs/DECISIONS.md) — 架构决策记录

## 开发规则

所有 AI Coding Agent 与开发者必须先阅读 [AGENTS.md](AGENTS.md)。

> 当前状态：Sprint 1 完成（T1 环境 → T2 后端认证/RBAC/双维度房态/审计 → T3a 前端核心链路 → T3b 管理页面 + Vitest/Playwright 测试体系），等待验收。
