# StayOps 架构决策记录（ADR）

> 重大架构决策记录于此。每条记录：背景、决策、后果、日期。

## 2026-08-25 — 环境准备

- 技术栈选定：Next.js + TypeScript / FastAPI + Python / PostgreSQL / Docker Compose
- 开发环境：DeepSeek Harness（DSH）web profile，插件：dshmarket、dsh-better-sidebar、dsh-turn-rewind、dsh-context、dsh-permission-rules
- 开发模型：DeepSeek V4-Pro（见 ENVIRONMENT_CHECK.md）

## 2026-08-25 — Sprint 1 第一阶段：后端骨架

1. **新增第 8 张表 `role_permissions`**：任务书列出 7 张表（users/roles/permissions/user_roles/room_types/rooms/audit_logs），但未定义「角色-权限映射」的存储位置；RBAC 映射必须持久化，故增加 `role_permissions(role_id, permission_id)` 复合主键关联表（外键 CASCADE）。后续「7 张表」的提法应理解为最小集合。
2. **权限粒度**：在任务书要求的「5 模块 × read/write/delete」15 个权限之外，增加 `room:status_cleaning`、`room:status_maintenance` 两个细粒度权限，共 17 个。理由：HOUSEKEEPING/MAINTENANCE 角色只允许变更单一房态；若复用 `room:write`（任务书 API 表约定房态变更需 room:write），将导致这两个角色获得全部房间编辑权，违反最小权限。第二阶段房态变更接口的鉴权逻辑为：持有 `room:write` 或对应的 `room:status_<new_status>` 之一即可。
3. **角色权限映射的种子同步策略**：seed 对 6 个种子角色做「精确同步」（删除多余映射、补齐缺失映射），SUPER_ADMIN 动态 = 全部权限；重复执行收敛到一致状态。
4. **`rooms.status` 使用 PostgreSQL 原生枚举** `room_status`（5 个值），初始 migration 随建表隐式创建类型，downgrade 显式 DROP TYPE。
5. **bcrypt 固定 4.0.1**：passlib 1.7.4 与 bcrypt≥4.1 存在 `__about__` 兼容性问题，requirements.txt 锁定 bcrypt==4.0.1。
6. **admin 种子密码不回写**：admin 已存在时 seed 不重置密码（尊重「首次登录后可改密」），仅确保启用与 SUPER_ADMIN 角色。
7. **配置加载**：pydantic-settings 按 (backend/.env, 仓库根 .env) 顺序查找；Alembic 连接串由 `app.config.settings` 统一提供，不在 alembic.ini 中写真实凭据。

## 2026-08-25 — Sprint 1 第二阶段：认证与业务 API

