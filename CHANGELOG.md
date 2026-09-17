# Changelog

All notable changes to StayOps will be documented in this file.

## [v1.0.0-alpha.9.6] - 2026-09-14

**主题：Field Trial Operations Improvements + Windows runtime compatibility**

反馈来源：**real hotel field trial / real operator feedback**
（真实酒店经营者现场试用；不含任何个人身份信息）。

> 版本边界：原计划的独立 alpha.9.5（Windows non-ASCII PostgreSQL hotfix）已并入
> 本版本 —— 两者不存在可验证的独立测试边界，因此**不单独发布 alpha.9.5、
> 不单独打 tag**。本版本包含两部分：
> **A. Windows non-ASCII install-path PostgreSQL runtime compatibility fix**
> **B. Field Trial Improvements（房间资料 / 按日期房态 / 渠道主数据 / 渠道分析）**
> **NO TAG / NO RELEASE**：待最终实机 QA 后再决定 release。

### Added

- **F1 · 房间资料管理**（现场需求 1「房间数量、房间信息需要可以编辑」）：
  - `rooms.name`（房间显示名称，可空）+ `rooms.is_active`（是否投入经营）
  - `GET /rooms/summary`：总房间数 / 启用房间数 / 停用房间数，
    **全部由数据库 COUNT 查询计算** —— 未新增任何 `room_count` 真值字段
    （房间记录是业务事实，房间数量只是它的计算结果）
  - `PATCH /rooms/{id}`、`POST /rooms/{id}/disable`、`POST /rooms/{id}/enable`
  - **停用优先于删除**：停用不释放房号（房号全局唯一含停用房）、不破坏历史
    Reservation / Stay / 保洁 / 维修记录；只有从未被任何业务记录引用的房间
    才允许物理删除，否则 409 并提示改用停用
  - 前端「房态棋盘」新增「房间资料」视图：新增 / 编辑 / 停用 / 启用 + 数量统计
  - 验收：经营者无需改数据库 / seed / 代码即可把 28 间改成 30 间，
    也可把「101 大床房」改成「101 豪华大床房」
- **F2 · 首页房态概览按日期显示**（现场需求 2）：
  - 新增 `GET /dashboard/room-status?date=YYYY-MM-DD`，业务规则全部在后端
    （`app/services/room_status.py` date occupancy resolver）
  - **明确区分** physical room status（`rooms.occupancy_status`，仅表示业务日期
    当天的物理状态）与 date-based occupancy（某日可售 / 已预订 / 在住 / 维修停用）
  - 半开区间 `check_in <= date < check_out`（与排他约束、可售性引擎同语义）；
    ACTIVE Stay 与 CONFIRMED Reservation 分别判定；退房日不算整日占用
  - physical override：维修 / 长期停用 / 锁房优先于日期占用，不因当天无预订
    就标为可售；**不为未来日期推断 CLEANING / 物理状态**
  - 未来日期返回 `physical_status_authoritative=false`，前端显式提示
    「物理房态仅供参考」——**禁止用当前 Room.status 冒充未来房态**
  - 前端 Dashboard：前一天 / 日期选择器 / 后一天 / 今天 + 点击分类钻取房间列表；
    「预计到店」标记绝不谎报成「在住」
- **F3 · 客源渠道体系**（现场需求 3「OTA 不能只叫 OTA」）：
  - 新表 `channels`（id / code / name / category / enabled / is_system /
    sort_order / timestamps）+ PG 枚举 `channel_category`
    （OTA / DIRECT / OFFLINE / CORPORATE / OTHER）
  - 预置渠道：美团 / 携程 / 飞猪 / 直订 / 电话 / 微信 / 散客 / 协议客户 /
    其他 / 历史来源（系统渠道名称固定、不可删除，仅可停用）
  - **「其他」不是 `channel=OTHER + other_text`**：所有渠道平权，经营者可自建
    抖音 / 小红书 / 途家 / Booking 等任意渠道，经营分析中各自独立成行
  - `reservations.source_channel_id`（FK channels）= **唯一来源事实**；
    legacy `reservations.source` 降级为**只读历史投影**（不删除、不再作为事实源）
  - 迁移按固定映射表全量回填（`DIRECT→直订`、`OTA→其他`…），并保证
    **legacy 原值一字不改、不丢历史数据**
  - 渠道管理页面 `/channels`：查看 / 新增 / 改名 / 停用 / 启用 / 删除
    （被预订引用的渠道拒绝删除，提示改用停用）
  - 预订表单「来源」→「**来源渠道**」下拉（不再自由文本）
- **F4 · 渠道经营分析**（现场需求 4「客户来自哪个渠道」）：
  - 新增 `GET /analytics/business/channels`（权限 `analytics:business_read`）：
    渠道 / 订单数 / 实际房晚 / 合同房费 / 渠道占比 / 合同 ADR
  - 归因链 `Stay → Reservation.source_channel_id → Channel`，**每单恰好一次**
    （防重复计数）；`CANCELLED` / `NO_SHOW` 不计入
  - **收入口径复用既有经营分析事实源**（`agreed_total_amount` 按计划房晚分摊到
    实际占用房晚），不新造口径；UI 明确标注**合同房费非实际收款**
    （StayOps 无 Folio / Payment / Settlement）
  - Σ 渠道 + 「未指定渠道」桶 == 合计（可对账不变式）
  - AI 店长兼容：`get_analytics(endpoint="channels")` 可回答
    「哪个渠道订单最多 / 渠道合同房费最高 / 客源渠道占比」；
    新增 `ai_channels` 只读视图（AI 视图总数 21 → 22）

