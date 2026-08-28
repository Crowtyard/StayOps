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

## 2026-08-26 — Sprint 1 第三阶段 T3b：管理页面与测试体系

1. **管理页结构**：四个设置页视图放 `components/settings/`，共享工具（`usePageFetch` 分页加载、403/网络/可重试错误归一化、表单字段、表格外壳）放 `components/settings/shared.tsx`；通用表单对话框 `components/modal.tsx`（Esc/遮罩/右上角关闭）。列表接口一律 `page_size=100` 一次拉全量（本项目规模 ~28 房 / 个位数员工，暂不做前端分页 UI；审计页展示“共 N 条，显示前 N 条”）。
2. **403 语义**：设置页加载遇 403 → 渲染 Forbidden「无权限访问该页面」且不跳登录；401 → 跳 /login（与 T3a 决策 4 的 401/403 区分一致）。权限判定唯一裁决点在后端（前端按钮显隐仅改善 UI）。
3. **用户管理**：创建用户时角色经 `POST /users/{id}/roles` 二次分配（后端 `UserCreate` 无角色字段，严格按现有 OpenAPI 能力，未扩展后端）；编辑时密码留空 = 不修改；对当前登录用户禁用「停用/删除」按钮（后端 400 自我保护兜底）；未持有 role:read 时隐藏角色分配区块（分配按钮仍可用则仅更新基础信息）。
4. **角色权限修改**：按 `role:write` 显隐「查看 / 修改权限」；`GET /permissions` 全量勾选 + `POST /roles/{id}/permissions` 整体替换（与后端“空=清空”语义一致）；SUPER_ADMIN 的动态全权限由后端保证，前端不特殊处理。
5. **审计页**：表格列 = 时间/操作人/Action/Resource/IP，details 点「详情」展开为格式化 JSON 子行（不整块 JSON 塞表格单元格）；筛选 = 操作类型（action）+ 资源类型（resource_type）下拉，选项来自当前已加载数据出现的值（与后端精确匹配参数一致）；user_id 筛选未在 UI 暴露（无对应选择控件需求，API 保留）。
6. **Vitest 基础设施**：jsdom + @testing-library/react + @vitejs/plugin-react；配置 `vitest.config.mts`（ESM 原生加载，规避 Vitest 4 对 CJS 加载 ESM 配置的告警）；`@/*` 别名用 `resolve.alias` 手写，不引入 vite-tsconfig-paths；测试与源码同目录（`src/**/__tests__/*.test.ts(x)`），随 `tsc --noEmit` 一起强类型校验；`src/test/setup.ts` 引入 jest-dom + RTL cleanup。API 层用 `vi.mock` 部分替换（`importOriginal` 保留真实 `ApiError` 类与类型），`next/navigation`/`next/link` 按文件 mock；`UserContext` 从 app-shell 导出供测试注入用户。
7. **Playwright E2E 隔离（不碰 dev 数据）**：独立测试库 `stayops_test` + 专用后端 `127.0.0.1:8001` + 前端 `localhost:3001`。后端 webServer 直接运行单进程入口 `e2e/run_test_backend.py`：先执行 `prepare_test_db.py`（DROP/CREATE → alembic upgrade → 幂等 seed，与 pytest conftest 同策略），随后在本进程内 `uvicorn.run`（不经过 `.cmd` 包装，避免产生 Playwright 无法回收的孤儿进程导致下次运行被 prepare DROP 掉连接）；前端 `node node_modules/next/dist/bin/next dev -p 3001` 以 `NEXT_DIST_DIR=.next-e2e` 隔离构建目录（next.config.ts 读取该环境变量，默认仍 `.next`）；`reuseExistingServer: false` 保证每次运行都是全新实例 + 全新测试库（避免复用陈旧进程导致用例不确定）。E2E 测试账号（FRONT_DESK / HOUSEKEEPING）由 `e2e/setup-users.ts` 在测试 `beforeAll` 中以 admin 直连后端幂等创建（放在 beforeAll 而非 globalSetup，规避 globalSetup 与 webServer 的启动顺序竞态）；凭据只存 gitignored `e2e/.env.test-creds`（模板 `test-creds.example`，配置加载时注入 worker 环境变量）；`workers=1` 串行执行保证共享测试库确定性。
8. **E2E 与 pytest 共用 stayops_test 且互斥**：两者会话开始时都会 DROP/CREATE 该库，因此禁止并行运行（实测并行会互相打断并造成 E2E 误失败）。本地并行执行测试时应错开。
9. **next dev 自动改 tsconfig**：E2E dev server（NEXT_DIST_DIR=.next-e2e）首次运行会把 `.next-e2e/**` 类型路径写入 tsconfig include（与 `.next/**` 同理），该改动保留以支持 E2E 目录下的 typed routes 类型生成；eslint 与 .gitignore 同步忽略 `.next-e2e/`。
10. **依赖版本事实（前端测试）**：Vitest 4.1.11 / @playwright/test 1.62.1（浏览器 chromium-1234 已本地安装）/ jsdom 30（要求 Node ≥ 22，本项目 Node 24 满足）。

