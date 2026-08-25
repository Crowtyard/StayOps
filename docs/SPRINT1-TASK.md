# Sprint 1 任务书（由 DSH Agent 执行）

> 本文件是 StayOps Sprint 1 的正式任务上下文。执行前必须先阅读：
> `AGENTS.md`、`docs/PRD.md`、`docs/SPRINTS.md`、`docs/ARCHITECTURE.md`、`docs/DECISIONS.md`、`docs/ENVIRONMENT_CHECK.md`

## 任务目标

完成 StayOps Sprint 1：登录、用户、角色、RBAC 权限、房型、房间、Audit Log。
不允许开发 Sprint 1 之外的功能（保洁/维修/库存/经营分析等属于后续 Sprint）。

## 技术栈（已确认可用）

- Frontend: Next.js (16.x) + TypeScript，包管理 pnpm
- Backend: FastAPI + Python 3.11，SQLAlchemy 2.x + Alembic，venv 在 `backend/.venv`
- Database: PostgreSQL 16（`docker compose up -d postgres` 已运行，healthy）
  - 连接：`postgresql://stayops:change-me@localhost:5432/stayops`（见 `.env`）
- 部署骨架：`docker-compose.yml`（postgres 已配置，backend/frontend 服务注释待启用）

## 目录结构约定

```text
StayOps/
├── backend/          # FastAPI 后端（Sprint 1 主体）
├── frontend/         # Next.js 前端
├── docs/             # 文档
├── tests/            # 端到端测试（可选）
├── docker-compose.yml
└── .env / .env.example
```

## 数据库设计（Sprint 1 七张表）

| 表 | 关键字段 |
|---|---|
| users | id, username(unique), password_hash, display_name, email, phone, is_active, created_at, updated_at |
| roles | id, name(unique), description, created_at, updated_at |
| permissions | id, code(unique), name, description |
| user_roles | user_id, role_id（复合主键，外键级联） |
| room_types | id, name(unique), base_price(Numeric), capacity, description, created_at, updated_at |
| rooms | id, room_number(unique), room_type_id(FK), floor, status(enum), notes, created_at, updated_at |
| audit_logs | id, user_id(FK, nullable), action, resource_type, resource_id, details(JSONB), ip, created_at |

- `rooms.status` 枚举：`available` / `occupied` / `cleaning` / `maintenance` / `out_of_service`（后端验证合法转换）
- 所有 Schema 变更必须走 Alembic Migration（禁止直接改表）
- 密码必须 bcrypt/argon2 哈希，禁止明文；日志禁止输出密码/Token

## 种子数据（Migration 或 seed 脚本，必须可重复执行）

1. 权限（permissions）：模块 × 操作，至少覆盖：user / role / room / room_type / audit 的 read / write / delete
2. 角色（roles）+ 角色-权限映射：
   - SUPER_ADMIN（全部权限）
   - MANAGER（user/room/room_type/audit 读写 + role 读）
   - FRONT_DESK（room 读写、room_type 读、audit 读）
   - HOUSEKEEPING（room 读 + 状态 cleaning 变更）
   - MAINTENANCE（room 读 + 状态 maintenance 变更）
   - FINANCE（audit 读、room 读）
3. 管理员用户：username=`admin`，密码 `Admin@123456`（首次登录后应可改密；写死在文档中仅用于开发环境）
4. **28 个测试房间**：按房型分布（如 标准大床房/标准双床房/豪华大床房/豪华套房 等 4-6 种房型），房间号如 101-110、201-210、301-308（或类似），floor 与房间号对应

## 后端 API（前缀 /api/v1，JSON，JWT 认证）

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| POST | /auth/login | 登录，返回 access_token | 公开 |
| GET | /auth/me | 当前用户信息+权限 | 登录 |
| GET/POST | /users | 用户列表/创建 | user:read / user:write |
| GET/PUT/DELETE | /users/{id} | 用户详情/更新/删除 | user:* |
| POST | /users/{id}/roles | 分配角色 | user:write |
| GET/POST | /roles | 角色列表/创建 | role:read / role:write |
| GET/PUT/DELETE | /roles/{id} | 角色详情/更新/删除 | role:* |
| POST | /roles/{id}/permissions | 设置角色权限 | role:write |
| GET | /permissions | 权限列表 | role:read |
| GET/POST | /room-types | 房型列表/创建 | room_type:read / room_type:write |
| GET/PUT/DELETE | /room-types/{id} | 房型详情/更新/删除 | room_type:* |
| GET/POST | /rooms | 房间列表(分页+状态筛选)/创建 | room:read / room:write |
| GET/PUT/DELETE | /rooms/{id} | 房间详情/更新/删除 | room:* |
| POST | /rooms/{id}/status | 房态变更（记录 audit_log） | room:write |
| GET | /audit-logs | 审计日志列表（分页、按操作/用户筛选） | audit:read |

- 权限不足返回 403；未认证返回 401
- 所有写操作记录 audit_log（action=操作名, resource_type/resource_id, details=变更摘要, ip）
- 分页统一 `?page=1&page_size=20`，返回 `{items, total, page, page_size}`

## 前端（Next.js + TypeScript）

页面：
1. `/login` — 登录页（调 /auth/login，存 token）
2. `/` — 布局（侧边导航：用户、角色、房型、房间），首页简单欢迎+当前用户信息
3. `/users` — 用户列表/创建/分配角色
4. `/roles` — 角色列表/创建/权限分配
5. `/room-types` — 房型列表/创建/编辑
6. `/rooms` — 房间列表（状态筛选）/创建/编辑/房态变更

要求：
- API client 封装（fetch，带 token 拦截器，401 跳登录）
- 前端隐藏按钮不算权限控制（权限在后端强制），但可按用户权限隐藏入口
- 使用 Tailwind 或 CSS Modules（自选，保持简洁一致）

## 验收标准

1. `backend`：`pytest` 全部通过（至少覆盖：登录成功/失败、无 token 401、权限不足 403、用户 CRUD、角色 CRUD、房间 CRUD、房态变更合法/非法转换、audit_log 写入）
2. `alembic upgrade head` 可从空库构建 schema；seed 可重复执行（幂等）
3. `frontend`：`pnpm build` 通过；登录→各页面可用
4. 端到端：docker compose 起来后，admin 登录 → 查看 28 房间 → 变更一个房间状态 → audit_logs 出现记录
5. 不把 `.env` 提交；README 保持可用

## 约束（AGENTS.md 摘要）

- 严格按 Sprint 开发，不提前开发未来 Sprint
- 数据库修改必须 Migration；不直接改生产库（本机开发库=compose 的 postgres，可重建）
- 业务权限后端验证；状态机后端验证合法转换
- 每次完成运行相应测试；不删除失败测试；不 hardcode 假数据
- 完成后报告：修改文件、主要实现、数据库变化、API 变化、测试命令、测试结果、已知问题

## 环境提示（ENVIRONMENT_CHECK.md 摘要）

- pnpm/npm 需用 `.cmd` 后缀（PowerShell 执行策略）
- Python 用 `python`（3.11.9），venv 建议 `backend/.venv`
- postgres 已运行：`docker compose up -d postgres`（health check OK）
- 数据库重建：`docker compose down -v && docker compose up -d postgres`