1. **房态状态机转换表**（`app/core/state_machine.py`）：available→{occupied,cleaning,maintenance,out_of_service}、occupied→{available,cleaning,out_of_service}、cleaning→{available,out_of_service}、maintenance→{available,out_of_service}、out_of_service→{available,occupied,cleaning,maintenance}；同状态不视为转换。覆盖任务书全部要求路径（available↔occupied、occupied→cleaning、cleaning→available、available↔maintenance、任何→out_of_service），非法转换返回 409。out_of_service→任意非自身状态保证「报废/停用房可恢复」，避免卡死。
2. **房态变更鉴权**（`authorize_status_change`）：持有 `room:write` 即可；否则目标为 cleaning/maintenance 时持有 `room:status_cleaning` / `room:status_maintenance` 亦可（与第一阶段决策 2 对齐）。此鉴权内联在状态接口（依赖 body 中的目标状态，无法用静态权限依赖表达）。
3. **房间 status 只能经 `POST /rooms/{id}/status` 变更**：`PUT /rooms/{id}` 的 schema 不含 status（多余字段被忽略），保证所有房态变更经过状态机+审计。
4. **分页统一**：所有列表接口（含 permissions）统一 `?page=1&page_size=20`（上限 100），返回 `{items,total,page,page_size}`；实现集中在 `app/core/pagination.py`。
5. **登录也写审计**：login 成功/失败（含原因）均写 audit_logs（含 IP），失败记录 username 但绝不记录密码；失败审计需在抛异常前显式 commit（否则随会话回滚丢失）。
6. **敏感信息防护**：用户/角色等审计 details 只存变更摘要；改密审计记为 `password_hash: 已更新`，不落哈希；响应模型不含 password_hash。
7. **自我保护规则**：禁止删除/禁用当前登录用户（400），防止锁死系统；删除用户后其历史审计 user_id 置空（FK SET NULL）但记录保留。
8. **测试库策略**：pytest 使用独立库 `stayops_test`（环境变量 `TEST_DATABASE_URL` 可覆盖，须在导入 app.* 前设置 `DATABASE_URL`）；会话开始 DROP/CREATE（WITH FORCE）+ `alembic upgrade head` + 幂等 seed；用例级用「单连接 + 外层事务 + savepoint 会话（join_transaction_mode=create_savepoint）」隔离并统一回滚，不重建库、不重复 hash 管理员密码。
9. **Decimal 序列化**：`base_price` 经 Pydantic v2 序列化为 JSON 字符串（如 `"328.00"`），规避浮点精度问题；已写入 docs/API.md 约定。
10. **无自助改密接口**：任务书 API 表未包含改密端点；管理员可通过 `PUT /users/{id}` 传 `password` 字段改密（bcrypt 重哈希），普通用户改密能力留待后续 Sprint 评估。
11. **CORS**：main.py 允许 `http://localhost:3000` / `http://127.0.0.1:3000`（本地 Next.js 前端联调）。
12. **依赖版本事实**：已装 starlette 1.6.0 + httpx 0.28.1（TestClient 有 StarletteDeprecationWarning，功能正常，暂不处理）；`request.client` 为 `Address` 对象，audit 取 IP 时经 `.host` 兼容。

## 2026-08-26 — 房态架构修正：单状态拆双维度

1. **背景**：`rooms.status` 单枚举（available/occupied/cleaning/maintenance/out_of_service）把占用状态与清洁状态混在一列，无法表达「已预订但待清扫」（reserved + dirty）等现实组合，不符合原始设计。
2. **决策**：拆为两个独立 PG 枚举列（Migration `9e3f9d00338c`）：
   - `occupancy_status`：available / reserved / occupied / blocked / out_of_service
   - `cleaning_status`：clean / dirty / cleaning / inspection / rework
   - 旧数据映射：available→(available,clean)、occupied→(occupied,dirty)、cleaning→(available,cleaning)、maintenance→(out_of_service,dirty)、out_of_service→(out_of_service,dirty)；随后删除旧列并 DROP TYPE room_status。
3. **状态机**：拆为两个独立转换表（`app/core/state_machine.py`），API 按维度分别校验，非法转换 409；两个维度互不约束（reserved+dirty 组合合法）。
4. **鉴权细化**（`authorize_status_change`）：持有 `room:write` 可改任意维度；HOUSEKEEPING 仅可改清洁维度（`room:status_cleaning`）；MAINTENANCE 仅可把占用状态置为 out_of_service（`room:status_maintenance`，恢复需 room:write）；无 room:write 时不允许同时改两个维度。符合最小权限原则。
5. **API 变更**：`GET /rooms` 筛选参数改为 `occupancy_status` / `cleaning_status`；`POST /rooms/{id}/status` body 支持 `occupancy_status?` / `cleaning_status?`（至少提供一个）；审计 details 按维度记录 from/to。

## 2026-08-26 — 项目工作目录调整

项目工作目录由 `D:\MY SELF\StayOps` 调整为 `D:\MY SELF\StayOps V1.0`。
目的：明确当前项目处于 V1.0 开发周期。
代码内部技术标识仍使用 `stayops`（Python 包名、PostgreSQL 库名、Docker service/container 名、Git 标识均不变），
避免把版本号耦合进包名、数据库名和服务名。
配套处理：docker-compose.yml 固定 `name: stayops`（防止目录名变化导致 compose 项目名变化、容器重建）；
venv 因启动器硬编码旧路径而重建；requirements.txt 统一为 UTF-8 编码。
