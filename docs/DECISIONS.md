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

## 2026-08-26 — Sprint 1 第三阶段 T3a：前端核心链路

1. **前端技术栈**：Next.js 16.3（App Router，Turbopack）+ TypeScript strict + Tailwind CSS 4；包管理 pnpm（Windows 用 `pnpm.cmd`）。状态管理不引入 Redux/MobX（React 状态 + Server/Client Components）；UI 全部手写 Tailwind 组件 + 内联 SVG 图标，不引入任何组件库/图标库（保持最小依赖，规避供应链风险）。
2. **认证方案：HttpOnly Cookie + BFF**。后端只发 Bearer JWT；浏览器不接触 Token。`POST /api/auth/login` 转发登录并把 `access_token` 写入 Cookie `stayops_token`（httpOnly / sameSite=lax / path=/ / maxAge=expires_in；生产 secure=true）；`GET /api/auth/me` 读 Cookie 直连后端校验；`POST /api/auth/logout` 仅清 Cookie（JWT 无状态，后端无注销端点）。其余请求统一走 `app/api/bff/[...path]/route.ts` 通用代理：服务端读 Cookie 附加 `Authorization: Bearer`，透传状态码与 FastAPI `detail`。禁止 localStorage 存 JWT、console 打印 Token、NEXT_PUBLIC_ 携带密钥（`BACKEND_API_URL` 为服务端专用，无 NEXT_PUBLIC 前缀）。
3. **BFF 代理细节**：`/api/bff/*` 转发 `X-Forwarded-For` 首段（后端审计记录真实客户端 IP）；后端不可达统一返回 502 `{"detail":"服务暂时不可用，请稍后重试"}`；前端错误归一化把 502/503 归为 `network` 类（显示“服务暂时不可用”+ 重新加载），401/403/404/409/422/5xx 各自映射可读文案（409 直接展示后端状态机错误文案）。
4. **登录守卫**：受保护路由置于 `(main)` 路由组，其 layout 为服务端组件——读 Cookie 直连 `/api/v1/auth/me` 校验（未登录/禁用 → 307 跳 /login；后端不可达 → 渲染“离线”壳并允许页面展示错误+重试，不强制跳转）。未使用 middleware/proxy（避免边缘运行时额外网络调用与复杂度）；401 前端清状态跳 /login，403 显示“无权限”，二者不混淆。
5. **T3b 页面导航策略**：侧边导航按 `auth/me` 权限动态显示 首页/房态/房型/用户/角色与权限/审计日志（不显示保洁/维修/库存/采购/经营分析）；房型/用户/角色与权限/审计日志页面在 T3b 实现，导航入口带“T3b”角标、点击落到友好占位页（`not-found.tsx` 区分提示），不在 T3a 提前实现。
6. **状态机不复制到前端**：前端不在代码里复制转换表（单一事实源在后端），非法转换直接显示后端 409 `detail`；blocked/out_of_service 变更前用确认对话框（可 Esc/遮罩关闭）。
7. **字体**：不使用 `next/font/google`（构建期网络下载有失败风险；中文回退本就走系统字体），采用系统字体栈（含 PingFang SC / 微软雅黑）。
8. **首页概览口径**：全部统计来自真实 `GET /rooms`（page_size=100）实时计算——总房/可售/已预订/在住/锁房/停用（占用维度）+ 待清扫/清扫中/待检查（清洁维度）；禁止伪造营业额/ADR/RevPAR。
9. **房态筛选**：占用/清洁/房型走后端查询参数（后端筛选优先）；楼层后端无筛选参数，客户端过滤（28 间房一次拉全量）。
10. **路由类型**：启用 Next 16 typed routes（`next typegen` 生成 `PageProps`/`LayoutProps`），`tsc --noEmit` 全量校验；`/rooms/[id]` 动态渲染 + 客户端按 id 重新挂载（`key={id}`），刷新不 404。