## 2026-08-26 — Sprint 2 S2-T1：Booking Domain Foundation

1. **Reservation / Stay 分离，一个 Reservation 至多一个 Stay**。背景：Reservation = 未来住宿计划，Stay = 实际入住事实，二者生命周期不同（取消/未到店只影响 Reservation；退房只影响 Stay）。决策：两个独立模型，`stays.reservation_id` UNIQUE 约束 + Check-in 事务内状态校验（SELECT FOR UPDATE 后仅 CONFIRMED → CHECKED_IN 才创建 Stay）双保险。后果：数据模型与状态机各成体系，历史可追溯（提前退房后 Reservation=COMPLETED、Stay=CHECKED_OUT 各自保留）。

2. **未来 Reservation 不修改 Room 当前房态（解耦）**。背景：`occupancy_status` 只描述现场状态；把未来预订提前置 `reserved` 会与现场事实冲突且随日期漂移。决策：创建/修改 Reservation 不触碰 `rooms.occupancy_status`；未来可售性完全由 Reservation 日期区间 + Availability Engine 决定。后果：可售性与现场状态两个维度独立，WALK_IN/提前到店改期流程简单。

3. **日期区间统一 `[check_in_date, check_out_date)`**。含入住日、不含退房日；紧邻允许（8/30→9/1 与 9/1→9/3 共存）、重叠禁止；`check_out_date <= check_in_date` → 422。数据库排他约束用 `daterange(..., '[)')` 与业务语义完全一致。

4. **Double Booking 数据库级最终仲裁：daterange + EXCLUDE USING gist + btree_gist + 部分约束**。背景：应用层 `SELECT → 判断 → INSERT` 存在竞态窗口，不能作为最终保护。决策：`EXCLUDE USING gist (room_id WITH =, daterange(check_in_date, check_out_date, '[)') WITH &&) WHERE (status NOT IN ('CANCELLED','NO_SHOW','COMPLETED'))`；`room_id WITH =` 需要 `CREATE EXTENSION btree_gist`。部分约束只作用于仍占用日期区间的 CONFIRMED / CHECKED_IN，CANCELLED / NO_SHOW / COMPLETED 自动从索引移除（提前退房释放剩余日期，REV-01）。应用层预检（Availability）仅为快速失败与友好报错。后果：并发 Double Booking 必然 1 SUCCESS + 1 CONFLICT；排他约束冲突（psycopg2 pgcode `23P01`）在 service 层统一映射为 409「该房间在所选日期区间已被预订」，不泄漏 500。

5. **Reservation `COMPLETED` 状态仅由 Stay Check-out 事务触发（REV-01）**。状态机转换表保留 `CHECKED_IN → COMPLETED` 边，但 reservations 路由绝不提供任何 Update / Action 端点写 COMPLETED；唯一写点位于 `app/services/booking.py::check_out_stay` 的同一数据库事务内。后果：任何普通 API 无法手工把 Reservation 置为 COMPLETED，状态一致性有保证。

6. **Check-in / Check-out 事务化**。Check-in 单事务：Reservation CONFIRMED→CHECKED_IN + Stay CREATE ACTIVE + Room occupancy→occupied + Audit `reservation.check_in`；Check-out 单事务：Stay ACTIVE→CHECKED_OUT + Reservation CHECKED_IN→COMPLETED + Room occupancy→available + Room cleaning→dirty + Audit `stay.check_out`。任一步失败全部回滚（service 层 catch HTTPException → rollback 后重抛；IntegrityError → rollback → 409）。并发用 `SELECT ... FOR UPDATE` 串行化 + 状态校验 + `stays.reservation_id` 唯一约束。后果：pytest 显式构造审计写入失败验证无半状态；并发 Check-in / Check-out 均 1 SUCCESS + 1 CONFLICT。

7. **PII / 权限边界（REV-02 / REV-FINAL-04）**。`guest:read` 门控 Guest 身份/联系方式（name/phone/email/Guest notes）；`reservation:read` 门控 Reservation 数据（reservation_no、日期、房号/房型、source、status、agreed_total_amount、currency、Reservation notes）；`agreed_total_amount` 不是 Guest PII，Sprint 2 不新增 `reservation:financial_read`。实现：`GET /guests*` 无 guest:read 整体 403；`GET /reservations*` / `GET /stays*` 的响应由 service 层序列化按权限裁剪字段（无 guest:read 仅保留 guest_id；无 reservation:read 不含嵌套 reservation 摘要），路由使用 `response_model_exclude_none=True` 保证缺失键不出现在 JSON。后果：HOUSEKEEPING（两者皆无）从任何 Booking 出口都得不到身份、联系方式和金额。

8. **业务单号：PG Sequence 原子生成 + UNIQUE 约束（REV-04）**。格式 `RSV{YYYYMMDD}-{NNNN}` / `STY{YYYYMMDD}-{NNNN}`（日期 = Property Business Date，NNNN = 独立 Sequence `nextval` 结果，4 位起、可自然超长）。禁止 SELECT MAX+1。Sequence 消耗不受回滚影响（可能产生空洞，业务可接受）。并发创建必然无重复编号，UNIQUE 约束为最终兜底。

