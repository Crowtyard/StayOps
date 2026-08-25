# StayOps Backend

FastAPI + SQLAlchemy 2.x + Alembic + PostgreSQL 后端（Sprint 1）。

## 技术栈

- Python 3.11（venv：`backend/.venv`）
- FastAPI + Uvicorn
- SQLAlchemy 2.x + psycopg2
- Alembic（Schema 变更必须走 Migration）
- passlib(bcrypt)（密码哈希）、python-jose（JWT，第二阶段使用）

## 本地开发

```powershell
# 0. 前置：PostgreSQL 已启动（仓库根目录）
docker compose up -d postgres

# 1. 创建 venv 并安装依赖（Python 3.11.9）
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt

# 2. 数据库迁移
.venv\Scripts\python.exe -m alembic upgrade head

# 3. 种子数据（幂等，可重复执行）
.venv\Scripts\python.exe -m app.seed

# 4. 启动服务
.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8000

# 测试
.venv\Scripts\python.exe -m pytest -v
```

- 配置：环境变量 > `.env`（后端目录或仓库根）> `app/config.py` 默认值
- 健康检查：`GET http://localhost:8000/health`
- 开发管理员：`admin` / `Admin@123456`（仅开发环境，首次登录后可改密）

## 目录结构

```text
backend/
├── app/
│   ├── main.py          # FastAPI 入口（业务路由在 Sprint 1 第二阶段）
│   ├── config.py        # pydantic-settings 配置
│   ├── database.py      # engine / SessionLocal / get_db
│   ├── models/          # SQLAlchemy 模型（8 张表）
│   ├── schemas/         # Pydantic schemas（第二阶段填充）
│   └── seed.py          # 幂等种子脚本：python -m app.seed
├── alembic/             # Migration（alembic.ini 在 backend/）
├── requirements.txt
└── .venv/               # 虚拟环境（git 忽略）
```

## 数据库表

`users`、`roles`、`permissions`、`user_roles`、`role_permissions`、`room_types`、`rooms`、`audit_logs`（`role_permissions` 为任务书 7 张表之外的必要补充，见 `docs/DECISIONS.md`）。

## 约定

- 所有 Schema 修改必须新增 Alembic Migration，禁止直接改表
- 密码仅存 bcrypt 哈希；日志禁止输出密码/Token
- `rooms.status` 合法值：available / occupied / cleaning / maintenance / out_of_service，状态机转换校验在 API 层
- 所有写操作记录 audit_logs（第二阶段实现）