### Windows Compatibility（原 alpha.9.5 hotfix，并入本版本）

- **问题（真实复现）**：Packaged Mode 从 `resources\postgres\pgsql\bin` 直接执行
  PostgreSQL CLI；安装路径含中文时首次 `initdb` 失败：
  `FATAL: invalid byte sequence for encoding "UTF8": 0xb0`。
  复现对照：Chinese-bin + ASCII-data = FAIL；ASCII-bin + Chinese-data = PASS
  → 触发条件是 **PG 工具的执行路径**，与数据目录无关。
- **修复**：Packaged Mode 首次启动把 bundled PostgreSQL runtime
  **materialize 到 ASCII-safe 版本化路径**
  `%PROGRAMDATA%\StayOps\runtime\postgresql\<version>\pgsql`，此后
  **所有** PG CLI（initdb / pg_ctl / pg_isready / psql / pg_dump / pg_restore）
  统一从该路径执行；Development Mode 行为不变。
- Materialization 安全：staging 目录 + 复制后校验（binary / share / lib）+
  原子 rename + 完整性标记（`…\.stayops-runtime.json`，半复制永不复用）+
  幂等复用 + 崩溃残留清理 + **不触碰 data 目录 / 不删除业务数据库** +
  失败 Fail Safe（绝不静默回退到非 ASCII 路径执行）。
- 安装路径与非 ASCII 兼容：**不要求用户安装到英文目录**；不使用 8.3 short path、
  不修改 SQL_ASCII、不降低 UTF8 要求。
- **PG CLI 输出解码**：`subprocess` 不再无条件按 UTF-8 解码，改为
  UTF-8 strict → 系统 preferred encoding / mbcs → replacement，
  中文 Windows 下错误信息不再乱码（不改数据库编码）。
- **失败初始化保护**：仅在「有 incomplete 标记且无 PG_VERSION」时才清理失败
  残留；有 PG_VERSION 的 cluster 永不自动删除；无法确证的非空目录拒绝动手。
  标记文件位于 data 目录**同级**（`data.stayops-init-incomplete`）—— initdb
  要求目标目录为空，标记放进 data 内会让全新安装直接失败。
- 备份/恢复（`scripts/desktop_db_backup.py`）使用与 Desktop 主进程**同一个
  runtime resolver**（避免 initdb 与 pg_dump 走不同路径）。
- **打包卫生**：`app.asar` 不再包含 electron-builder 生成的
  `builder-debug.yml`（其内容含开发机绝对路径），安装包内无开发机路径。
- 测试：desktop 单元 16 条（resolver / materialization / 幂等 / 半复制 /
  Fail Safe / 工具覆盖面）+ Python 纯逻辑 19 条（解码 / data dir 五态 /
  清理守卫 / 标记位置 / 备份 resolver）+ 真实集成 2 条（非 ASCII 源路径 →
  materialize → 真实 `initdb`；真实 `cmd_db_ensure` 全新初始化 → 启动 → 建库）。

### Database

- 新增 revision `a96b1c4d7e02`（`down_revision = b7c1e5a93d24`，**单 head**）：
  `rooms.name` / `rooms.is_active` / `channels` 表 / `reservations.source_channel_id`
  / legacy 回填 / AI 只读视图同步
- 已验证：alpha.9.4 真实 schema → alpha.9.6 head，现有 28 房与全部 reservation
  **完整保留**；空库升级、重复升级（幂等）、downgrade 往返均通过
- **不自动 downgrade**（仓库政策）；migration 本身可逆（与既有 revision 惯例一致）

### Security / RBAC

- 新增权限码 `channel:read` / `channel:write`（权限总数 52 → 54）
  - SUPER_ADMIN（动态全权限）/ MANAGER：查看 + 管理渠道
  - FRONT_DESK：仅 `channel:read`（可在创建预订时选择来源渠道）
  - HOUSEKEEPING / MAINTENANCE / FINANCE：无渠道主数据权限
  - **前台不因渠道选择获得渠道收入 / 经营分析权限**（后者仍属 analytics:business_read）
- 新增权限码 `room:inventory_manage`（权限总数 54 → 55，见下方 QA Fix DEF-1）
  - SUPER_ADMIN（动态全权限）/ MANAGER：房间主数据管理
  - FRONT_DESK / HOUSEKEEPING / MAINTENANCE / FINANCE：**无**房间主数据管理权
- **权限码只经 `app/seed.py` 幂等收敛**（既有先例）；migration 不写权限表、不授权
- 新路由一律**单权限码**鉴权；本轮唯一例外是**既有** `DELETE /rooms/{id}`
  （QA 修复项 §2 要求其纳入 `room:inventory_manage` 保护区，同时保留既有
  `room:delete` → 两码 AND，见下方 QA Fix DEF-1）