9. **新增 service 层（`app/services/booking.py`）**。背景：Check-in / Check-out 事务、可售性引擎、权限裁剪序列化被多个路由复用，routes 内联会导致重复与不一致。决策：预订域业务集中到 service 层，routes 保持薄（鉴权依赖 + 参数 + 调 service + 序列化）；可售性/事务逻辑单点维护。其余 Sprint 1 路由风格保持不变。

10. **Property Business Date（REV-FINAL-01/02/08）与固定时区实现**。统一 `Asia/Shanghai`：Check-in 资格（business_date ∈ [check_in, check_out)）、No-show 资格（business_date >= check_in）、Availability 的「今天」、WALK_IN 默认 check_in_date。实现 `app/core/business_date.py`：由于本环境无 PyPI 网络、无法安装 `tzdata`（Windows Python 无系统 tzdata，`ZoneInfo('Asia/Shanghai')` 会失败），采用固定偏移 `timezone(timedelta(hours=8), name='Asia/Shanghai')`——上海自 1991 年起无夏令时，固定 UTC+8 与现代业务日期完全等价，且不依赖宿主机时区；SQL 侧时间转换用 PG 内置 `timezone('Asia/Shanghai', ...)`。时间戳（actual_check_in_at / actual_check_out_at / created_at / updated_at）一律 timezone-aware（timestamptz）。后果：跨平台、跨宿主机时区一致；测试日期全部动态生成（禁止硬编码年月日）。

11. **Reservation PATCH 编辑范围与重校验（REV-FINAL-05）**。仅 CONFIRMED 可修改：guest_id、room_id、room_type_id、check_in_date、check_out_date、source、external_reference、agreed_total_amount、currency、notes；修改 room_id / room_type_id / check_in_date / check_out_date 时在同一事务内重新执行 Availability 预检 + Room/RoomType 一致性 + 排他约束（UPDATE 时数据库自动重校验，23P01 → 409）。CHECKED_IN / CANCELLED / NO_SHOW / COMPLETED 经 PATCH 修改任何核心字段 → 409。`status` 字段不进入 Update schema：**PATCH 携带 status → 422（strict schema 显式拒绝，见下方 S2T1-BLK-01 修订），状态只能经专用 action 端点变更**。此为入住前预订修改，不属于换房/延住工作流。

12. **Room / Room Type 一致性（REV-FINAL-06）：选择 422**。`reservation.room_type_id` 必须等于 `room.room_type_id`，创建与 PATCH 均校验。错误码按任务书默认取 **422**（输入组合不合法，与日期非法同级；409 保留给状态/资源占用类冲突，语义边界更清晰）。

13. **查询契约与 Dashboard / Room Detail 组合策略（REV-FINAL-07）**。不新增聚合 API：`GET /guests?search=`（name OR phone）；`GET /reservations` 支持 status/room_id/guest_id/room_type_id/source/check_in_date/check_out_date/search（search 覆盖 reservation_no 与 Guest name/phone，命中结果仍遵守 guest:read 裁剪）；`GET /stays` 支持 status/room_id/planned_check_out_date。今日到店/离店/在住/未来 7 天由 T2 组合既有 List API 计算；`GET /availability` 返回全量房间 + 可售性标注（28 间规模，不分页），T2 Room Detail 可组合 `GET /rooms/{id}` + `GET /stays?room_id=` + `GET /reservations?room_id=`。Sprint 1 核心响应不变。

14. **Concurrent Check-out 并发保证（REV-FINAL-08）**。`SELECT ... FOR UPDATE` 锁定 stay 行：第二个事务阻塞至第一个提交后读到 CHECKED_OUT → 409，不产生第二次有效退房与重复审计；最终 Stay=CHECKED_OUT、Reservation=COMPLETED、Room=available+dirty。并发测试用两线程 + 独立 Session 真实提交验证（Check-in 同理，另由 `stays.reservation_id` 唯一约束兜底）。

15. **Check-out 将 Room cleaning_status 无条件置 dirty**。背景：房间清洁状态机 `clean → dirty` 是唯一合法入边，但退房时房间可能处于 cleaning/inspection/rework/dirty（在住期间保洁介入）。决策：Check-out 事务内无条件置 `dirty`（不走手动状态接口的状态机校验），保证「退房即脏房」业务不变式；手动状态接口的状态机语义保持不变。已在 DECISIONS 记录以明确该例外。

16. **迁移内 Enum 类型创建方式**。`op.create_table` 编译时会通过 `_on_table_create` 自动为列上的 Enum 发 `CREATE TYPE`，与显式 `Enum.create(checkfirst=True)` 叠加会触发 `DuplicateObject` 回滚。决策：迁移内使用 `sa.dialects.postgresql.ENUM(..., create_type=False)` + 显式 `.create(checkfirst=True)` / `.drop(checkfirst=True)`，与既有 migration（`9e3f9d00338c`）的显式建类型风格一致。

## 2026-08-27 — S2T1-BLK-01 修订：Reservation PATCH 严格输入校验

