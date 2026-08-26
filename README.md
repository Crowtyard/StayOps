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

后端（`backend/`，Sprint 1 进行中）：

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

前端质量命令：`pnpm.cmd lint`、`pnpm.cmd typecheck`、`pnpm.cmd build`。

## 文档

- [PRD](docs/PRD.md) — 产品需求
- [SPRINTS](docs/SPRINTS.md) — Sprint 计划
- [ARCHITECTURE](docs/ARCHITECTURE.md) — 架构
- [DATABASE](docs/DATABASE.md) — 数据库
- [API](docs/API.md) — API 约定
- [DECISIONS](docs/DECISIONS.md) — 架构决策记录

## 开发规则

所有 AI Coding Agent 与开发者必须先阅读 [AGENTS.md](AGENTS.md)。

> 当前状态：Sprint 1 后端（骨架 + 认证 + RBAC + 房态双维度状态机 + 审计）已完成；前端 T3a（登录/首页概览/房态棋盘/房间详情 + BFF 认证链路）已完成；T3b（用户/角色/房型/审计管理页面）待开发。
