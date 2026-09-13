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

### Local Development（官方推荐入口）

> `start-dev.cmd` 是 StayOps 本地开发的**官方推荐启动方式**（仓库级永久规则，
> 见 [AGENTS.md](AGENTS.md) 的 Local Runtime Policy）。日常开发统一使用本入口，
> 不再长期手工分别裸启动 `uvicorn ...` 与 `pnpm dev`。

```powershell
start-dev.cmd              # 预检 -> 迁移检查 -> 启动前后端 -> 就绪校验 -> 运行摘要
start-dev.cmd --check      # 只检查（Git/端口/配置/文件/migration），不启动服务
start-dev.cmd --migrate    # 开发库迁移落后时显式 alembic upgrade head 后再启动
```

`start-dev.cmd`（内部为 `scripts/dev_runtime.py`，仅 Python 标准库 + Windows 系统工具，**不要求 PowerShell**）是本地开发运行环境加固的统一入口，防止「新 Frontend + 旧 Backend + 错误数据库版本」组成看似能运行的不一致环境：

- **Preflight**：打印 Git 分支 / HEAD / 精确 tag / 工作区摘要（普通修改仅 warning，`.kun-canvas/` 不算错误）
- **Port Safety**：8000 / 3000 被占用 → **FAIL FAST**（显示 PID，绝不自动杀未知进程；请自行停止旧进程后重试）
- **Migration Check**：检查开发库 `stayops` 的 `alembic current == heads`；不一致 → 停止并提示 `alembic upgrade head`（默认 CHECK ONLY，`--migrate` 才升级）
- **Backend**：`backend/.venv` 的 `uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload`（`--reload` 为本地开发硬要求；生产部署方式不受影响）
- **Frontend**：`pnpm.cmd dev`（继续使用 `frontend/.env.local` 的 `BACKEND_API_URL`；启动前校验其指向 `127.0.0.1:8000`）
- **Readiness**：轮询 `/health` 与 `/openapi.json`（必须包含已发布核心路由 Rooms / Reservations / Housekeeping / Maintenance，防止启动到旧 Backend），再确认 `http://localhost:3000/login`；Frontend 超时 → 显式 `FRONTEND START FAILED` 并关闭 Backend，不留半套环境
- **停止**：`Ctrl+C` 同时关闭 Backend + Frontend 进程树，不遗留 stale uvicorn

> 不再推荐长期手工分别启动裸 `uvicorn ...` 与 `pnpm dev`（统一入口避免旧进程残留事故）。

后端手动准备（首次或需要独立调试时，`backend/`）：

```powershell
cd backend
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe -m alembic upgrade head
.venv\Scripts\python.exe -m app.seed          # 幂等种子数据
```

- 健康检查：`http://localhost:8000/health`
- 开发管理员：`admin` / `Admin@123456`（仅开发环境）

前端（`frontend/`，Next.js 16 + TypeScript strict + Tailwind；认证采用 HttpOnly Cookie + BFF，详见 [docs/DECISIONS.md](docs/DECISIONS.md)）：

```powershell
cd frontend
pnpm.cmd install
Copy-Item .env.example .env.local   # BACKEND_API_URL / NEXT_PUBLIC_APP_NAME
```

> 前后端由 `start-dev.cmd` 统一启动；后端在 `http://127.0.0.1:8000`、前端在 `http://localhost:3000`。前端不接触 Token：登录后 JWT 只存在 HttpOnly Cookie，其余 API 统一走 `/api/bff/*` 由服务端附加 Bearer 转发。

前端质量命令：`pnpm.cmd lint`、`pnpm.cmd typecheck`、`pnpm.cmd test`（Vitest）、`pnpm.cmd build`。

## Desktop（Windows 桌面客户端）

> 里程碑：Desktop D1（v1.0.0-alpha.9.3）——把 StayOps 封装为可双击使用的 Windows 客户端（Electron + Next.js Production standalone + FastAPI Production + StayOps 自管理 PostgreSQL）。完整说明见 [docs/DESKTOP.md](docs/DESKTOP.md)。