背景：原先实现（ADR #11 初版）采用 Pydantic 默认 `extra="ignore"`——`status` 与未知字段被静默忽略、空 PATCH `{}` 返回伪成功 200、混合 payload（status + notes）出现 Partial Success + Silent Ignore。S2-T1 Independent QA（Defect S2T1-BLK-01）判定此类「API 伪成功」不允许，与 APPROVED Task Spec（状态只能经专用 action 端点变更）不符。

决策（修订 ADR #11）：
- `ReservationUpdate` 使用 strict request schema：`ConfigDict(extra="forbid")` —— 未知字段（含不属于 schema 的 `status`）一律 **422**，不得静默忽略；
- schema `model_validator` 拒绝空 payload：`PATCH {}` 一律 **422**，不得返回伪成功 200（service 层 no-op 分支同样改为显式 422，防御双保险）；
- `status` 不属于 `ReservationUpdate`，普通 PATCH 携带 `status` → **422**；状态只能经 `cancel / no-show / check-in / check-out` 专用 action 端点改变；
- 校验在请求解析阶段原子失败：混合 payload 任何字段都不会被部分应用（无 Partial Success）；
- 合法 PATCH 行为（CONFIRMED 全字段编辑、room/room_type/dates 重校验、终态 409）保持不变。

后果：PATCH 不再存在 Silent Ignore 路径；pytest 增加严格校验用例（status / 未知字段 / 混合 payload / 空 payload / 合法 notes），总数由 163 增至 167。

## 2026-08-27 — Sprint 2 S2-T2：Booking Operations UI

1. **页面与组件分层沿用 Sprint 1 模式**。`app/(main)/**` 页面保持薄包装（metadata + 视图组件），业务视图放 `components/`（reservations-view / new-reservation-view / reservation-detail-view / stays-view / stay-detail-view），Booking 共享交互组件放 `components/booking/`（guest-picker / availability-picker / reservation-form / shared）。所有数据经统一 API Client（新增 guests / reservations / stays / availability 模块）走 BFF，浏览器不接触 Token。

2. **新增 `/stays` 列表页（超出任务书「新增页面」清单的补充）**。背景：导航契约要求 `stay:read → 在住入口`，而任务书页面清单只有 `/stays/[id]` 详情页；T1 已交付 `GET /stays`（status/room_id/planned_check_out_date 筛选）供 T2 消费。决策：新增轻量 `/stays` 列表页作为导航落点（真实分页 + 后端筛选），不新增任何后端接口。后果：在住入口可用，Stay List 查询契约（REV-FINAL-07）被完整消费。

3. **前端业务日期与日期算术**。`lib/booking.ts::businessDate()` 用 `Intl.DateTimeFormat(..., { timeZone: "Asia/Shanghai" })` 取 Property Business Date（IANA 时区，不依赖宿主机时区）；`addDays` 用 `Date.UTC` 纯日期算术（规避 `+08:00` 字符串解析的 UTC 偏移陷阱——曾导致 date+1 得同日的 bug，已由 Vitest 用例锁住）。所有测试日期动态生成（禁止硬编码年月日）。

4. **Availability 选择器交互**。新建/编辑表单必须先以当前日期 + 房型查询真实 `GET /availability`；选择器展示全部房间（不可用房间灰显 + 后端原因原文）；无可用房间展示 Empty 态且表单校验阻止提交（未选房间 → 「请选择可用房间」）。选择房间自动带出 `room_type_id`（Room / Room Type 联动），房型筛选变化清空房间选择强制重新挑选；最终一致性仍由后端 422 裁决。

5. **PII 双保险渲染（REV-02）**。后端已裁剪字段（`response_model_exclude_none` → 键缺失），前端再按 `auth/me` 权限隐藏：无 `guest:read` 不渲染 name/phone/email/guest_name（仅显示 `ID {guest_id}`）；无 `reservation:read` 不渲染预订摘要区块；HOUSEKEEPING 在 Room Detail 只看到「当前有客」非身份摘要（由 `occupancy_status=occupied` 派生，不依赖 Booking API）。任何 PII 不写入 localStorage/sessionStorage/console。

6. **Booking 操作按钮：status 值 + 权限显隐，不复制状态机**。前端仅按 `Reservation.status` 的具体值与 `auth/me` 权限决定按钮显隐（CONFIRMED：编辑/Cancel/No-show/Check-in；CHECKED_IN/COMPLETED：查看入住记录），不内置转换表；非法操作由后端 409 裁决并原样展示 detail（dirty / occupied / 日期资格 / 已退房 / 已取消等），不转成通用错误。所有写操作经确认对话框 + 提交期间按钮禁用（防重复提交），并发安全仍由后端保证。

7. **编辑表单只提交变更字段**。后端 strict PATCH（S2T1-BLK-01）拒绝空 payload 与未知字段：编辑模式 `buildPayload()` 对比 initial 仅收集发生变化的字段，无变更时提示「没有需要保存的变更」且不发请求；`status` 字段不存在于表单 schema。