- 房间：`room:write` = **日常房态操作**（`POST /rooms/{id}/status`）；
  `room:inventory_manage` = **房间主数据管理**（新增 / 编辑 / 停用 / 启用；
  删除还需 `room:delete`）；`room:delete` 仍不授予任何常规角色

### QA Fix（独立 QA 复检后的修复；不改动被冻结的业务规则）

- **DEF-1（HIGH / release blocker）RBAC 权限扩张**：原实现把新增的
  `POST /rooms/{id}/disable|enable` 挂在 `room:write` 上，而 FRONT_DESK 自
  alpha.9.4 起即持有 `room:write`，导致**前台可新增 / 编辑 / 停用 / 启用房间
  主数据**（独立 QA 以真实 HTTP 复现：`POST /rooms` 201、`PATCH` 200、
  `enable` 200）。修复：房间主数据统一由新权限码 **`room:inventory_manage`**
  守卫（`POST /rooms`、`PUT`/`PATCH /rooms/{id}`、`disable`、`enable`；
  `DELETE /rooms/{id}` 为 `room:inventory_manage` **且** `room:delete`），
  `room:write` 语义不变（仅房态操作）。
  前端按钮门控同步改为 `room:inventory_manage`（前端隐藏只是体验，
  后端才是权限权威）。
- **DEF-2（MEDIUM）E2E 稳定性**：`e2e/helpers.ts` 登录改为可判定流程 ——
  先等到达 `/login`、以会话端点确认未登录状态、再提交凭据并等待登录响应，
  最后断言 `/dashboard`；失败时输出 HTTP 状态 / 页面错误文案 / 当前 URL
  （绝不输出密码），移除 sleep 与盲目重试。
- **DEF-3（LOW，文档澄清）**：`GET /dashboard/room-status` 的
  `effective_occupancy_status` 在非业务日期（前一天 / 后一天）为 `null`，
  这是**设计如此**：它只是业务日期当天的物理房态投影，非业务日期由
  `status`（日期占用）表达。已在 `docs/API.md` 明确，前端也仅在
  业务日期当天渲染该字段。
- **DEF-4（LOW）**：移除 `docs/DECISIONS.md` 文件末尾多余空行。

### Verified

（下列为 **release 候选最终数字**；括注为独立 QA / 修复前基线。）

- **PG integration（真实 PostgreSQL 16.15）**：Backend `cmd_db_ensure` 全新
  初始化 → initdb → pg_ctl start → pg_isready → 建库 → 二次调用幂等
  （**1 passed**）；Desktop 非 ASCII 源路径 → materialize → 真实
  `initdb -E UTF8 --locale=C`（**1 passed**）
- **实机（中文安装路径）**：安装 / 首次运行 / runtime materialize / initdb /
  migration / seed / bootstrap admin / 登录 / 首改密 / 功能可用 /
  FRONT_DESK RBAC 全部 PASS；PG 进程镜像来自
  `%PROGRAMDATA%\StayOps\runtime\postgresql\16.15\pgsql\bin`
- Backend pytest: **806 passed, 1 skipped**（skip = env-gated 集成测试；
  未删除任何既有测试）；含 RBAC 目标用例与 migration「不写权限表」断言
- Frontend：lint **PASS**、typecheck **PASS**、Vitest **498 passed / 62 文件**
- Desktop typecheck **PASS**；Desktop Vitest **91 passed, 1 skipped**
- Playwright：full suite **84 passed**（另有 `z-ai-manager.spec.ts` 单独连续 3 次全绿）
- Playwright 新增 `field-trial-alpha96.spec.ts` 4 条真实端到端流程
  （新增房间→编辑→Rooms/Dashboard 出现；未来预订→切日期→显示「已预订」；
  新建渠道→预订选择→详情显示；经营分析渠道统计）
- `git diff --check`：**0 输出**

## [v1.0.0-alpha.9.4] - 2026-09-13

### Added

- **Fully Bundled Windows Installer（Desktop D2 foundation）**：
  `StayOps-Setup-1.0.0-alpha.9.4.exe`（NSIS，per-user）——安装包内含
  Electron 客户端、Next.js production standalone、FastAPI 后端、Python
  运行时与后端依赖、PostgreSQL 16 二进制、Alembic 迁移、桌面运行时脚本与
  品牌资源；用户机器**无需预装** Python / Node.js / pnpm / PostgreSQL /
  Docker / Git，也无需 `STAYOPS_ROOT` 或 `backend/.venv`
- **Packaged Mode**：`buildPaths()` 按 `isPackaged` 分支，安装版全部从
  `process.resourcesPath` 解析（`resources/{backend,python,postgres,node,
  scripts,frontend-server}`）；packaged 布局按结构识别，不再需要
  `AGENTS.md` / `.venv`；源码中不再包含硬编码开发机路径
- **首次安装引导**：幂等 seed（权限/角色/房型/房间）+ 每台安装独立的随机
  SUPER_ADMIN 初始密码（DPAPI 保护、只注入 seed 进程、只在首次启动 UI
  显示一次、绝不写入任何日志）；`must_change_password` 由后端强制，前端
  `/change-password` 引导改密，改密成功后自动销毁引导凭据