- 双击 `desktop/dist/win-unpacked/StayOps.exe` → 启动窗口 → 自动检查 Runtime → 自管理 PostgreSQL（init/start/ready/建库）→ Alembic 检查 → 启动后端（127.0.0.1:8100）与前端（127.0.0.1:3100，Production standalone）→ 打开 StayOps 主窗口（1440×900）。`StayOps-Portable-*.exe` **尚未正式交付**（见下方 D1 限制）。
- 普通使用**不需要**打开 PowerShell / CMD / VS Code / DSH；全程零控制台弹窗。
- 独立端口：Backend `8100`、Frontend `3100`（仅 127.0.0.1），与开发模式（8000/3000）、E2E（8001/3001）互不冲突。
- 数据库与迁移：启动时只读检查 `stayops` 库 `alembic current == heads`；落后时显示「数据库需要升级」并由用户确认后才 `upgrade head`（多 head Fail Safe，绝不自动降级）。
- 日志：`%LOCALAPPDATA%\StayOps\logs\{desktop,backend,frontend}.log`（自动 scrub DATABASE_URL 密码 / DeepSeek Key / AI_ENCRYPTION_KEY / Authorization）。
- 桌面构建：

```powershell
cd desktop
pnpm.cmd install
pnpm.cmd build:frontend   # Next standalone -> frontend/.next-desktop/standalone（桌面专用，不影响开发 .next）
pnpm.cmd dist             # tsc 编译 + electron-builder -> desktop/dist/win-unpacked/StayOps.exe
pnpm.cmd dist:portable    # 实验性：Portable 目标尚未正式交付（standalone node_modules 未自包含）
pnpm.cmd test             # 桌面自动化测试（Vitest）
```

- D1 依赖：仍依赖 StayOps 工作区 runtime layout（`backend/.venv`、`frontend/node_modules`、Node.js、`runtime/postgres` 二进制；打包后可经 `STAYOPS_ROOT` 指向工作区）。PostgreSQL 已由 Desktop 自管理（`runtime/postgres` + `%PROGRAMDATA%\StayOps\PostgreSQL`，仅 `127.0.0.1:5433`），不再依赖 Docker / 系统 PostgreSQL；但仍**不是**完整独立安装版：无安装器 / 自动更新 / 代码签名，也未完成完整 runtime bundling（见 [docs/DESKTOP.md](docs/DESKTOP.md) §11/§12）。
- Desktop 与开发模式互不影响：Desktop 只运行 Production build/runtime（无 `next dev`、无 `--reload`、无 watcher）；`start-dev.cmd` 开发流程保持不变。

## 测试

```powershell
# 后端 pytest（独立测试库 stayops_test，646 用例；含 P0 并发 stress）
cd backend
.venv\Scripts\python.exe -m pytest -q

# 前端单元/组件测试（Vitest，462 用例 / 59 个测试文件）
cd frontend
pnpm.cmd test

# Playwright E2E（独立 stayops_test 库 + 专用端口 8001/3001，80 用例；不触碰开发数据）
cd frontend
Copy-Item e2e\test-creds.example e2e\.env.test-creds   # 首次：填入测试库凭据（gitignored）
pnpm.cmd test:e2e
```

> pytest 与 Playwright E2E 共享 `stayops_test` 库且互斥，两者不得并行运行。
> E2E 覆盖（S2-T3）：Golden Path（预订→重叠 409→当天入住/退房→审计无 PII）、
> Early Checkout（COMPLETED 释放剩余日期）、Booking RBAC、PII 三层防护（HOUSEKEEPING）、
> 并发专项（Double Booking / 并发 Check-in / Check-out 各 1 SUCCESS + 1 × 409）、
> 失败处理（409/404/401 语义）。
> E2E 覆盖（S3）：翻房 Golden Path（退房自动任务 → 派单 → 清扫链 → 通过 → 下一笔入住成功）、
> Rework 闭环、手动任务与取消、Check-in clean gating、保洁 RBAC / 并发 / PII。
> E2E 覆盖（S4）：Front Desk Golden Path（空白格快速新建 → [ci,co) 时间线 →
> Drawer Check-in → 刷新 → Check-out → dirty + 保洁任务）、相邻预订首尾相接、
> Attention 三规则（脏房到店 / 超期在住 / 锁房未来预订）、Housekeeping 完成闭环后
> Check-in、搜索定位、PII、RBAC、Mobile Today Board / Tablet；
> E2E 覆盖（S5）：维修 Golden Path（保洁发现 → 阻断报修 → 派工 → 维修 → 验收 →
> 房间恢复 → 清洁后 Check-in Ready + 全链路审计）、PRE_OPENING、Mobile 报修表单、
> occupied blocker / future reservation / multiple blockers / Rework / Cancel /
> Manual OOS 保护 / Check-in 409 / RBAC / PII / 完成 ≠ 清洁；
> 详见 [frontend/e2e/README.md](frontend/e2e/README.md)。

