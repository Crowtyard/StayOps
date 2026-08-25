# StayOps Backend

FastAPI + SQLAlchemy 2.x + Alembic + PostgreSQL 后端（Sprint 1）。

## 技术栈

- Python 3.11（venv：`backend/.venv`）
- FastAPI + Uvicorn
- SQLAlchemy 2.x + psycopg2
- Alembic（Schema 变更必须走 Migration）
- passlib(bcrypt)（密码哈希）、python-jose（JWT）

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

# 测试（自动创建/重建独立测试库 stayops_test，无需手动建库）
.venv\Scripts\python.exe -m pytest -v
```

- 配置：环境变量 > `.env`（后端目录或仓库根）> `app/config.py` 默认值
- 健康检查：`GET http://localhost:8000/health`
- 交互文档：`GET http://localhost:8000/docs`
- 开发管理员：`admin` / `Admin@123456`（仅开发环境，首次登录后可改密）
- API 完整说明见 `docs/API.md`

## 测试说明

- 测试库：`postgresql://stayops:change-me@localhost:5432/stayops_test`（可通过环境变量 `TEST_DATABASE_URL` 覆盖；pytest 会话开始时会 DROP/CREATE 该库并执行 `alembic upgrade head` + 幂等 seed）
- 隔离：每个用例在单连接外层事务 + savepoint 会话中运行，结束统一回滚，用例互不污染
- 覆盖：登录成功/失败、401/403、用户 CRUD+分配角色、角色 CRUD+权限分配、权限列表、房型 CRUD、房间 CRUD+筛选、房态合法/非法转换、audit_log 写入与筛选、admin 端到端冒烟（`tests/test_smoke.py`）

## 目录结构

```text
backend/
├── app/
│   ├── main.py          # FastAPI 入口（挂载 /api/v1 + CORS + /health）
│   ├── config.py        # pydantic-settings 配置
│   ├── database.py      # engine / SessionLocal / get_db
│   ├── api/             # 路由与依赖（deps.py: 认证/RBAC）
│   │   └── routes/      # auth/users/roles/permissions/room-types/rooms/audit-logs
│   ├── core/            # security(JWT/bcrypt)、audit、state_machine、pagination
│   ├── models/          # SQLAlchemy 模型（8 张表）
│   ├── schemas/         # Pydantic 请求/响应模型
│   └── seed.py          # 幂等种子脚本：python -m app.seed
├── tests/               # pytest 套件（独立测试库）
├── alembic/             # Migration（alembic.ini 在 backend/）
├── requirements.txt
└── .venv/               # 虚拟环境（git 忽略）
```

## 数据库表

`users`、`roles`、`permissions`、`user_roles`、`role_permissions`、`room_types`、`rooms`、`audit_logs`（`role_permissions` 为任务书 7 张表之外的必要补充，见 `docs/DECISIONS.md`）。

## 约定

- 所有 Schema 修改必须新增 Alembic Migration，禁止直接改表
- 密码仅存 bcrypt 哈希；日志/响应禁止输出密码、Token
- 业务权限在后端强制（401 未认证 / 403 权限不足），前端隐藏按钮不算权限控制
- `rooms.status` 合法值：available / occupied / cleaning / maintenance / out_of_service；状态机转换在后端校验，非法转换 409（转换表见 `docs/API.md`）
- 所有写操作（含登录）记录 audit_logs，含 IP
- 分页统一 `?page=1&page_size=20`，返回 `{items,total,page,page_size}`