- **每台安装独立的 AI_ENCRYPTION_KEY**：随机 32 字节 Fernet 密钥 + DPAPI，
  仅注入后端进程；不再允许回退到公开的开发默认值（packaged 模式 Fail Safe）
- **前端自包含**：standalone 的 pnpm junction 全部物化为真实文件、虚拟存储
  提升到顶层（修复 `@swc/helpers` 解析）、排除 source map、清除 Next 内嵌的
  构建机绝对路径
- 桌面构建脚本：`bundle-runtimes.mjs`（装配运行时 + 违禁内容安全扫描）、
  `dist:installer`（NSIS 安装包）

### Fixed

- `icacls` 账号名授权生成无效 ACE，配合 `/inheritance:r` 会把当前用户锁在
  `%PROGRAMDATA%\StayOps\config` 之外（alpha.9.3 遗留的机器状态已实测复现）；
  改为 SID 授权 + 读/写回校验 + 目录不可写时自愈修复
- `seed()` 的 stdout 输出污染探针 JSON 契约（成功的 seed 被判为失败）
- `dev_runtime._alembic` 硬编码工作区 `.venv` 解释器，安装版报
  `FileNotFoundError`；改为使用当前解释器
- 全新空数据库被判为迁移状态异常（应为 BEHIND，走用户确认升级流程）
- `desktop_db_backup.py` 仅识别开发布局的 PostgreSQL bin 路径
- `scripts/desktop_runtime.py` 重复的 `_pg_run` 定义、initdb 前 mkdir 顺序

### Verified

- Backend pytest: 649 passed
- Frontend Vitest: 462 passed（59 文件）；lint / typecheck PASS
- Desktop Vitest: 68 passed；typecheck PASS
- 打包运行实证（本机模拟干净环境：独立 `PROGRAMDATA`/`LOCALAPPDATA`）：
  自管理 PostgreSQL 首次 initdb → 迁移至 head → 基础数据 seed → 首次启动
  显示管理员初始密码（日志中为 `***`）→ 登录 200 → 改密前业务接口 403 →
  改密 200 → 业务接口 200 → 重启后引导凭据已销毁 → Runtime READY
- 前端自包含实证：物化后的 `resources/frontend-server` 仅用 bundled Node
  启动并对 `/login` 返回 200（不依赖开发机 `node_modules`）

### Limitations

- **尚未完成 clean-machine QA**：本机为 Windows 10 Home，无 Hyper-V /
  Windows Sandbox / VMware / VirtualBox，需在干净 VM/PC 上验证后方可发布
- 打包未签名（无 code signing），Windows SmartScreen 可能提示
- Portable 目标仍未正式交付；本版不含自动更新

## [v1.0.0-alpha.9.3] - 2026-09-13

### Added

- StayOps Desktop 自管理 PostgreSQL Runtime：`db-ensure` 探针完成首次 `initdb`
  （scram-sha-256 + 随机凭据 + icacls 收紧 ACL）、`pg_ctl` 启动、readiness 校验
  与幂等 `CREATE DATABASE stayops`；数据目录与程序目录彻底分离
  （`%PROGRAMDATA%\StayOps\PostgreSQL`），仅监听 `127.0.0.1:5433`
- `DATABASE_URL` 仅由 Desktop 运行时注入 backend 子进程（优先级：环境变量 > `.env` > 默认）
- 数据库备份/恢复工具 `scripts/desktop_db_backup.py`（`pg_dump -Fc` + SHA-256 侧车；
  `--restore <dump> --yes` 显式确认）
- 正式品牌资产：母版 `icon-master.png` + 确定性生成器 `make-brand-icons.cjs`
  （应用图标 / 托盘图标 / 启动页 brand mark）+ 打包校验 `verify_icons.cjs`
- Desktop 离线 Electron 打包（复用 `node_modules/electron/dist`，不联网下载）
- Electron 任务栏/窗口品牌（AppUserModelId + 显式窗口图标）

### Verified

- Backend pytest: 646 passed
- Frontend Vitest: 462 passed（59 文件）；lint / typecheck PASS
- Desktop Vitest: 62 passed；typecheck PASS
- Playwright E2E: 80 passed
- Desktop Fresh Build（`pnpm dist`）+ `verify_icons.cjs`：PASS
- 桌面运行实证：db-ensure first-run PASS → PostgreSQL `127.0.0.1:5433` 就绪 →
  Desktop 进入 ready（backend 8100 / frontend 3100）→ 12 个页面真实数据渲染 →
  真实 DeepSeek provider（AI 店长）问答 PASS

### Limitations

- 仍依赖 StayOps workspace runtime layout（`backend/.venv`、`frontend/node_modules`、
  Node.js、`runtime/postgres` 二进制；后者 gitignored，不入库不入 asar）
- 无安装器 / 代码签名 / 自动更新；Portable 目标未正式交付；非 Desktop D2

## [v1.0.0-alpha.9] - 2026-08-31（待 Kun Fast QA）

### Added

