# StayOps

精品住宿智能运营系统 —— 面向济南历下区 CBD 中高端住宿项目（约 28 间客房）的内部运营管理系统。

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
- 前端（`frontend/`）：Sprint 1 待实现

## 文档

- [PRD](docs/PRD.md) — 产品需求
- [SPRINTS](docs/SPRINTS.md) — Sprint 计划
- [ARCHITECTURE](docs/ARCHITECTURE.md) — 架构
- [DATABASE](docs/DATABASE.md) — 数据库
- [API](docs/API.md) — API 约定
- [DECISIONS](docs/DECISIONS.md) — 架构决策记录

## 开发规则

所有 AI Coding Agent 与开发者必须先阅读 [AGENTS.md](AGENTS.md)。

> 当前状态：Sprint 1 第一阶段（后端骨架 + 数据层 + 种子数据）已完成，业务 API 与前端待第二阶段。