详见 [tests/README.md](tests/README.md)、[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 预订运营（Sprint 2 · S2-T2）

- 页面：`/reservations`（列表/筛选/分页）、`/reservations/new`（Guest 搜索创建 + Availability 选房）、`/reservations/[id]`（CONFIRMED 编辑、Cancel / No-show / Check-in）、`/stays`（在住列表）、`/stays/[id]`（Check-out）
- 扩展：`/dashboard`（今日到店 / 今日离店 / 当前在住 / 未来 7 天预订）、`/rooms/[id]`（当前 Stay / 下一笔预订）
- 导航按权限显示：`reservation:read` → 预订、`stay:read` → 在住；HOUSEKEEPING 等角色不可见且直连 403
- 业务日期统一 Asia/Shanghai；日期区间 `[check_in_date, check_out_date)`；409/422 展示后端原文

## 保洁运营（Sprint 3）

- 页面：`/housekeeping`（保洁运营工作台：待清扫/清扫中/待验房/返工/已完成状态视图、任务卡片、快捷操作、新建任务）、`/housekeeping/[id]`（任务详情：派单/优先级/备注 + 操作确认）
- 退房自动生成翻房任务（同一事务）：`Check-out → Task PENDING → 派单 → 开始清扫 → 提交验房 → 通过/返工 → COMPLETED + Room clean`，下一笔预订即可入住
- Active Task 数据库级唯一（部分唯一索引）；Task 状态与 Room.cleaning_status 原子联动
- 导航按权限显示：`housekeeping_task:read` → 保洁；RBAC：MANAGER 全部、FRONT_DESK read+write、HOUSEKEEPING read+work+inspect
- 任务不保存任何 Guest PII；Check-in 要求 `cleaning_status = clean`（dirty/cleaning/inspection/rework → 409）

## 前台运营（Sprint 4）

- 页面：`/front-desk`（前台运营指挥台：Today Summary / 统一搜索 / Room Diary / 右侧 Drawer）
- Today Summary：今日到店 / 今日离店 / 当前在住 / 空净房 / 需关注（卡片点击 → Drawer 列表，不跳离页面）
- Room Diary：28 间房 × 1/7/14/30 天时间线；楼层分组 + 楼层/房型筛选；左侧房间栏固定（sticky）；
  房间双状态（占用 + 清洁）同时展示；时间线严格 `[check_in_date, check_out_date)`（无 off-by-one）
- Reservation Bar：Guest name（guest:read）/ status / source；点击打开 Reservation Drawer
  （Check-in / Edit / Cancel / No-show / Full Detail，全部复用 Sprint 2 API）
- 脏房到店明确显示「房间尚未准备完成」+ 保洁任务（Task No / status / assignee / 查看保洁任务）；
  后端 Check-in 409 仍是最终权威
- 点击空白日期格：新建预订（复用 `/reservations/new` 预填 room/check_in/check_out=+1，
  Availability 仍重新验证）/ 查看房间
- 统一搜索：房号 / Guest name / phone / reservation_no（PII 受 guest:read 约束）
- Attention Center 固定规则：脏房到店（A）/ 超期在住（B）/ 锁房未来预订（C）/
  预订存在维修风险（M，Sprint 5 修复：CONFIRMED 且 check_in ≥ 今日 + Active Blocking MWO，
  与 Room 占用状态无关；多张工单合并为一条；Maintenance 规则优先于 C 避免重复）
- Mobile（<768px）：FrontDeskTodayBoard（不渲染完整 Room Diary）；768–1023 紧凑 Diary
- 导航按权限显示：`room:read` + `reservation:read` 同时满足 → 前台；
  SUPER_ADMIN / MANAGER / FRONT_DESK 可见，HOUSEKEEPING / MAINTENANCE / FINANCE 隐藏
- Backend 最小扩展：`GET /reservations?overlap_from&overlap_to` 日期窗口重叠查询（只读）

## 维修运营（Sprint 5）

- 页面：`/maintenance`（维修运营工作台：待处理/已派工/维修中/待验收/阻断客房/今日完成 +
  分类/严重度/来源/阻断/负责人筛选 + 搜索）、`/maintenance/[id]`（工单详情：房间双状态、
  时间线、派工/编辑 + Assign/Start/Resolve/Verify/Rework/Cancel）、
  `/maintenance/new`（现场报修表单，Mobile 友好，`?room_id=&source=` 预填）
- 闭环：`报修 → 派工 → 开始维修 → 提交解决 → 验收/返工 → 完成 → 房间恢复可售 → 清洁后 Ready`
- `blocks_room`（阻断客房销售）与 `severity` 相互独立；RESOLVED 仍阻断（维修完成 ≠ 验收通过）
- Room 新增 `unavailability_source`（MANUAL / MAINTENANCE）：available 房报修阻断 →
  同事务 OOS+MAINTENANCE；occupied/reserved/blocked/MANUAL-OOS 不被覆盖；
  Maintenance 只能解除自己造成的 OOS；多张工单时按 Last Blocking 规则恢复
- Availability / Check-in 排除 Active Blocking 工单（后端 409 最终权威）；
  Checkout Maintenance-aware（有阻断工单 → OOS+MAINTENANCE+dirty，保洁任务照常）
- Housekeeping 任务详情「发现设施问题 → 报修」；Front Desk Quick View 展示 Active 工单
- PRE_OPENING 来源支持开业前 28 房整改清单（复用维修域，不做独立开业模块）
- 导航按权限显示：`maintenance_order:read` → 维修；
  RBAC：SUPER_ADMIN / MANAGER 全部，FRONT_DESK / HOUSEKEEPING read+write，
  MAINTENANCE read+work，FINANCE 无
- 工单不保存任何 Guest PII；8 个 action 全链路审计（后端自动，含房态恢复证据）

## 住中换房（Sprint 6）

- 领域模型：Reservation = 商业预订 / 未来房间分配（Check-in 后 `room_id` 冻结为原分配房）；
  Stay = 实际住宿（`room_id` = 当前实际房间）；StayRoomAssignment = 实际住宿期间的房间历史
  （`ended_at = NULL` = 当前 active assignment）；换房不创建第二个 Stay
- API：`GET /stays/{id}/room-move-options`（后端权威目标房候选 + 不可选原因）+
  `POST /stays/{id}/room-move`（原子换房：目标房资格事务内重校验、旧房释放、
  ROOM_MOVE 保洁任务、目标房 occupied、审计 stay.room_move）；权限 `stay:room_move`
  （SUPER_ADMIN / MANAGER / FRONT_DESK）
- 入口：Front Desk 当前在住抽屉 / 移动 Today Board [换房] + Stay 详情页换房对话框
  （7 个固定原因、显式「确认换房」）；Room Diary 时间线 = CONFIRMED 预订条 +
  ACTIVE Stay 在住条（当前实际占用）；Stay 详情展示房间记录 + 原分配房 vs 当前在住房
- 并发安全：Room Row Lock + 事务内重校验；全局锁顺序
  `(Reservation | Stay) → Rooms(pk 升序) → MWO`；Reservation 排他约束调整为
  CONFIRMED-only；40P01/40001 → 409，其余数据库错误原样传播
- 旧房释放复用 S5 maintenance-aware 语义（阻断维修 → OOS+MAINTENANCE；人工停用保持）；
  换房绝不触碰原房维修工单生命周期

## 库存与采购（Sprint 7）

- 页面：`/inventory`（库存工作台：总物资/低库存/缺货/地点统计 + 物资表格 +
  搜索/分类/低库存/缺货筛选 + 新建物资/领用/调拨/盘点）、`/inventory/items/[id]`
  （物资详情：总/最低/目标/建议补货 + 地点余额（停用标记）+ 最近流水 +
  期初库存/编辑）、`/procurement`（采购工作台：低库存建议/待审批/已批准待转单/
  待收货/部分收货）、`/procurement/suppliers`、`/procurement/requests(/[id])`、
  `/procurement/orders(/[id])`（部分收货表单 + 收货记录）
- LOCKED 架构：StockMovement = 永久库存账本事实（无 PATCH/DELETE）；
  InventoryBalance = 快速查询 Projection；**no movement = no stock change**
  （流水+余额同事务）；无直接 balance PATCH；无负库存（FOR UPDATE + recheck +
  DB CHECK）；多库存地点；无自动客耗扣账（Checkout / Housekeeping / Room Move 不扣库存）
- 业务动作：期初库存（INITIAL 专用动作）/ 领用（多行整体原子）/ 归还 / 调拨
  （OUT↔IN 成对，总库存不变）/ 盘点（差异 → ADJUSTMENT_IN/OUT，平账 no-op）
- 采购闭环：申请（DRAFT→SUBMITTED→APPROVED→ORDERED）→ 审批（申请与审批分离）→
  订单（DRAFT→ORDERED→PARTIALLY_RECEIVED→RECEIVED）→ 收货（**收货才增加库存**，
  部分收货支持，超收整体回滚）；Request→PO exactly-once；**PO 不改变库存**；
  金额 Decimal（不做付款/应付/发票/税务）
- 低库存：total==0 → OUT_OF_STOCK、total<=minimum → LOW_STOCK；
  建议补货 = max(target-total, 0)（仅建议，不自动下单）
- RBAC：11 个新权限码（共 48）；inventory:adjust/transfer/item_manage 与
  procurement:approve/order/supplier_manage 仅 SUPER_ADMIN/MANAGER；
  procurement:receive 授予 SUPER_ADMIN/MANAGER/FRONT_DESK；
  导航 库存=inventory:read、采购=procurement:read（后端 403 兜底）
- 并发安全（Lock Graph）：Inventory 事务只锁 Balance 行（(item_id, location_id)
  升序）；收货 = PO → PO lines → Balance 行；全局无环；P0 stress 7 场景 × 10 轮
  真实 PostgreSQL（unexpected 500 = 0、死锁 = 0）；Ledger == Balance 对账；
  19 个审计 action

## 经营分析（Sprint 8）

- 页面：`/analytics`（经营分析管理驾驶舱，四 Tab：总览 / 客房与预订 / 运营效率 /
  库存与采购；顶部统一 Date Selector：过去7天 / 过去30天 / 过去90天 / 本月 /
  上月 / 自定义（默认 30 天）+「与上一周期对比」；KPI Cards + 折线/柱状图 +
  排名表，Mobile 自适应）
- LOCKED 架构：Analytics = **read-only derived layer**——正式业务表仍是
  Source of Truth；不建立第二套业务事实表，无 ETL、无自动物化；Backend 是
  指标计算唯一权威，Frontend 只 request → format / visualize
- Actual 与 On-Books / Forecast 严格分离；全部区间 `[from, to)` +
  Business Date（Asia/Shanghai）；Actual 至多统计到业务日期当天之前（§3）
- 占用：酒店总体实际房晚 MUST derive from Stay（Room Move 防重复计数）；
  Physical Occupancy ✅ / Sellable Occupancy ❌；On-Books 7/14/30
  （CONFIRMED + ACTIVE remaining，distinct 房晚去重）
- 经营：合同房费金额 / 合同 ADR / 合同 RevPAR（非实际收款语义；无价房晚显式暴露）
- 运营：保洁（完成/周期/翻房/积压）、维修（MTTR/验收/阻断/高频报修房间）、
  换房（次数/换房率/原因/换出房）；库存（每物资每单位领用量与强度，不跨单位
  求和）；采购（到货采购金额按收货日归属，≠ 已付款）
- 对比（§31/§32 + D1）：`comparison_mode` = equal_length（7/30/90 天、自定义）/
  previous_calendar_month（上月）/ previous_month_elapsed（本月，clamp 于上月
  月末）；比率 → percentage points；数量/金额/平均 → percent（previous=0 →
  null，无 Infinity%）；零数据 0 / null / []（Pre-opening 安全）
- RBAC：`analytics:operations_read`（SUPER_ADMIN/MANAGER/FRONT_DESK）与
  `analytics:business_read`（SUPER_ADMIN/MANAGER/FINANCE）——共 50 权限码；
  无权限域不请求不显示（后端 403 兜底）；Analytics 不返回 Guest / Supplier
  联系信息（PII）
- 指标字典：见 [docs/ANALYTICS.md](docs/ANALYTICS.md)

## AI 店长（Sprint 9 · DeepSeek AI Manager）

- 页面：`/ai-manager`（AI 店长 Chat：消息列表/输入/发送/loading/error/retry/
  新对话 + 6 个快捷问题 + 未配置 DeepSeek 提示（有/无管理权限两种）+ 会话恢复）、
  `/settings/ai`（DeepSeek 配置：状态卡 + type=password API Key 输入（保存后
  清空）+ Test Connection + Remove Key）
- 架构：`/ai-manager → Backend → DeepSeek API → S8 Analytics + 只读 SQL`；
  不是复杂 Agent 平台——DeepSeek 只有 `get_analytics` 与
  `query_stayops_database` 两个只读工具，**没有任何写工具**
- 三条安全规则 LOCKED：AI 数据库访问 = 只读；DeepSeek API Key = Backend only
  （Fernet 加密落库，前端只能看到 `sk-****abcd` 掩码，无读取完整 Key 的接口）；
  AI 无写能力（Prompt 要求删除订单/改房态/停售/审批采购/改库存也做不到）
- 只读 SQL 双层保护：应用层词法 Validator（只允许 SELECT / WITH...SELECT，
  写/DDL/DCL 关键字与多语句拒绝）+ 数据库层 `stayops_ai_reader` 只读 Role
  （仅 SELECT 21 个 `ai_*` 视图，无任何基表权限）+ READ ONLY 事务 +
  超时 + 行数上限（默认 200 / 硬上限 500）
- **AI 可见数据 = 当前用户既有权限**：`analytics:operations_read`（运营域）与
  `analytics:business_read`（经营域）继承；Guest PII 与敏感字段在视图层
  物理排除；FRONT_DESK 拿不到经营数据、FINANCE 拿不到运营数据
- RBAC：`ai_manager:use`（SUPER_ADMIN/MANAGER/FRONT_DESK/FINANCE）、
  `ai_manager:manage`（SUPER_ADMIN/MANAGER）——共 52 权限码；导航按权限显隐，
  后端 403 兜底
- Provider 失败（timeout/401/429/5xx/网络/malformed）只影响 /ai-manager：
  返回 AI_NOT_CONFIGURED / AI_AUTH_FAILED / AI_RATE_LIMITED /
  AI_PROVIDER_UNAVAILABLE / AI_TIMEOUT / AI_RESPONSE_INVALID 业务码，
  S1-S8 全部页面不受影响
- 测试：pytest 用 FakeDeepSeekClient（确定性，不依赖网络）；Playwright 用本地
  Fake DeepSeek Provider（127.0.0.1:8099，绝不向真实 DeepSeek 发送 fake key）
- 详细文档：见 [docs/AI_MANAGER.md](docs/AI_MANAGER.md)

## 文档

- [PRD](docs/PRD.md) — 产品需求
- [SPRINTS](docs/SPRINTS.md) — Sprint 计划
- [ARCHITECTURE](docs/ARCHITECTURE.md) — 架构
- [DATABASE](docs/DATABASE.md) — 数据库
- [API](docs/API.md) — API 约定
- [DECISIONS](docs/DECISIONS.md) — 架构决策记录
- [ANALYTICS](docs/ANALYTICS.md) — 经营分析指标字典（Sprint 8）
- [AI_MANAGER](docs/AI_MANAGER.md) — DeepSeek AI 店长（Sprint 9）

## 开发规则

所有 AI Coding Agent 与开发者必须先阅读 [AGENTS.md](AGENTS.md)。

> 当前状态：Sprint 1 完成并冻结（v1.0.0-alpha.1）；Sprint 2 完成（Booking & Stay Core Flow），Final Acceptance PASS；
> Sprint 3 完成（Housekeeping Operations & Room Turnover：退房自动翻房任务 / 派单 / 清扫链 / 返工闭环 / 保洁工作台 / 保洁 RBAC / 并发安全），
> Kun Fast QA PASS，v1.0.0-alpha.3 已发布。
> Sprint 4 完成（Front Desk Command Center & Room Diary：前台运营指挥台 / 房态日历 / 快速新建 / 统一搜索 / Attention Center / 移动端 Today Board），
> Kun Fast QA PASS（含 Blocking Defect D1 修复复审），v1.0.0-alpha.4 已发布。
> Sprint 5 完成（Maintenance Operations & Room Readiness：维修工单领域 / 阻断语义 / 派工维修验收闭环 /
> 房间不可售来源 / Availability·Check-in·Checkout 集成 / 保洁·前台最小集成 / PRE_OPENING / RBAC / PII / 审计 / 并发安全），
> Kun Fast QA 首轮发现 Blocking Defect（occupied + blocking 工单 + 未来预订 → 前台无主动维修风险提示）已修复，
> Fast RE-QA PASS（pytest 285 / Vitest 300 / Playwright 60 / lint / typecheck / build 全绿），v1.0.0-alpha.5 已发布。
> Sprint 6 开发完成并已发布（Room Move & In-Stay Recovery：在住房间分配历史 / 原子换房 / Room Row Lock 并发模型 /
> CONFIRMED-only 排他约束 / Front Desk 换房入口 / Room Diary 实际占用语义），
> Kun Fast QA PASS，v1.0.0-alpha.6 已发布（2791c8b）。
> Sprint 7 开发完成（Inventory & Procurement：库存账本 / 多地点 / 领用调拨盘点 /
> 低库存 / 采购申请审批 / 采购订单 / 部分收货闭环 / RBAC / 审计 / P0 并发安全），
> 自测全绿（pytest 379 / Vitest 379 / Playwright 64 + inventory-procurement 4 条 /
> lint / typecheck / build），等待 Kun Fast QA；`v1.0.0-alpha.7` 待 QA PASS 后发布。
> Sprint 8 开发完成（Business Analytics：经营分析与管理驾驶舱——Metric
> Dictionary / Analytics Service（read-only derived layer）/ operations 与
> business 权限域 API / /analytics 四 Tab / On-Books Forecast / 周期对比 /
> Golden Dataset / RBAC / PII），自测全绿（pytest 416 / Vitest 414 /
> Playwright 64 + analytics 5 条 / lint / typecheck / build），等待 Kun Fast QA；
> `v1.0.0-alpha.8` 待 QA PASS 后发布。
> Sprint 8 QA 修复完成（D1 Calendar Comparison Modes：equal_length /
> previous_calendar_month / previous_month_elapsed（月末 clamp）；D2 E2E
> Backdate 脚本安全：stayops_test 硬守卫 + 显式行 ID + 单事务），
> 自测全绿（pytest 440 / Vitest 419 / Playwright 74 / lint / typecheck / build），
> 等待 Kun Re-QA；`v1.0.0-alpha.8` 待 Re-QA PASS 后发布。
> Sprint 9 开发完成（DeepSeek AI Manager：/ai-manager Chat + /settings/ai 配置 +
> DeepSeekClient（集中封装，Provider 失败隔离）+
> get_analytics（S8 Analytics 权限域继承）+
> query_stayops_database（词法 Validator + stayops_ai_reader 只读 Role +
> READ ONLY 事务 + 行数上限双层保护）+ ai_* 视图（Guest PII 物理排除）+
> API Key Fernet 加密 + 掩码 + Fake Provider 测试体系），
> 自测全绿（pytest 603 / Vitest 458 / Playwright 80 / lint / typecheck / build），
> 等待 Kun Fast QA；`v1.0.0-alpha.9` 待 QA PASS 后发布。

## Current Release

Version: v1.0.0-alpha.8（当前正式基线，Sprint 8 Release）

Status: Sprint 9 IMPLEMENTATION COMPLETE（DeepSeek AI Manager）— 等待 Kun Fast QA

This is the ninth Alpha development baseline of StayOps（DeepSeek AI Manager）。

Sprint 9 implementation complete（无 commit）：pytest 603 / Vitest 458 / Playwright 74 + ai-manager 6 条全绿；lint / typecheck / build PASS；开发库 stayops seed 幂等收敛至 52 权限码；Alembic head = `f5d3b9e7a2c4`（AI Manager 域迁移：ai_settings/ai_conversations/ai_messages + 21 个 ai_* 只读视图 + stayops_ai_reader 只读 Role）。待 Kun Fast QA PASS 后创建 `v1.0.0-alpha.9` Release Commit。

Not intended for production deployment.
