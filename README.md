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

后端（`backend/`，Sprint 1 已完成）：

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

前端质量命令：`pnpm.cmd lint`、`pnpm.cmd typecheck`、`pnpm.cmd test`（Vitest）、`pnpm.cmd build`。

## 测试

```powershell
# 后端 pytest（独立测试库 stayops_test，285 用例 = 87 基线 + 76 Booking + 4 严格 PATCH + 35 Housekeeping + 11 Front Desk 窗口查询 + 7 D1 死锁窄分类 + 65 Maintenance）
cd backend
.venv\Scripts\python.exe -m pytest -q

# 前端单元/组件测试（Vitest，285 用例 = 74 基线 + 65 Booking UI + 31 Housekeeping UI + 70 Front Desk UI + 45 Maintenance UI）
cd frontend
pnpm.cmd test

# Playwright E2E（独立 stayops_test 库 + 专用端口 8001/3001，59 用例 = Sprint 1 基线 10 + S2-T3 新增 19 + S3 新增 7 + S4 新增 10 + S5 新增 13；不触碰开发数据）
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

## 文档

- [PRD](docs/PRD.md) — 产品需求
- [SPRINTS](docs/SPRINTS.md) — Sprint 计划
- [ARCHITECTURE](docs/ARCHITECTURE.md) — 架构
- [DATABASE](docs/DATABASE.md) — 数据库
- [API](docs/API.md) — API 约定
- [DECISIONS](docs/DECISIONS.md) — 架构决策记录

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

## Current Release

Version: v1.0.0-alpha.5

Status: Sprint 5 Fast QA PASS

This is the fifth stable Alpha development baseline of StayOps（Maintenance Operations & Room Readiness）。

Sprint 5 implementation complete; Kun Fast QA 首轮 FAILED（Blocking Product Defect：occupied Room + Active Blocking MWO + future CONFIRMED Reservation 时 Front Desk 无主动维修风险提示）；DSH 已修复（Attention Rule M：预订存在维修风险，桌面 + 移动共享）；Kun Fast RE-QA PASS（pytest 285 / Vitest 300 / Playwright 60 全绿；lint / typecheck / build PASS）; v1.0.0-alpha.5 released.

Not intended for production deployment.