8. **WALK_IN 日期约束（UI 层）**。`source = WALK_IN` 时 `check_in_date` 自动置为业务日期今天并禁用输入（与后端「WALK_IN 入住日期必须为业务日期今天」一致），切换其它来源后可重新编辑；后端 422 仍为最终裁决。

9. **Dashboard / Room Detail 组合策略（REV-FINAL-07 消费）**。Dashboard 新增「预订运营概览」：今日到店 = `GET /reservations?status=CONFIRMED` 客户端过滤 check_in=today；今日离店/当前在住 = `GET /stays?status=ACTIVE`；未来 7 天 = CONFIRMED 且 today ≤ check_in < today+7；循环翻页拉全（不假设数据量）。Room Detail 组合 `GET /rooms/{id}` + `GET /stays?room_id&status=ACTIVE` + `GET /reservations?room_id&status=CONFIRMED`（客户端取 check_in ≥ today 的最近一笔）。不新增后端聚合 API，Sprint 1 核心响应不变。

10. **前端查询新鲜度（React 19 + Next 16 lint 规则约束）**。Next 16 的 `react-hooks/set-state-in-effect` 禁止 effect 内同步 setState：查询结果携带其查询键（availability-picker 的 `{key, data}`、guest-picker 的 `{query, items}`），渲染期由 state 派生判断新鲜度（参数变化后旧结果立即失效显示加载态），effect 仅在异步回调中 setState。

## 2026-08-27 — Sprint 2 S2-T3：Integration & E2E

1. **E2E 目录扩展与隔离机制沿用**。新增 `golden-path / early-checkout / booking-rbac / booking-pii / concurrency / failures / regression` 七个 spec，全部复用既有隔离体系（`stayops_test` 库、8001/3001 端口、`workers=1` 串行、`run_test_backend.py` 单进程引导、gitignored 凭据）；`playwright.config.ts` 与既有 4 个 spec（auth/rbac/rooms/settings，10 条）未改动。辅助能力集中在新增 `e2e/booking-helpers.ts`（动态日期、直连后端 API 会话、UI 预订/入住/退房流程），不改动 `helpers.ts`，保证 Sprint 1 回归零扰动。

2. **动态日期实现（REV-03）**。E2E 日期一律基于 Property Business Date（Asia/Shanghai）动态生成：`Intl.DateTimeFormat`（IANA 时区，与宿主机时区无关）+ `Date.UTC` 纯日期算术；Golden Path / Early Checkout 使用 `check_in = today`、`check_out = today + 2`，当天创建、当天入住、当天退房。禁止硬编码年月日。

3. **并发验证方式（REV-FINAL-08，HTTP 口径）**。并发用例使用两个独立 Playwright `APIRequestContext`（各自 Bearer 登录）+ `Promise.all` 并发 POST，走真实 FastAPI(8001) → 真实 PostgreSQL（排他约束 / SELECT FOR UPDATE 行锁），验证 Double Booking / 并发 Check-in / 并发 Check-out 均为 1 SUCCESS + 1 × 409；最终一致状态与「无重复退房审计」按资源 ID 精确断言。与后端 pytest 的两线程验证互为补充（pytest 为服务层口径，E2E 为 HTTP 全链路口径）。

4. **用例间数据隔离策略**。E2E 每次运行由 `prepare_test_db.py` 重建测试库；`workers=1` 串行执行，各 spec 使用专属房间号段（golden-path=203、early-checkout=204、pii=201、rbac=205、concurrency=301/302/303、failures=304-308、regression=103），既有 rooms.spec（101/102）与 settings.spec（104）不受影响；不依赖 dev 库或手工残留数据。

5. **重叠预订 409 的双层验证**。Golden Path 在 UI 层验证 Availability 对已占用日期区间的房间禁用并展示原因原文，再经 BFF `POST /reservations` 实测 409「该房间在所选日期区间已被预订」（应用层预检或数据库排他约束裁决，均为真实后端），后端 detail 原样到达测试断言。

6. **审计无 PII 断言方式**。Golden Path 完成后以 admin 打开 `/settings/audit-logs` 验证 `guest.create / reservation.create / reservation.check_in / stay.check_out` 存在；details 无 PII 通过按资源 ID 精确取审计 JSON（断言不含 Guest 手机号/邮箱/notes/金额等可辨识标记值），UI 与 API 双层。

7. **PII 三层断言方式（REV-02）**。HOUSEKEEPING 专项：UI 层断言 Room 详情仅出现 dirty / occupied / 当前有客；网络层收集页面加载期间全部 `/api/bff/*` 响应体断言不含 PII 标记值；直连 API 层断言 guests / reservations / stays / availability 全部 403（带合法查询参数以区分 422 与 403）。

## 2026-08-27 — Sprint 3：Housekeeping Operations & Room Turnover

1. **HousekeepingTask 模型与 PII 边界**。Task 只关联 Room 与（可空）assignee 用户，**不关联 Guest / Reservation**——保洁运营不需要住客身份；响应与审计因此天然无 PII（name/phone/email/notes/reservation_no/amount 均不出现）。Checkout 的可追溯性由 `housekeeping.create` 审计携带 `stay_id / stay_no` 完成。

