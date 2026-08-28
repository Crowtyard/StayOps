# Sprint 1

## 技术栈

```text
Frontend    Next.js
            TypeScript

Backend     FastAPI
            Python

Database    PostgreSQL

Deployment  Docker Compose
```

## Sprint 1 只开发

```text
登录
用户
角色
RBAC 权限
房型
房间
Audit Log
```

## 预计数据表

```text
users
roles
permissions
user_roles
rooms
room_types
audit_logs
```

## 初始角色

```text
SUPER_ADMIN
MANAGER
FRONT_DESK
HOUSEKEEPING
MAINTENANCE
FINANCE
```

## 后续

初始化 28 个测试房间（对应济南历下区 CBD 项目约 28 间客房）。

## Sprint 1 进度（截至 T3a）

- ✅ T1：环境准备（Docker Compose / PostgreSQL / FastAPI 骨架 / 种子数据）
- ✅ T2：认证 + RBAC + 业务 API + 房态双维度状态机 + 审计（28 间种子房）
- ✅ T3a：前端核心链路——Next.js 16 + TS strict + Tailwind；认证 BFF（/api/auth/*，HttpOnly Cookie）+ 通用代理（/api/bff/*）；统一 API Client；权限化统一 Layout（侧边导航/顶栏/手机 Drawer）；/login、/dashboard（真实房态概览）、/rooms（双维度棋盘+筛选）、/rooms/[id]（真实状态机修改+确认框）；Loading/Empty/Error 与离线态。质量：`pnpm lint` / `pnpm typecheck` / `pnpm build` 全过；curl 冒烟真实复验通过（登录→HttpOnly Cookie→me→28 间房→详情→合法/非法状态转换→审计链路、RBAC 403、401/403 区分、离线 502）。Playwright 冒烟**尚未实施**（仓库无 Playwright 配置或测试文件，此前“Playwright 冒烟全过”的描述不实，已更正），归入 T3b。
- ✅ T3b：管理页面 + 前端测试体系——/settings/users（创建/编辑/启用停用/分配角色/删除）、/settings/roles（CRUD + 权限查看与修改，role:write 可改权限）、/settings/room-types（CRUD，删除有房间房型显示后端 409）、/settings/audit-logs（操作类型/资源类型筛选 + details 展开，不整块 JSON 塞表格）；导航移除 T3b 占位角标；403 统一“无权限访问该页面”且不跳登录。Vitest（jsdom + Testing Library）：11 个测试文件 74 条用例全过（Auth 登录成功/失败/网络、RBAC 导航显隐、Rooms 28 房展示/reserved+dirty 双维度/合法与非法转换/确认框、Audit 展开与筛选、四个 Settings 视图）。Playwright E2E 正式入库（10 条用例，独立 stayops_test 库 + 专用后端 127.0.0.1:8001 + 前端 localhost:3001，不碰 dev 数据）：管理员登录→Dashboard→房态→28 房→合法状态修改→刷新保持、blocked 确认框、FRONT_DESK/HOUSEKEEPING 导航收窄 + 直连 403 + 无权限 UI、退出后守卫、四个管理页真实读取、房态变更→审计日志真实记录。质量门禁：`pnpm lint` / `pnpm typecheck` / `pnpm test`（Vitest 74 用例）/ `pnpm build` / `pnpm test:e2e`（Playwright 10 用例）/ 后端 `pytest`（87 用例）全部通过。

## Sprint 1 Release Baseline

Status: FINAL ACCEPTANCE PASS

Final Acceptance Commit:

a8b13ce2d00f1e8d48512d57fba93e56506d8e07

Release:

v1.0.0-alpha.1

Sprint 1 is frozen as the first stable StayOps development baseline.

Future development must build on top of this baseline through subsequent commits.

## Sprint 2（COMPLETE）

```text
Sprint 2                = COMPLETE
正式名称                = Booking & Stay Core Flow（预订、入住与退房核心链路）
Release                 = v1.0.0-alpha.2（RELEASED）
Sprint 2 PRD            = FINAL
Sprint 2 Task Spec      = APPROVED
Sprint 2 Coding         = COMPLETE（S2-T1、S2-T2、S2-T3 全部完成）
S2-T1                   = COMPLETE · QA PASS · CHECKPOINTED
S2-T2                   = COMPLETE · QA PASS · CHECKPOINTED
S2-T3                   = COMPLETE · QA PASS · CHECKPOINTED
Sprint 2 Final Acceptance = PASS
DSH                     = IDLE
Kun                     = PROJECT MANAGER + QA
```

任务书（docs/tasks/sprint-02/）：

- README.md — 总纲：Golden Path、不可违反架构规则、RBAC、错误语义、Out of Scope、回归基线、Git 规则
- S2-T1.md — Booking Domain Foundation（后端）
- S2-T2.md — Booking Operations UI（前端）
- S2-T3.md — Integration & E2E（全链路验收）

Sprint 2 进展：S2-T1（Booking Domain Foundation）、S2-T2（Booking Operations UI）、S2-T3（Integration & E2E）全部完成并通过独立 QA；Sprint 2 Final Acceptance PASS（pytest 167 / Vitest 139 / Playwright 29 全绿）；`v1.0.0-alpha.1` 冻结不动，`v1.0.0-alpha.2` 已创建为 Sprint 2 Release Commit。

## Sprint 3（COMPLETE）

```text
Sprint 3                = COMPLETE
正式名称                = Housekeeping Operations & Room Turnover（保洁运营与翻房闭环）
Release                 = v1.0.0-alpha.3（RELEASED）
开发模式                = FAST TRACK + REUSE FIRST + ONE SPRINT / ONE DSH SESSION
Sprint 3 Coding         = IMPLEMENTATION COMPLETE（单会话一次完成）
Sprint 3 Fast QA        = PASS（Kun 独立重跑 pytest 202 / Vitest 170 / Playwright 36 全绿）
DSH                     = STOPPED
Kun                     = PROJECT MANAGER + QA
```

任务书：`docs/tasks/sprint-03/README.md`（单文档，不再拆分 S3-T1/T2/T3）。

Sprint 3 范围：退房自动生成 Housekeeping Task（同一事务）→ 派单 → 开始清扫 → 提交验房 → 通过/返工 → 房间翻房闭环；Active Task 数据库级唯一（部分唯一索引）；Task 状态与 Room.cleaning_status 原子联动；保洁工作台（`/housekeeping` / `/housekeeping/[id]`）；Dashboard 与 Room Detail 集成；Check-in clean gating 保持；保洁域 RBAC / 审计 / 并发安全 / 无 PII。

Sprint 3 进展：DSH 单会话完成全部实现（Implementation Complete，无 commit）；Kun Fast QA 独立重跑正式测试全绿（pytest 202 / Vitest 170 / Playwright 36，Sprint 2 基线 167 / 139 / 29 全部保留），代码审查确认 Checkout 原子性、Active Task 数据库级部分唯一索引、Task ↔ Room 原子联动、RBAC / PII / Check-in gating；`v1.0.0-alpha.2` 冻结不动，`v1.0.0-alpha.3` 已创建为 Sprint 3 Release Commit。

## Sprint 4（COMPLETE）

```text
Sprint 4                = COMPLETE
正式名称                = Front Desk Command Center & Room Diary（前台运营指挥台与房态日历）
Release                 = v1.0.0-alpha.4（RELEASED）
开发模式                = FAST TRACK + REUSE FIRST + ONE SPRINT / ONE DSH SESSION（不拆 T1/T2/T3）
Sprint 4 Coding         = IMPLEMENTATION COMPLETE（单会话一次完成）
Sprint 4 Fast QA        = PASS（Kun 独立重跑 pytest 220 / Vitest 240 / Playwright 46×2 全绿 + D1 修复复审）
DSH                     = STOPPED
Kun                     = PROJECT MANAGER + QA
```

任务书：`docs/tasks/sprint-04/README.md`（单文档，不拆 S4-T1/T2/T3）。

Sprint 4 范围：`/front-desk` 前台运营工作台 —— Today Summary（到店/离店/在住/空净房/需关注，卡片点击进右侧 Drawer）；Room Diary（28 房 × 1/7/14/30 天时间线，楼层分组 + 楼层/房型筛选，左侧房间栏 sticky，双状态占用+清洁不合并，时间线严格 `[check_in, check_out)` 无 off-by-one）；Reservation Drawer（Check-in/Edit/Cancel/No-show/Full Detail，全部复用 Sprint 2 API；脏房到店明确显示「房间尚未准备完成」+ 保洁任务）；点击空白日期格快速新建（复用 `/reservations/new` 预填，Availability 仍重新验证）；统一搜索（房号/Guest name/phone/reservation_no，PII 受 guest:read 约束）；Attention Center 三条固定规则（脏房到店 / 超期在住 / 锁房未来预订）；Room Quick View；Housekeeping 集成（只消费 Alpha.3）；Mobile（<768px FrontDeskTodayBoard，不渲染完整 Room Diary）；Backend 最小扩展 `overlap_from` / `overlap_to`（Reservation List 日期窗口重叠查询，只读）；写操作后 targeted refetch + 60s 轮询。Alpha.4 不做拖拽排房。

Sprint 4 进展：DSH 单会话完成全部实现（Implementation Complete，无 commit）；Kun Fast QA 第一轮 FAILED（Blocking Defect D1：并发双订偶发 DeadlockDetected 逃逸 500），DSH 已修复并按 Fast Review 收窄分类（仅 23P01/40P01/40001 → 409，其它 OperationalError 原样 re-raise）；Kun Fast QA 复审（S4-D1 Re-QA）PASS：pytest 220 / Vitest 240 / Playwright 连续两轮 46 全绿，独立并发压测 100 轮（50 服务层 + 50 真实 HTTP）0 × 500 且每轮 exactly 1 条；`v1.0.0-alpha.3` 冻结不动，`v1.0.0-alpha.4` 已创建为 Sprint 4 Release Commit。

## Sprint 5（COMPLETE）

```text
Sprint 5                = COMPLETE
正式名称                = Maintenance Operations & Room Readiness（维修运营与客房可用性闭环）
Release                 = v1.0.0-alpha.5（RELEASED）
开发模式                = FAST TRACK + REUSE FIRST + ONE SPRINT / ONE DSH SESSION（不拆 T1/T2/T3）
Sprint 5 Coding         = IMPLEMENTATION COMPLETE（单会话一次完成）
Sprint 5 Fast QA        = PASS（Kun 独立重跑 pytest 285 / Vitest 300 / Playwright 60 全绿 + Blocking Defect 修复复审）
DSH                     = STOPPED
Kun                     = PROJECT MANAGER + QA
```

任务书：`docs/tasks/sprint-05/README.md`（单文档）。

Sprint 5 范围：MaintenanceWorkOrder 正式领域（第三独立业务领域：维修状态 ≠ 占用 ≠ 清洁）；Report → Assign → Start → Resolve → Verify/Rework → Complete → Room Ready 闭环；`blocks_room` 与 `severity` 独立（RESOLVED 仍阻断）；Room 新增 `unavailability_source`（MANUAL/MAINTENANCE，历史 blocked/OOS 安全回填 MANUAL + CHECK 约束）；occupied/reserved/blocked/MANUAL-OOS 房不被维修覆盖；Availability / Check-in 排除 Active Blocking MWO、Checkout Maintenance-aware（blocker → OOS+MAINTENANCE+dirty，保洁任务照常）；多张 blocking 工单与 Last Blocking 规则；Maintenance 只能解除自己造成的 OOS；固定锁顺序 Room → MWO + 并发/回滚正式测试；RBAC（maintenance_order:read/write/work/verify/cancel）/ PII（不关联 Guest）/ 审计（8 个 action + 房态证据）；桌面工作台（/maintenance、/maintenance/[id]、/maintenance/new）+ Mobile 现场报修；Housekeeping「发现设施问题 → 报修」与 Front Desk Quick View 最小集成；PRE_OPENING 复用维修域（开业前 28 房整改清单）；不做附件/库存/预防性维护等。

Sprint 5 进展：DSH 单会话完成全部实现（Implementation Complete，无 commit）：pytest 285（220 基线 + 65 新增）/ Vitest 285（240 基线 + 45 新增）/ Playwright 59（46 基线 + maintenance 2 spec 13 条）全绿；lint / typecheck / build PASS；Clean Bootstrap（empty stayops_test → alembic upgrade head → seed → :8001 / :3001 → full Playwright）PASS；Sprint 1–4 回归全部保留。Kun Fast QA 首轮 FAILED（Blocking Product Defect：occupied + blocking MWO + 未来预订 → Front Desk 无主动维修风险提示）；DSH 已修复（Attention 新增 Rule M：预订存在维修风险，与 Room 占用无关，RESOLVED 仍报警，一条预订一条卡片，M 优先抑制重复 Rule C，桌面 + 移动共享）；Kun Fast RE-QA 独立重跑全绿（pytest 285 / Vitest 300（285 基线 + 15 修复增量）/ Playwright 60（59 基线 + 修复场景 1 条），lint / typecheck / build PASS），缺陷修复复审通过；`v1.0.0-alpha.4` 冻结不动，`v1.0.0-alpha.5` 已创建为 Sprint 5 Release Commit。

## Sprint 6（COMPLETE · RELEASED）

```text
Sprint 6                = Room Move & In-Stay Recovery（住中换房与在住异常恢复）
正式名称                = Room Move & In-Stay Recovery
Release                 = v1.0.0-alpha.6（RELEASED）
Release Commit          = 2791c8b14a6965cb01ef7f998775e73d37192967
开发模式                = FAST TRACK + REUSE FIRST + ONE SPRINT / ONE DSH SESSION（不拆 T1/T2/T3）
Sprint 6 Coding         = IMPLEMENTATION COMPLETE（单会话完成，无 commit）
Sprint 6 Fast QA        = PASS（Kun 独立 QA）
DSH                     = STOPPED（完成后停止，不进入 Sprint 7）
Kun                     = PROJECT MANAGER + QA
```

Sprint 6 范围（任务书 §1–§41）：

- **领域模型三分（Domain Decision LOCKED）**：Reservation = 商业预订 / 未来房间分配
  （Check-in 后 `room_id` 冻结为原分配房）；Stay = 实际住宿（`room_id` = 当前实际房间
  快速指针）；StayRoomAssignment = 实际住宿期间的房间历史（`ended_at NULL` = active）。
  换房不得创建第二个 Stay。
- **迁移 `c8e2b7a4d1f3`**：stay_room_assignments（CHECK 区间约束 + 部分唯一索引
  `uq_stay_room_assignments_active_stay` + 排他约束 `ex_stay_room_assignments_no_overlap`）、
  room_move_reason 枚举、hk_task_source + ROOM_MOVE、Reservation 排他约束调整为
  CONFIRMED-only、既有 Stay 历史回填（started_at = actual check-in、ended_at =
  actual check-out / ACTIVE→NULL，确定性）。
- **Check-in 进化**：同事务建立 assignment #1；Checkout 关闭 open assignment。
- **并发模型（§7/§8）**：Room Row Lock + 事务内重校验（Create/Update Reservation、
  Check-in、Room Move）；全局锁顺序 `(Reservation | Stay) → Rooms(pk 升序) → MWO`；
  40P01/40001 → 409，其它 OperationalError 原样传播。
- **Room Move API**：`GET /stays/{id}/room-move-options` + `POST /stays/{id}/room-move`
  （stay:room_move）；7 固定换房原因；目标房资格后端权威（available+clean+无阻断维修+
  无其它 ACTIVE Stay+剩余区间 [move_date, planned_check_out) 无 CONFIRMED 预订）；
  旧房释放复用 S5 maintenance-aware 语义 + ROOM_MOVE 保洁任务（已有 active task → 409
  回滚）；目标房 occupied + cleaning 不变；维修独立性（换房不触碰原房 MWO）。
- **前端**：Front Desk 当前在住抽屉 + 移动 Today Board [换房] 入口（stay:room_move
  显隐，后端 403 兜底）；RoomMoveDialog（后端权威候选 + 显式确认换房，Desktop/mobile）；
  Room Diary 语义升级（CONFIRMED 预订条 + ACTIVE Stay 在住条 = 当前实际占用，
  CHECKED_IN 不再画成当前房间）；Stay 详情房间记录 + 原分配房 vs 当前在住房。
- **测试口径**：pytest 317（285 基线 + 32 新增，含迁移往返/回填 + 4×10 轮并发 stress）；
  Vitest 324（300 基线 + 24 新增，含既有语义更新）；Playwright 60 + room-move 4 条
  （Golden Path / blocking MWO / move-vs-move / move-vs-reservation HTTP 并发）；
  lint / typecheck / build PASS。

Sprint 6 进展：DSH 单会话完成全部实现（Implementation Complete，无 commit）：
pytest 317 / Vitest 324 / Playwright room-move spec 4 条全绿；lint / typecheck / build PASS；
开发库 stayops `alembic upgrade head`（c8e2b7a4d1f3）+ seed 幂等收敛（37 权限码）；
Sprint 1–5 回归全部保留（pytest 285 基线 / Vitest 300 基线 / Playwright 60 基线）。
Kun Fast QA PASS；`v1.0.0-alpha.5` 冻结不动，`v1.0.0-alpha.6` 已创建为
Sprint 6 Release Commit（2791c8b）。

## Sprint 7（IMPLEMENTATION COMPLETE · 等待 Kun Fast QA）

```text
Sprint 7                = Inventory & Procurement（库存与采购）
Release                 = v1.0.0-alpha.7（计划，待 Kun QA PASS 后发布）
开发模式                = FAST TRACK + REUSE FIRST + ONE SPRINT / ONE DSH SESSION（不拆 T1/T2/T3）
Sprint 7 Coding         = IMPLEMENTATION COMPLETE（无 commit）
Sprint 7 Fast QA        = 待 Kun 独立 QA
DSH                     = STOPPED（完成后停止，不进入 Sprint 8）
Kun                     = PROJECT MANAGER + QA
```

Sprint 7 范围（任务书 §1–§61）：

- **LOCKED 架构（§2）**：StockMovement = 永久库存账本事实（immutable ledger，
  无 PATCH/DELETE）；InventoryBalance = Projection（唯一 (item_id, location_id)）；
  no movement = no stock change（流水+余额同事务）；无直接 balance PATCH；
  无负库存（FOR UPDATE + recheck + DB CHECK）；多库存地点（4 个种子地点）；
  无自动客耗扣账（Checkout / Housekeeping / Room Move 不扣库存）。
- **库存域**：InventoryItem（item_code 唯一不可变、base_unit 唯一基础单位、
  minimum/target CHECK target>=minimum、is_active 停用）/ InventoryLocation /
  InventoryBalance / StockMovement（signed quantity + 类型符号 CHECK）/
  StockIssue+Lines（多行整体原子、ROOM 目的地 room_id 一致性）；
  期初库存（INITIAL 专用动作）/ 领用 / 归还 / 调拨（OUT↔IN 成对互指，总库存不变）/
  盘点（差异→ADJUSTMENT_IN/OUT，平账 no-op）；低库存（total==0 → OUT_OF_STOCK，
  total<=minimum → LOW_STOCK，minimum=0 边界语义）/ 建议补货（仅建议不自动下单）。
- **采购域**：Supplier（停用不删除，审计不复制 phone/notes 自由文本）/
  PurchaseRequest（DRAFT→SUBMITTED→APPROVED→ORDERED、SUBMITTED→REJECTED、
  DRAFT/APPROVED→CANCELLED，审批与申请分离）/ PurchaseOrder
  （DRAFT→ORDERED→PARTIALLY_RECEIVED→RECEIVED，部分收货后取消=不再收剩余，
  已收货保持）/ GoodsReceipt（收货才是 stock-in 权威；超收整体回滚 409）；
  Request→PO exactly-once（同事务 APPROVED→ORDERED + DB UNIQUE）；
  **PO 不改变库存**；金额 Decimal（不做付款/应付/发票/税务）。
- **并发（Lock Graph）**：Inventory 事务只锁 Balance 行（(item_id, location_id) 升序，
  INSERT ON CONFLICT + FOR UPDATE）；收货 = PO → PO lines → Balance 行；
  全局无环；40P01/40001 → 409，其它 OperationalError 原样传播；
  P0 stress：issue-vs-issue / transfer-vs-issue / stocktake-vs-issue /
  receipt-vs-receipt / receipt-vs-issue / receipt-vs-transfer /
  request-to-po-vs-request-to-po 各 10 轮真实 PostgreSQL，
  unexpected 500 = 0、deadlocks = 0。
- **RBAC / 审计**：11 个新权限码（48 总）；矩阵 §36（inventory:adjust/transfer/
  item_manage 与 procurement:approve/order/supplier_manage 仅 SUPER_ADMIN/MANAGER；
  receive 按建议授予 FRONT_DESK）；19 个审计 action，记录 ID/code/quantities/
  state transition。
- **前端**：/inventory 工作台 + /inventory/items/[id] 详情 + 领用/调拨/盘点/
  新建物资/期初库存/编辑表单（Mobile 可用）；/procurement 工作台 + suppliers +
  requests(/[id]) + orders(/[id])（部分收货表单、按剩余一键收货）；
  Dashboard「库存与采购预警」按权限门控；导航 库存=inventory:read、
  采购=procurement:read（后端 403 兜底）；前端不复制状态机，409 原文展示。
- **迁移 `e3a91f5c8d24`**：13 张新表、5 个 PG 枚举、5 个 Sequence、
  UNIQUE(item,location) / movement 符号 CHECK / received<=ordered CHECK /
  PR→PO UNIQUE；downgrade 往返仅 scratch 库验证（正常开发库不降级）。
- **测试口径**：pytest 379（317 基线 + 62 新增，含 P0 并发 7×10 轮 stress +
  汇总报告、Ledger==Balance 对账、迁移往返、seed 幂等；既有 6 个权限码计数用例
  语义更新为 48）；Vitest 379（324 基线 + 55 新增）；Playwright 64 +
  inventory-procurement 4 条（Golden A 建物资→期初→领用→流水、Golden B 调拨
  总库存不变、Golden C 申请→提交→批准→订单→下达→部分/最终收货、
  Golden D 低库存→工作台/Dashboard 预警）；lint / typecheck / build PASS。

Sprint 7 进展：DSH 完成全部实现（Implementation Complete，无 commit）：
pytest 379 / Vitest 379 / Playwright inventory-procurement 4 条全绿；
lint / typecheck / build PASS；开发库 stayops `alembic upgrade head`
（e3a91f5c8d24）+ seed 幂等收敛（48 权限码 + 4 库存地点）；
Sprint 1–6 回归全部保留（pytest 317 基线 / Vitest 324 基线 / Playwright 64 基线）。
`v1.0.0-alpha.6`（2791c8b）冻结不动；待 Kun Fast QA PASS 后创建
`v1.0.0-alpha.7` Release Commit。