- Sprint 9: DeepSeek AI Manager（AI 店长，Alpha.9 = 真正可用、简单、安全的 AI 数据分析入口）
- `/ai-manager` Chat（消息列表 / 输入 / 发送 / loading / error / retry / 新对话 +
  6 个快捷问题 + 未配置 DeepSeek 提示 + 会话恢复）；`/settings/ai`（保存 / 更新 /
  删除 API Key + Test Connection + Model）
- 架构：/ai-manager → Backend → DeepSeek API → S8 Analytics + 只读 SQL；
  集中 `DeepSeekClient`（chat / tool calling / timeout / HTTP error mapping /
  malformed / usage，日志 scrub secret）；非复杂 Agent 平台
- 三条安全规则 LOCKED：AI 数据库访问只读；API Key 只在后端（Fernet 加密落库，
  前端只能看到 sk-****abcd 掩码，无读取完整 Key 的接口，密钥来自环境变量
  AI_ENCRYPTION_KEY 与密文分离）；AI 无任何写工具
- 只读 SQL 双层保护：词法级 Validator（SELECT / WITH...SELECT 白名单 +
  38 个写/DDL/DCL 关键字 + 多语句拒绝）+ 数据库级 `stayops_ai_reader` 只读
  Role（仅 SELECT 21 个 `ai_*` 视图，无基表权限）+ READ ONLY 事务 +
  statement_timeout + 行数上限（默认 200 / 硬上限 500）
- `ai_*` 视图 = 表/字段白名单：Guest PII（guests 表/手机/邮箱/备注）物理排除；
  reservations 无金额；suppliers 无联系方式；users 无 email/phone/password_hash
- SQL Domain Access：AI 可见数据 = 当前用户既有权限（operations / business 域
  继承，FRONT_DESK 拿不到经营数据、FINANCE 拿不到运营数据）
- get_analytics 工具：正式 S8 Metric（Occupancy / ADR / RevPAR / Cancellation /
  No-show / ALOS / Forecast）一律走 S8 Analytics Service，禁止 AI 自行实现
- 工具循环上限 5 轮 + 最近 10 条消息上下文 + ai_conversations / ai_messages
  持久化（user/assistant，工具消息与完整 SQL 结果不落库）
- Provider 失败隔离（§7）：timeout / 401 / 402 / 429 / 5xx / 网络 / malformed
  只影响 /ai-manager，返回 AI_NOT_CONFIGURED / AI_AUTH_FAILED /
  AI_RATE_LIMITED / AI_PROVIDER_UNAVAILABLE / AI_TIMEOUT /
  AI_RESPONSE_INVALID / AI_TOOL_ROUNDS_EXCEEDED 业务码
- RBAC：ai_manager:use（SUPER_ADMIN/MANAGER/FRONT_DESK/FINANCE）与
  ai_manager:manage（SUPER_ADMIN/MANAGER）——共 52 权限码（seed 幂等）
- Migration `f5d3b9e7a2c4`：ai_settings（单行）/ ai_conversations /
  ai_messages + 21 个 ai_* 视图 + stayops_ai_reader Role；不修改 S1-S8 业务事实
- 前端安全 Markdown 子集渲染器（纯 React 文本节点，禁止 dangerouslySetInnerHTML）
- 测试体系：pytest FakeDeepSeekClient / httpx.MockTransport（不依赖网络）；
  Playwright 本地 Fake DeepSeek Provider（127.0.0.1:8099，确定性路由，
  绝不向真实 DeepSeek 发送 fake key）

### Verified

- Backend pytest: 603 passed（440 Sprint 8 基线保留 + AI Manager 163）
- Frontend Vitest: 458 passed（419 Sprint 8 基线保留 + AI Manager 39）
- Playwright E2E: 80 passed（74 Sprint 8 基线保留 + z-ai-manager 6 条：
  Flow A Settings 掩码 / Flow B Chat / Flow C 权限隔离 / Flow D Provider
  失败隔离 / Flow E SQL 安全×2）
- lint / typecheck / build PASS
- Clean-environment bootstrap verified（空库 → alembic upgrade head → seed →
  FastAPI :8001 + Fake Provider :8099 → Next.js :3001 → Full Playwright）

### Status

Sprint 9 implementation complete（无 commit）；等待 Kun Fast QA；
`v1.0.0-alpha.9` 待 QA PASS 后发布。

## [v1.0.0-alpha.5] - 2026-08-28

### Added

- Sprint 5: Maintenance Operations & Room Readiness（维修运营与客房可用性闭环）
- MaintenanceWorkOrder 正式领域（Migration `a7f3e4c1d902`：PG 枚举 mwo_status /
  mwo_category / mwo_severity / mwo_source / unavailability_source、
  Sequence `maintenance_work_order_no_seq`、部分索引 `ix_mwo_active_blocking_room`）
- 工单闭环：报修（POST /maintenance/orders）→ 派工（assign）→ 开始维修（start）→
  提交解决（resolve）→ 验收通过 / 返工（verify / rework）→ 完成（COMPLETED）/
  取消（cancel，非终态）→ Room Ready；状态只能经 action 端点变更
  （PATCH strict：仅 category / severity / title / description）