2. **Active Task 数据库级唯一：部分唯一索引**。一个 Room 至多一个进行中任务（PENDING / IN_PROGRESS / INSPECTION / REWORK），实现为 `CREATE UNIQUE INDEX uq_housekeeping_tasks_active_room ON (room_id) WHERE status IN (...)`——与 Booking 排他约束同思路（谓词限定 + 数据库最终仲裁）；应用层预检仅为快速路径，并发重复创建由唯一冲突（23505）映射 409「该房间已有进行中的保洁任务」。

3. **Task 状态机 + Room.cleaning_status 原子联动**。`PENDING→dirty、IN_PROGRESS→cleaning、INSPECTION→inspection、REWORK→rework、COMPLETED→clean、CANCELLED→dirty`；每次 action（start / submit-inspection / pass / rework / cancel）在单事务内完成 Task 状态 + 房态 + 审计，任一步失败全部回滚（`SELECT FOR UPDATE` 串行化并发转换）。任务驱动的房态写入不经过手动房态状态机（与 Checkout 无条件置 dirty 的既有决策同理由）；手动房态接口的状态机语义保持不变。

4. **Checkout 自动建任务（原子不变式）**。`create_checkout_task` 在退房事务内被调用（只 flush 不 commit）：Stay CHECKED_OUT + Reservation COMPLETED + Room available+dirty + Task PENDING 要么全部生效、要么全部回滚，不存在「已退房但没有翻房任务」。任务创建失败由退房事务整体回滚（pytest 显式回滚用例验证）。

5. **状态只能经 action 端点变更，PATCH 严格化（沿用 S2T1-BLK-01 修订）**。PATCH 仅限 priority / assigned_to_user_id / notes；strict schema（extra=forbid，空 payload 422，`assigned_to_user_id` 显式 null = 取消派单）；终态任务 PATCH → 409。非法状态转换 409 且 detail 可读（如「仅待验房的任务可通过验收」）。

6. **CANCELLED 回置 dirty**。取消即翻房未完成，房间回到待清扫（dirty），并释放 Active Task 名额（可再次创建任务）。REWORK 后重新 start 不覆盖首次 `started_at`（保留首次开始时间）。

7. **派单候选人端点 `GET /housekeeping/assignees`**。FRONT_DESK 按 Sprint 3 矩阵拥有 `housekeeping_task:write`（可派单）但无 `user:read`；为不扩大 user:read 范围（会破坏 Sprint 1 RBAC 边界），新增轻量候选人端点：以 `housekeeping_task:write` 门控，返回持有 `housekeeping_task:work` 的在职用户（id / display_name / username，员工身份非 Guest PII）。

8. **业务单号 task_no**。`HKT{YYYYMMDD}-{NNNN}`：PG Sequence `housekeeping_task_no_seq` 原子取号 + UNIQUE 约束（与 reservation_no / stay_no 同模式，禁止 SELECT MAX+1）。

9. **工作台交互原则**。`/housekeeping` 状态视图 + 任务卡片；start / submit 一键直达，pass / rework / cancel 经确认对话框（与既有 ConfirmDialog 体系一致）；不引入 Kanban / 企业级仪表盘（外部 PMS 常见但超出本物业规模需求）；前端仅按 Task.status + 权限显隐按钮，状态机唯一权威在后端。

10. **测试口径**。pytest 202（167 基线 + 35 新增：模型/状态机/RBAC/审计/派单/唯一性/Checkout 自动任务/回滚/房态同步/PII/并发/迁移往返/seed 矩阵）；Vitest 170（139 基线 + 31 新增）；Playwright 36（29 基线 + housekeeping 2 spec 7 条）。并发用例沿用「两线程 + 独立 Session 真实提交」（pytest）与「两个 APIRequestContext + Promise.all」（E2E）双重口径。E2E 房间号段：S3 使用 105-110、209、210，不与 Sprint 1/2 用例重叠。

## 2026-08-28 — Sprint 4：Front Desk Command Center & Room Diary

1. **时间线窗口查询 = 现有 Reservation List 的最小扩展（overlap_from / overlap_to）**。背景：Room Diary 需要批量拉取窗口内所有预订（含跨窗的在住），不允许每房间单独请求（N+1）。决策：`GET /reservations` 新增可选 `overlap_from` / `overlap_to`（语义 = 预订区间 [check_in, check_out) 与 [from, to) 有重叠，即 `check_in < overlap_to AND check_out > overlap_from`；紧邻不视为重叠；必须成对提供、to 必须晚于 from，否则 422）。写操作与既有筛选完全不变；权限仍 reservation:read；沿用分页；CANCELLED/NO_SHOW/COMPLETED 仍可被查询返回（是否展示由 UI 层按 Sprint 4 §8 决定）。`check_in_date` / `check_out_date` 两列已有索引，28 房规模查询代价可忽略。后果：/front-desk 用 1 个窗口请求替代 28 个房间请求；pytest 新增 11 条覆盖重叠/紧邻/边界/非法窗口/权限/PII/分页。