- 工单单号 `MWO{YYYYMMDD}-{NNNN}`（PG Sequence 原子取号 + UNIQUE）
- `blocks_room` 与 `severity` 相互独立（CRITICAL 不自动阻断）；
  Active Blocking = OPEN / ASSIGNED / IN_PROGRESS / RESOLVED（RESOLVED 仍阻断）
- Room 新增 `unavailability_source`（MANUAL / MAINTENANCE）：历史 blocked/OOS 安全回填
  MANUAL + CHECK 约束；人工房态接口写 MANUAL、维修域写 MAINTENANCE
- 房态联动：available 房报修阻断 → 同事务 OOS+MAINTENANCE；occupied / reserved /
  blocked / MANUAL-OOS 保留原占用与来源；多张 blocking 工单按 Last Blocking 规则恢复；
  Maintenance 只能解除自己造成的 OOS；Cleaning 维度不受维修影响
- Availability / 预订预检 / Check-in 纵深防御排除 Active Blocking 工单（后端 409）；
  Checkout Maintenance-aware（有阻断工单 → OOS+MAINTENANCE+dirty，保洁任务照常创建）
- 固定锁顺序 Room → MaintenanceWorkOrder + 并发仲裁窄分类复用（40P01/40001 → 409）
- 维修 RBAC（5 个新权限，共 36 个权限码：SUPER_ADMIN / MANAGER 全部，
  FRONT_DESK / HOUSEKEEPING read+write，MAINTENANCE read+work，FINANCE 无）
- 维修审计（create / assign / start / resolve / verify / rework / cancel / update，
  含 Room become OOS / restore available 证据，后端自动生成）
- PII 隔离：工单不关联 Guest / Reservation / Stay，维修人员无 Guest PII 出口
- 维修工作台 `/maintenance`（状态视图 + 筛选 + 搜索）、工单详情 `/maintenance/[id]`、
  现场报修表单 `/maintenance/new`（Mobile 友好，`?room_id=&source=` 预填）
- Housekeeping 任务详情「发现设施问题 → 报修」（预填房间与 HOUSEKEEPING 来源）
- Front Desk Room / Reservation Quick View 展示 Active 工单
  （status / blocks_room / assignee / 查看维修，maintenance_order:read 才请求）
- PRE_OPENING 来源支持开业前 28 房整改清单（复用维修域）
- `GET /maintenance/assignees` 候选人端点（复用 Alpha.3 模式，不扩大 user:read）

### Fixed

- S5 Fast QA Blocking Defect「Future Reservation Maintenance Risk」：
  occupied Room + Active Blocking MaintenanceWorkOrder + current/future CONFIRMED
  Reservation 时，Front Desk 此前没有主动风险提示（Rule C 依赖 Room occupancy，
  而 occupied 房不因维修改 OOS，永不命中）。修复：Attention Center 新增
  Rule M「预订存在维修风险」——`Reservation.status == CONFIRMED`
  且 `check_in_date >= business_date` 且同房存在 `blocks_room=true` 且状态 ∈
  OPEN/ASSIGNED/IN_PROGRESS/RESOLVED 的工单（与 Room 占用状态无关，
  RESOLVED 仍报警，COMPLETED/CANCELLED/blocks_room=false 不产生）；
  一条预订一条卡片（多张工单合并计数「阻断性维修 N 项」+ 首张工单号）；
  M 优先抑制同预订 Rule C（避免重复风险卡片），MANUAL blocked/OOS 无工单时
  Rule C 继续工作；桌面 Attention Drawer 与 Mobile Today Board 共享
  computeAttention 并渲染「查看维修 →」直达链接；
  仅 `maintenance_order:read` 时加载工单数据（无权限不请求不显示、不扩大权限、
  不新增 Backend API、不改 Schema/状态机/Availability/Check-in/Checkout）。
  后端安全行为（Room 保持 occupied / Stay 保持 ACTIVE / Availability 排除 /
  Check-in 409）保持不变。

### Verified

- Backend pytest: 285 passed（后端零改动，Sprint 5 基线保留）
- Frontend Vitest: 300 passed（285 Sprint 5 基线保留 + 15 修复增量）
- Playwright E2E: 60 passed（59 Sprint 5 基线保留 + 缺陷修复正式场景 1 条）
- lint / typecheck / build PASS
- Clean-environment bootstrap verified（空库 → alembic upgrade head → seed → setup users →
  FastAPI :8001 → Next.js :3001 → Full Playwright）

### Known Issues

（沿用既有非阻塞四项，本轮未改变）

- `/rooms/9999` returns an HTTP 200 page while the underlying BFF resource returns 404.
- Starlette/httpx TestClient deprecation warning remains.
- Playwright E2E credentials require local gitignored configuration.
- `/health` does not currently include PostgreSQL readiness checks.

## [v1.0.0-alpha.4] - 2026-08-28

### Added