2. **不新增 `GET /front-desk/attention`，也不建立 Front Desk Domain Model**。背景：注意力三条规则（脏房到店 / 超期在住 / 锁房未来预订）可由 rooms + reservations(窗口) + stays(ACTIVE) + housekeeping tasks 四个批量 List API 在客户端组合。决策：页面数据 = 4 个批量请求（各循环翻页拉全，page_size=100），Attention 由纯函数 `computeAttention` 组合计算；仅当未来实测出现 N+1 / 重复请求 / 无法客户端组合时才允许引入轻量只读聚合端点（本 Sprint 未触发）。后果：零后端聚合面，Sprint 2 查询契约（REV-FINAL-07）继续成立；Attention 规则在 Vitest 层充分覆盖，E2E 验证真实组合路径。

3. **时间线渲染语义：[check_in_date, check_out_date) 像素化**。背景：预订条必须精确覆盖入住日晚至退房日前一晚，退房日可接下一笔，禁止 off-by-one。决策：`lib/front-desk.ts::barPlacement` 把区间裁剪到窗口 [winStart, winStart+days) 后按 `天数 × 64px` 定位（left = 距窗口起点天数 × 64，width = 覆盖晚数 × 64）；紧邻（check_out == 窗口起点 / check_in == 窗口终点）返回 null。所有日期运算走 Date.UTC 纯日期算术（与 lib/booking.ts 一致）。后果：相邻预订像素级首尾相接；Vitest 锁住 [28,30)/[30,32) 相邻、跨窗裁剪、边界不越界；E2E 用 boundingBox 实测 1 晚条宽 ≈64px、相邻条 gap ≤2px。

4. **桌面/移动树切换 = useSyncExternalStore + matchMedia（<768px 不渲染完整 Room Diary）**。背景：Next 16 的 `react-hooks/set-state-in-effect` 禁止 effect 内同步 setState，`useState + useEffect` 的 matchMedia 钩子与 SSR 水合都容易踩线（服务端快照与客户端不一致会触发水合错误）。决策：`lib/media-query.ts::useMediaQuery` 用 `useSyncExternalStore(subscribe, getSnapshot, () => false)`——水合期间使用服务端快照、水合后自动切到客户端快照（React 对 useSyncExternalStore 不报水合不一致），无 effect 内 setState；`FrontDeskView` 按 `(max-width: 767px)` 条件渲染 Command Center + Room Diary（≥768px，含 768–1023 紧凑档）或 FrontDeskTodayBoard（<768px），两树共享同一份数据 bundle（只发一轮批量请求）；jsdom 无 matchMedia 时回退 false（测试默认桌面树）。后果：手机 DOM 中不存在 Room Diary 网格（Playwright 390×844 实测 `[data-room-cell]=0`）；900×720 实测 Diary 可用；无水合风险。

5. **快速新建 = 复用 /reservations/new + URL 预填，不新造第二套表单**。背景：空白日期格需要「新建预订」且预填 room/日期。决策：`quickCreateHref(roomId, roomTypeId, date)` 生成 `/reservations/new?room_id&room_type_id&check_in_date&check_out_date(=check_in+1)`；NewReservationView 读 search params，room_type_id 缺失时经 `GET /rooms/{id}`（room:read）定向补全，未就绪前显示 Loading；ReservationForm 新增仅 create 模式生效的 `prefill` prop。表单继续查询真实 `GET /availability`（UI 日历空白不构成业务授权），后端 Double Booking / 422 仍是最终裁决。后果：单一表单、单一创建 API；Vitest 覆盖预填与补全两条路径；E2E 从空白格走完整真实创建。

6. **Check-in 前置解释（§11）与后端 409 权威并存**。背景：脏房到店时员工需要「为什么不能办入住」的解释。决策：Reservation Drawer 在「CONFIRMED + 今日到店 + 房间非 clean」时隐藏 Check-in 主按钮，展示「房间尚未准备完成」+ Active HousekeepingTask（task_no / status / assignee / 查看保洁任务；无任务时引导保洁工作台）；房间干净时才显示 Check-in 主操作。前端只解释原因，不复制状态机；后端 409（dirty / occupied / 日期资格）保持最终权威。后果：员工先知道原因再处理；E2E 验证「脏房 → 完成清扫 → 刷新 clean → Check-in 成功」完整闭环。

7. **PII 搜索前端约束（后端裁剪仍是唯一边界）**。背景：搜索支持 Guest name/phone（后端 REV-FINAL-07 契约），无 guest:read 用户理论上可探测手机号存在性。决策：无 guest:read 时，搜索框只允许房号（本地匹配，零后端请求）与预订单号（RSV* 前缀识别）；姓名/手机号输入显示权限提示且不发起后端搜索；后端响应裁剪（guest_name 键缺失）作为唯一安全边界继续成立，前端约束仅收紧 UI 发起面。后果：`room:read + reservation:read`（无 guest:read）的最小前台用户仍可定位房间与预订；pytest 补 PII 裁剪用例（窗口 + search 组合）；E2E 验证提示与 ID 展示。