- Sprint 4: Front Desk Command Center & Room Diary（前台运营指挥台与房态日历，`/front-desk`）
- Today Summary（今日到店 / 今日离店 / 当前在住 / 空净房 / 需关注，卡片点击 → 右侧 Drawer）
- Room Diary：28 间房全量（无分页）× 1/7/14/30 天时间线；楼层分组、楼层/房型筛选、
  左侧房间栏固定（sticky）+ 日期区横向滚动（键盘可聚焦）；房间双状态（占用 + 清洁）同时展示
- Reservation Timeline 严格 `[check_in_date, check_out_date)`（无 off-by-one；相邻预订首尾相接）；
  默认只展示 CONFIRMED / CHECKED_IN（CANCELLED / NO_SHOW / COMPLETED 不作为占用条）
- 预订条：Guest name（guest:read）/ status / source；tooltip 受 RBAC/PII 控制
- Reservation Quick View Drawer（Room/Guest/Dates/Nights/Source/Amount/状态/占用/清洁/保洁任务 +
  Check-in / Edit / Cancel / No-show / Full Detail，全部复用 Sprint 2 API）
- §11 未准备房间：今日到店且非 clean → 隐藏 Check-in 主操作，显示「房间尚未准备完成」+
  Active HousekeepingTask（Task No/status/assignee）+ 查看保洁任务（后端 409 仍为最终权威）
- 点击空白日期格：新建预订（复用 `/reservations/new` 并预填 room_id / check_in /
  check_out=check_in+1，Backend Availability 仍重新验证）/ 查看房间
- 统一搜索：房号（本地匹配）/ Guest name / phone / reservation_no（复用现有 search API）；
  结果点击定位房间 / 定位日期 / 打开 Drawer；无 guest:read 时姓名/手机号搜索受限
- Attention Center 三条固定规则（A 脏房到店 / B 超期在住 / C 锁房未来预订），
  每项给出房间 / 问题 / 业务 / 下一步（无通用 Rule Engine）
- Room Quick View Drawer（双状态 + current stay + active housekeeping task +
  next reservation + 完整房间详情）
- Mobile（<768px）FrontDeskTodayBoard（不渲染完整 Room Diary）；768–1023 紧凑 Diary、≥1024 完整
- 写操作后 targeted refetch；60s 轻量轮询（Drawer 打开时暂停）
- Backend：`GET /reservations` 新增 `overlap_from` / `overlap_to` 日期窗口重叠查询
  （`check_in < overlap_to AND check_out > overlap_from`；只给一端或 to<=from → 422；
  只读扩展，不改变写操作）
- 前台导航入口（需 room:read + reservation:read 同时满足，不用角色名判断）

### Fixed

- D1（Kun Fast QA Blocking Defect）：并发 Double Booking 时 PostgreSQL 排他约束检查
  偶发 DeadlockDetected（40P01）逃逸为 500。修复（窄分类）：booking.py 在
  create/update/cancel/no-show/check-in/check-out 的 flush/commit 路径统一捕获
  OperationalError → rollback；仅 40P01（deadlock_detected）与 40001
  （serialization_failure）→ 409（create/update 映射 Double Booking 语义，其余映射
  各自通用冲突文案）；23P01 → 409 既有行为不变；其它任何 OperationalError
  （57014 query_canceled、无 pgcode、连接故障、库不可用等）→ 原样 re-raise，
  保持基础设施错误语义，绝不转换/吞掉。恢复「1 SUCCESS + 1 × 409」契约，
  数据完整性不变（每轮数据库 exactly 1 条）。新增 7 条 pytest（确定性映射 +
  57014/无 pgcode 原异常传播 + 事务回滚验证 + 25 轮真实并发无 500）；
  独立压测 50 轮服务层 + 50 轮 HTTP 层均 0 × 500 且每轮 exactly 1 条。

### Verified

- Backend pytest: 220 passed（202 Sprint 3 基线保留 + 11 overlap 窗口查询 + 7 D1 修复）
- Frontend Vitest: 240 passed（170 Sprint 3 基线保留 + 70 Front Desk）
- Playwright E2E: 46 passed（36 Sprint 3 基线保留 + front-desk 1 spec 10 条）
- lint / typecheck / build PASS
- Clean-environment bootstrap verified（空库 → alembic upgrade head → seed → setup users →
  FastAPI :8001 → Next.js :3001 → Full Playwright）

### Status

Sprint 4 implementation complete; D1（Fast QA Blocking）已修复；Kun Fast QA 复审 PASS（S4-D1 Re-QA：pytest 220 / Vitest 240 / Playwright 连续两轮 46 全绿；独立并发压测 100 轮 0 × 500）; v1.0.0-alpha.4 released.

## [v1.0.0-alpha.3] - 2026-08-28

### Added

- Sprint 3: Housekeeping Operations & Room Turnover（保洁运营与翻房闭环）
- HousekeepingTask 模型（Migration `77ec5f0c543e`：PG 枚举 hk_task_status / hk_task_source / hk_task_priority、Sequence housekeeping_task_no_seq、部分唯一索引 uq_housekeeping_tasks_active_room）
- Checkout 自动生成翻房任务（同一退房事务，失败整体回滚）
- Task 状态机（PENDING → IN_PROGRESS → INSPECTION → COMPLETED；INSPECTION → REWORK → IN_PROGRESS；取消）
- Task ↔ Room.cleaning_status 原子联动（与审计同事务）
- Active Task 数据库级唯一（一个 Room 至多一个进行中任务，并发创建 409）
- 手动任务创建（dirty 房间）+ 派单 / 改派 / 取消派单（GET /housekeeping/assignees 候选人端点）
- 保洁工作台 `/housekeeping` 与任务详情 `/housekeeping/[id]`；导航「保洁」
- Dashboard 保洁运营概览（待清扫 / 清扫中 / 待验房 / 返工）；Room Detail 保洁任务摘要
- Housekeeping RBAC（5 个新权限，共 31 个权限码；MANAGER 全部、FRONT_DESK read+write、HOUSEKEEPING read+work+inspect）
- Housekeeping 审计（create / assign / update / start / submit_inspection / pass / rework / cancel，无 PII）
- Check-in clean gating 保持（dirty / cleaning / inspection / rework → 409）
- Formal Playwright E2E：翻房 Golden Path / Rework 闭环 / 手动任务 / gating / 保洁 RBAC / 并发 / PII

### Verified

- Backend pytest: 202 passed（167 Sprint 2 基线保留）
- Frontend Vitest: 170 passed（139 Sprint 2 基线保留）
- Playwright E2E: 36 passed（29 Sprint 2 基线保留）
- Clean-environment bootstrap verified（空库 → alembic → seed → 全链路）

### Known Issues

（沿用既有非阻塞四项，本轮未改变）

- `/rooms/9999` returns an HTTP 200 page while the underlying BFF resource returns 404.
- Starlette/httpx TestClient deprecation warning remains.
- Playwright E2E credentials require local gitignored configuration.
- `/health` does not currently include PostgreSQL readiness checks.

### Status

Sprint 3 implementation complete; Kun Fast QA PASS（pytest 202 / Vitest 170 / Playwright 36 全绿）; `v1.0.0-alpha.3` released（Tag-only release convention）。

## [v1.0.0-alpha.2] - 2026-08-27

### Added

- Sprint 2: Booking & Stay Core Flow（预订、入住与退房核心链路）
- Guest management（创建 / 搜索 name-phone / 更新）
- Reservation（创建 / 编辑 CONFIRMED / cancel / no-show / check-in / 列表筛选与 search）
- Availability Engine（日期区间可售性，房型筛选，动态 Property Business Date Asia/Shanghai）
- Stay（check-in 创建 ACTIVE / check-out，Reservation COMPLETED 联动）
- Early Checkout（提前退房释放剩余日期）
- Booking RBAC（guest / reservation / stay 九权限，角色矩阵）
- PII protection（guest:read / reservation:read 后端裁剪 + 前端隐藏双保险）
- Booking Dashboard（今日到店 / 今日离店 / 当前在住 / 未来 7 天）与 Room Detail 集成
- Double Booking 并发保护（PostgreSQL daterange + EXCLUDE USING gist + btree_gist）
- Check-in / Check-out 原子事务
- Formal Playwright E2E（Golden Path / RBAC / PII / Concurrency / Failures / Early Checkout）

### Verified

- Backend pytest: 167 passed（87 Sprint 1 基线保留）
- Frontend Vitest: 139 passed（74 Sprint 1 基线保留）
- Playwright E2E: 29 passed（10 Sprint 1 基线保留）
- Sprint 2 Final Acceptance: PASS
- Clean-environment bootstrap verified（空库 → alembic → seed → 全链路）

### Known Issues

（沿用 Sprint 1 非阻塞四项，本轮未改变）

- `/rooms/9999` returns an HTTP 200 page while the underlying BFF resource returns 404.
- Starlette/httpx TestClient deprecation warning remains.
- Playwright E2E credentials require local gitignored configuration.
- `/health` does not currently include PostgreSQL readiness checks.

### Status

This release is an Alpha baseline and is not intended for production deployment.

## [v1.0.0-alpha.1] - 2026-08-26

### Added

- Next.js + TypeScript frontend
- FastAPI backend
- PostgreSQL database
- Alembic database migrations
- JWT authentication
- HttpOnly Cookie authentication through Next.js BFF
- RBAC role and permission system
- User management
- Role and permission management
- Room type management
- 28-room inventory
- Dual-dimensional room status model:
  - occupancy_status
  - cleaning_status
- Room status state machine
- Dashboard room overview
- Audit log system
- Vitest frontend test suite
- Playwright end-to-end test suite
- Docker PostgreSQL development environment
- Project documentation and agent development rules

### Verified

- Backend pytest: 87 passed
- Frontend Vitest: 74 passed
- Playwright E2E: 10 passed
- Clean-environment bootstrap verified
- Database migration and seed idempotency verified
- RBAC verified with multiple roles
- Failure and recovery scenarios verified
- Sprint 1 Final Acceptance: PASS

### Known Issues

- `/rooms/9999` returns an HTTP 200 page while the underlying BFF resource returns 404.
- Starlette/httpx TestClient deprecation warning remains.
- Playwright E2E credentials require local gitignored configuration.
- `/health` does not currently include PostgreSQL readiness checks.

### Status

This release is an Alpha baseline and is not intended for production deployment.