8. **超期在住（规则 B）E2E 状态准备：真实 UPDATE，不 mock**。背景：planned_check_out_date < business_date 只能由时间流逝产生，Check-in 无法直接构造。决策：`e2e/setup_overdue_stay.py` 用与业务同源的 ORM（app.database / app.models）对 stayops_test 执行真实 UPDATE（planned_check_out_date = business_date - 1），E2E helper 经子进程调用；Attention 计算仍完全走真实 List API 组合。后果：规则 B 在真实前端组合路径上被验证；无测试专用接口污染后端 API。

9. **写操作后 targeted refetch + 60s 轻量轮询**。背景：Check-in/Check-out/创建/编辑/取消/No-show 后 Diary 必须更新；Alpha.4 不做 WebSocket。决策：写操作成功回调触发 `reloadKey` 重载 4 个批量请求；60s `setInterval` 轮询仅在无 Drawer 打开且页面可见时触发（不覆盖编辑输入、不关闭 Drawer）。后果：E2E 断言 Check-in/Check-out 后房间栏与时间线真实刷新。

10. **Front Desk 测试口径**。pytest 213（202 基线 + overlap 窗口 11）；Vitest 240（170 基线 + 70：lib 时间线/Summary/Attention + Room Diary + Command Center 集成 + Today Board + 快速新建预填 + 前台导航矩阵）；Playwright 46（36 基线 + front-desk 1 spec 10 条）。E2E 房间号段：S4 使用 110、202、206、207、208，不与 Sprint 1–3 重叠。日期全部动态生成（Asia/Shanghai 业务日期），禁止硬编码年月日。

11. **S3 冻结 spec 的 accessible-name 歧义消解（Dashboard 保洁快捷链接 aria-label）**。背景：`housekeeping.spec.ts`（冻结，不可修改）在 `getByRole("link", { name: "保洁" })` 使用 Playwright 默认子串匹配；当 Dashboard 的「进入保洁工作台 →」快捷链接在断言首轮轮询前挂载时，两个链接同命中导致 strict-mode 失败（S3 作者已在同文件另一处以 `exact: true` 注释过该歧义）。全套件运行（Dashboard 路由已预热）时该竞态由偶发转为稳定失败。决策：Dashboard 保洁概览快捷链接增加 `aria-label="打开 Housekeeping 工作台"`（accessible name 不再含「保洁」子串；可见文本不变、导航不变、语义更清晰），不改动冻结 spec，不弱化任何断言。后果：该歧义确定性消失；`dashboard-housekeeping` Vitest（按文本断言）不受影响。

12. **E2E 跨 spec 状态容忍（Attention 断言按条目而非总数）**。背景：`failures.spec`（冻结）会遗留「304 脏房 + 今日到店 CONFIRMED」状态（Rule A 命中），S4 Attention 用例若断言「需关注 = 3」会在全套件顺序下失败。决策：S4 Attention E2E 改为断言三条目标规则的条目存在（A 取 first，B/C 唯一），Housekeeping 用例按 `房间 206` 定位条目；隔离运行与全套件运行皆确定。后果：目标规则验证强度不变，与既有 spec 的共享测试库状态共存。

13. **D1 修复（Kun Fast QA Blocking Defect + Fast Review 收窄分类）：并发仲裁错误窄分类映射**。背景：并发 Double Booking 时，PostgreSQL 排他约束（daterange EXCLUDE USING gist）检查让两事务互相等待 ShareLock，PostgreSQL 中止其一并报 `DeadlockDetected`（SQLSTATE 40P01，psycopg2 → `sqlalchemy.exc.OperationalError`）；修复前 `_commit_or_conflict` 只捕获 `IntegrityError`(23P01)，40P01 从 flush/commit 逃逸为 500（Sprint 2 遗留，非 S4 新增代码）。决策（两轮收敛）：`booking.py` 六条 service 路径（create / update / cancel / no-show / check-in / check-out）与 `_commit_or_conflict` 统一捕获 `OperationalError` → rollback，随后**仅**按 `_is_transaction_conflict`（`_pgcode` 读 `orig.pgcode`，回退 `orig.diag.sqlstate`）窄分类：**40P01 / 40001 → 409**（create/update 映射 Double Booking 语义，其余映射各自通用冲突文案）；**其它任何 OperationalError（57014 query_canceled / 无 pgcode / 连接故障 / 库不可用 / 无关超时）→ 原样 re-raise**，不得转换为 409/422/400，不得吞掉（保持基础设施/数据库错误语义）。23P01 → 409 既有行为不变。不重试（与 23P01 一致：数据库仲裁即最终答案）。后果：错误语义 = 23P01/40P01/40001 → 409、其余 DB 错误 → 5xx 基础设施语义；新增 7 条 pytest（commit/flush 处 40P01、40001、update 路径的确定性映射；57014 与无 pgcode → 原异常传播 + 事务已回滚验证；25 轮真实并发无 500）；独立压测 50 轮服务层 + 50 轮 HTTP 层（真实 uvicorn + stayops_test）均 0 × 500 且每轮数据库 exactly 1 条；数据完整性不变。
